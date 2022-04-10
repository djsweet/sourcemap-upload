/* Copyright 2020 Record Replay Inc. */

// "URL" is available as a global, but Typescript doesn't have the types
// for it. Importing it from the module does have types though.
import { pathToFileURL, URL } from "url";

import assert from "assert";
import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import https from "https";
import path from "path";
import util from "util";

import fetch, { Response } from "node-fetch";
import makeDebug from "debug";
import glob from "glob";
import matchAll from "string.prototype.matchall";

const globPromisified = util.promisify(glob);
const dnsLookup = util.promisify(dns.lookup);

const debug = makeDebug("recordreplay:sourcemap-upload");
const uploadDNS = `api.replay.io`;
const uploadEndpoint = "/v1/sourcemap-upload";

export type MessageLevel = "normal" | "verbose";
export type LogCallback = (level: MessageLevel, message: string) => void;
export interface UploadOptions {
  filepaths: Array<string> | string;
  group: string;
  key?: string;
  dryRun?: boolean;
  extensions?: Array<string>;
  ignore?: Array<string>;
  root?: string;
  log?: LogCallback;
}

export async function uploadSourceMaps(opts: UploadOptions): Promise<void> {
  assert(
    Array.isArray(opts.filepaths)
      ? opts.filepaths.every((p) => typeof p === "string")
      : typeof opts.filepaths === "string",
    "'filepaths' must be a string or array of strings"
  );
  assert(typeof opts.group === "string", "'group' must be a string");
  assert(
    typeof opts.key === "string" || opts.key === undefined,
    "'key' must be a string or undefined"
  );
  assert(
    typeof opts.dryRun === "boolean" || opts.dryRun === undefined,
    "'dryRun' must be a string or undefined"
  );
  assert(
    (Array.isArray(opts.extensions) &&
      opts.extensions.every((ext) => typeof ext === "string")) ||
      opts.extensions === undefined,
    "'extensions' must be an array of strings or undefined"
  );
  assert(
    !opts.extensions || opts.extensions.length > 0,
    "'extensions' must not be empty"
  );
  assert(
    opts.extensions?.every((ext) => !glob.hasMagic(ext)) ?? true,
    "'extensions' entries may not contain special glob chars"
  );
  assert(
    opts.extensions?.every((ext) => ext.startsWith(".")) ?? true,
    "'extensions' entries must start with '.'"
  );
  assert(
    (Array.isArray(opts.ignore) &&
      opts.ignore.every((pattern) => typeof pattern === "string")) ||
      opts.ignore === undefined,
    "'ignore' must be an array of strings or undefined"
  );
  assert(
    typeof opts.root === "string" || opts.root === undefined,
    "'root' must be a string or undefined"
  );

  const apiKey = opts.key || process.env.RECORD_REPLAY_API_KEY || null;
  assert(
    apiKey,
    "'key' must contain a key, or the RECORD_REPLAY_API_KEY must be set."
  );

  assert(
    typeof opts.log === "function" || opts.log === undefined,
    "'log' must be a function or undefined"
  );

  const cwd = process.cwd();
  return processSourceMaps({
    cwd,
    filepaths: Array.isArray(opts.filepaths)
      ? opts.filepaths
      : [opts.filepaths],
    groupName: opts.group,
    apiKey,
    dryRun: !!opts.dryRun,
    extensions: opts.extensions || [".js", ".map"],
    ignorePatterns: opts.ignore || [],
    rootPath: path.resolve(cwd, opts.root || ""),
    log: opts.log || (() => undefined),
  });
}

interface NormalizedOptions {
  cwd: string;
  filepaths: Array<string>;
  groupName: string;
  apiKey: string;
  dryRun: boolean;
  extensions: Array<string>;
  ignorePatterns: Array<string>;
  rootPath: string;
  log: LogCallback;
}

interface GeneratedFileEntry {
  fileURL: string;
  absPath: string;
  sha: string;
  mapURL: string | undefined;
}
interface SourceMapEntry {
  fileURL: string;
  absPath: string;
  fileContent: string;
  generatedFile: string | undefined;
  generatedFiles: Set<GeneratedFileEntry>;
}
interface SourceMapToUpload {
  absPath: string;
  relativePath: string;
  content: string;
  generatedFileHash: string;
}

