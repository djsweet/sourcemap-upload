# @recordreplay/sourcemap-upload

Provides an NPM library allows uploading sourcemaps to Replay's servers so
that they can be used when viewing recordings.

This module exports a named `uploadSourceMaps` function with the following options:

```typescript
interface Options {
  /**
   * The files/directories to search for sourcemaps. All files that match the
   * 'extensions' list and fail to match 'ignore' will be searched for
   * sourcemap JSON or `//#sourceMappingURL=` coments in order to find pairs
   * of generated-file + sourcemap, and the sourcemap will be uploaded.
   */
  filepaths: Array<string> | string;

  /**
   * To allow for tracking and browsing of maps that have been uploaded, we
   * require uploaded sourcemaps to have an overall group name associated with
   * them. This could for instance be a version number, or commit hash.
   */
  group: string;

  /**
   * The API key to use when connecting to Replay's servers.
   * Defaults to `process.env.RECORD_REPLAY_API_KEY`.
   */
  key?: string;

  /**
   * Run all of the local processing and searching for maps, but skip uploading them.
   */
  dryRun?: boolean;

  /**
   * The set of file extensions to search for sourcemap-related data.
   * Defaults to [".js", ".map"].
   */
  extensions?: Array<string>;

  /**
   * The set of pattern for files to ignore when searching for sourcemap-related data.
   */
  ignore?: Array<string>;

  /**
   * Set the directory that relative paths should be computed with respect to.
   * The relative path of sourcemaps is included in the uploaded entry, and will be
   * visible in the UI, so this can be used to strip off unimportant directories in
   * the build path. Defaults to `process.cwd()`.
   */
  root?: string;
}
```