async function processSourceMaps(opts: NormalizedOptions) {
  debug("resolved options: %O", {
    ...opts,
    // In the interest of not logging the API key in debug output, just log its size.
    apiKey: opts.apiKey?.length,
  });

  const sourceMaps = await findAndResolveMaps(opts);

  const { groupName, apiKey, dryRun, rootPath, log } = opts;

  const mapsToUpload = [];
  for (const map of sourceMaps) {
    const relativePath = path.relative(rootPath, map.absPath);

    if (map.generatedFiles.size === 1) {
      const [generatedFile] = map.generatedFiles;
      mapsToUpload.push({
        absPath: map.absPath,
        relativePath,
        content: map.fileContent,
        generatedFileHash: generatedFile.sha,
      });

      debug(
        "Resolved generated source %s for %s",
        generatedFile.absPath,
        map.absPath
      );
      log("verbose", `Linked ${relativePath} to ${generatedFile.absPath}`);
    } else if (map.generatedFiles.size === 0) {
      debug("Failed to resolve generated source for %s", map.absPath);
      log(
        "verbose",
        `Skipped ${relativePath} because no generated files for it could be found`
      );
    } else {
      debug(
        "Failed to resolve generated source for %s, matched multiple sources: %O",
        map.absPath,
        Array.from(map.generatedFiles, (genFile) => genFile.absPath)
      );
      log(
        "verbose",
        `Skipped ${relativePath} because multiple generated files were found for it`
      );
    }
  }

  for (const mapToUpload of mapsToUpload) {
    const { relativePath, absPath } = mapToUpload;
    debug("Uploading %s", absPath);
    log("normal", `Uploading ${relativePath}`);

    if (!dryRun) {
      await uploadSourcemapToAPI(groupName, apiKey, mapToUpload);
    }
  }

  debug("Done");
  log(
    "normal",
    `Done! Uploaded ${mapsToUpload.length} sourcemaps${
      dryRun ? " (DRY RUN)" : ""
    }`
  );
}

type PutOptions = {
  groupName: string;
  apiKey: string;
  map: SourceMapToUpload;
};

async function sendUploadPUT(
  opts: PutOptions,
  ipAddress: string
): Promise<Response> {
  // This is necessary to make TLS SNI work with explicit IP addresses.
  const agent = new https.Agent({ servername: uploadDNS });
  debug("Attempting upload with IP", ipAddress);
  return await fetch(`https://${ipAddress}${uploadEndpoint}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Replay-SourceMap-Group": opts.groupName,
      "X-Replay-SourceMap-Filename": opts.map.relativePath,
      "X-Replay-SourceMap-ContentHash": `sha256:${opts.map.generatedFileHash}`,
      Host: uploadDNS,
    },
    body: opts.map.content,
    agent,
  });
}

function shuffleArray<T>(data: T[]): void {
  // There's no need to shuffle the last element of an array.
  for (let i = 0; i < data.length - 1; i++) {
    const remaining = data.length - i;
    const offset = i + Math.floor(Math.random() * remaining);

    const val = data[offset];
    data[offset] = data[i];
    data[i] = val;
  }
}

const baseRetryWindowMS = 100;
function retrySleepTime(attempt: number): number {
  // This is according to an Exponential distribution.
  // The Exponential is the inverse Z transform of the Poisson,
  // and the sum of Poisson distributions is itself a Poisson
  // distribution. As a result, the expected load from any
  // given iteration will be Poisson-distributed.
  const jitter = -Math.log(1 - Math.random());

  // Quadratic backoff is fair and stable. Exponential backoff,
  // linear backoff, and constant backoff are not. See:
  //
  // "Analysis of Backoff Protocols for Multiple Access Channels";
  //   Johan Håstad, Tom Leighton, and Brian Rogoff;
  //   https://www.csc.kth.se/~johanh/ethernetanalysis.pdf
  //
  // "Backoff Design for IEEE 802.11 DCF Networks: Fundamental Tradeoff
  //  and Design Criterion";
  //   Xinghua Sun and Lin Dai;
  //   https://www.ee.cityu.edu.hk/~lindai/poly.pdf
  return jitter * baseRetryWindowMS * (attempt + 1) ** 2;
}

async function uploadSourcemapToAPIAsRetry(
  groupName: string,
  apiKey: string,
  map: SourceMapToUpload,
  ipAddress: string
) {
  let response;
  try {
    response = await sendUploadPUT({ groupName, apiKey, map }, ipAddress);
  } catch (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    err: any
  ) {
    debug("Failure uploading sourcemap %s, got %O", map.absPath, err);
    throw new Error(`Unexpected error uploading sourcemap: ${err}`);
  }

  let obj;
  try {
    const text = await response.text();

    try {
      obj = JSON.parse(text);
    } catch (err) {
      debug(
        "Failure parsing sourcemap upload response JSON for %s, got body %s",
        map.absPath,
        text.slice(0, 200) + (text.length > 200 ? "..." : "")
      );
      throw err;
    }

    if (!obj || typeof obj !== "object") {
      throw new Error("JSON response was not an object");
    }
  } catch (err) {
    debug(
      "Failure processing sourcemap upload response for %s, got %O",
      map.absPath,
      err
    );
    throw new Error("Unexpected error processing upload response");
  }

  if (response.status !== 200) {
    debug("Failure uploading sourcemap for %s, got %O", map.absPath, obj);
    throw new Error(
      typeof obj.error === "string" ? obj.error : "Unknown upload error"
    );
  }
}

async function uploadSourcemapToAPI(
  groupName: string,
  apiKey: string,
  map: SourceMapToUpload
) {
  for (let i = 0; i < 5; i++) {
    const addrFamilies = await dnsLookup(uploadDNS, { all: true });
    shuffleArray(addrFamilies);
    for (const { address } of addrFamilies) {
      try {
        return await uploadSourcemapToAPIAsRetry(
          groupName,
          apiKey,
          map,
          address
        );
      } catch (err) {
        debug(
          "Sourcemap upload attempt %d failed for %s, got %O",
          i,
          map.absPath,
          err
        );
        await new Promise<void>((resolve) =>
          setTimeout(resolve, retrySleepTime(i))
        );
      }
    }
  }

  {
    const addrFamily = await dnsLookup(uploadDNS);
    return await uploadSourcemapToAPIAsRetry(
      groupName,
      apiKey,
      map,
      addrFamily.address
    );
  }
}

async function findAndResolveMaps(
  opts: NormalizedOptions
): Promise<Array<SourceMapEntry>> {
  const { cwd, filepaths, extensions, ignorePatterns } = opts;

  const seenFiles = new Set();
  const generatedFiles = new Map<string, GeneratedFileEntry>();
  const sourceMaps = new Map<string, SourceMapEntry>();

  for (const fileArg of filepaths) {
    const absFileArg = path.resolve(cwd, fileArg);
    debug("processing argument: %s", absFileArg);

    for (const absPath of await listAllFiles(
      absFileArg,
      ignorePatterns,
      extensions
    )) {
      if (seenFiles.has(absPath)) {
        continue;
      }
      seenFiles.add(absPath);

      debug("processing filepath: %s", absPath);

      const fileContent = await fs.promises.readFile(absPath, "utf8");
      let map;
      try {
        map = JSON.parse(fileContent);
      } catch {
        // No-op
      }

      debug("read filepath: %s", absPath);

      const fileURL = pathToFileURL(absPath).toString();
      if (map !== undefined) {
        if (!map || typeof map !== "object") {
          debug("JSON is not an object, skipping %s", absPath);
          continue;
        }
        if (map.version !== 3 || typeof map.mappings !== "string") {
          debug("JSON is not a sourcemap, skipping %s", absPath);
          continue;
        }
        if (map.file != null && typeof map.file !== "string") {
          debug("Sourcemap has an invalid 'file' key, skipping %s", absPath);
          continue;
        }

        let generatedFile;
        try {
          generatedFile = map.file ? new URL(map.file, fileURL) : undefined;
        } catch {
          debug("Failed to resolve 'file', ignoring value in %s", absPath);
        }

        sourceMaps.set(fileURL, {
          fileURL,
          absPath,
          fileContent,
          generatedFile: generatedFile?.toString(),
          generatedFiles: new Set(),
        });
      } else {
        debug("hashing filepath: %s", absPath);
        const hasher = crypto.createHash("SHA256");
        hasher.update(fileContent);
        const sha = hasher.digest("hex");

        // Files could have strings or comments that happen to container the sourcemap
        // comment text and such, so we need to explictly grab the value in the
        //trailing comments.
        const match = fileContent.match(
          /(?:\/\*(?:[^*]|\*[^/])*\*\/|\/\/.*?(?:\r?\n|$)|\r?\n)*$/
        );
        assert(match);
        const [trailingComments] = match;

        const matches = matchAll(
          trailingComments,
          /\/\*(?:[@#] *sourceMappingURL=(.*)\s*|[\s\S]*?)\*\/|\/\/(?:[@#] *sourceMappingURL=(.*)|.*?)(?:\r?\n|$)|\r?\n/g
        );

        debug("hashed filepath: %s", absPath);

        const url = Array.from(matches, (match) =>
          (match[1] || match[2])?.trim()
        )
          .filter((url) => typeof url === "string")
          .pop();

        let mapURL;
        try {
          mapURL = url ? new URL(url, fileURL) : undefined;
        } catch {
          debug(
            "Failed to resolve sourceMappingURL, ignoring value in %s",
            absPath
          );
        }

        if (mapURL && mapURL.protocol !== "file:") {
          debug(
            "Generated file had non-file: sourceMappingURL, ignoring value in %s",
            absPath
          );
          mapURL = undefined;
        }

        generatedFiles.set(fileURL, {
          fileURL,
          absPath,
          sha,
          mapURL: mapURL?.toString(),
        });
      }
    }
  }

  debug("done processing arguments");

  // Follow 'sourceMappingURL' references to find sourcemap for generated files.
  for (const generatedFile of generatedFiles.values()) {
    if (generatedFile.mapURL) {
      sourceMaps.get(generatedFile.mapURL)?.generatedFiles.add(generatedFile);
    }
  }
  // Follow 'file' references to find generated sources for sourcemap.
  for (const map of sourceMaps.values()) {
    if (map.generatedFile) {
      const generatedFile = generatedFiles.get(map.generatedFile);
      if (generatedFile) {
        map.generatedFiles.add(generatedFile);
      }
    }
  }

  return Array.from(sourceMaps.values());
}

async function listAllFiles(
  absPath: string,
  ignorePatterns: Array<string>,
  extensions: Array<string>
): Promise<Array<string>> {
  const stat = await fs.promises.stat(absPath);
  if (stat.isFile()) {
    return [absPath];
  } else if (stat.isDirectory()) {
    assert(extensions.every((ext) => !glob.hasMagic(ext)));

    return globPromisified(`**/*+(${extensions.join("|")})`, {
      cwd: absPath,
      ignore: ignorePatterns,
      absolute: true,
    });
  }
  return [];
}
