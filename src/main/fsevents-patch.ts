/**
 * fsevents-patch.ts — FIRST import in the Electron main entry.
 *
 * Forces `require('fsevents')` to throw MODULE_NOT_FOUND so chokidar (and any
 * other consumer) silently falls back to Node's built-in fs.watch. This removes
 * the fsevents.node native addon entirely from the Electron main process,
 * which fixes the SIGABRT-on-quit crash:
 *
 *   Thread 0 (CrBrowserMain):
 *     0  libsystem_kernel  __pthread_kill
 *     1  libsystem_pthread pthread_kill
 *     2  libsystem_c       abort                                ← SIGABRT
 *     3  Electron Framework uv_mutex_lock                       ← already-destroyed mutex
 *     4  napi_release_threadsafe_function
 *     5  fsevents.node     fse_instance_destroy
 *     6+ node::Stop / napi cleanup / uv_run / node::FreeEnvironment
 *
 * Mechanism:
 *   chokidar 3.6's `lib/fsevents-handler.js` line 1-7 wraps `require('fsevents')`
 *   in try/catch. We patch Module._resolveFilename so the require throws
 *   MODULE_NOT_FOUND — chokidar's catch swallows the error and `fsevents`
 *   stays undefined. Its `canUse()` then returns false, and chokidar picks
 *   `NodeFsHandler` (fs.watch) instead of `FsEventsHandler` (fsevents.node).
 *
 * Why v1.4.4's `process.exit(0)` did NOT fix this:
 *   The crashed stack shows ElectronMain → node::FreeEnvironment → fsevents
 *   teardown. `process.exit(0)` itself also routes through FreeEnvironment;
 *   it runs napi cleanup hooks, which is exactly when fsevents.node's
 *   destructor hits the destroyed uv_mutex. The only way to dodge the race
 *   is to never load fsevents.node in the first place.
 *
 * Performance note: macOS `fs.watch` is itself FSEvents-backed at the libuv
 * layer, so recursive watching of file-tree / worktree / branch HEAD is
 * effectively identical in throughput. The three watchers in this codebase
 * (`src/main/ipc/file-tree-handlers.ts`, `src/main/services/branch-watcher.ts`,
 * `src/main/services/worktree-watcher.ts`) all use chokidar with ignored
 * patterns, so the watched file count is bounded.
 *
 * Only patches darwin — on Linux/Windows fsevents is not installed and
 * `require('fsevents')` already fails naturally.
 *
 * Refs:
 *   - https://github.com/paulmillr/chokidar/issues/1000
 *   - https://github.com/fsevents/fsevents/issues/273
 *   - https://github.com/microsoft/vscode/issues/100091 (same crash signature)
 */

import Module from 'node:module'

if (process.platform === 'darwin') {
  // The _resolveFilename hook is Node's classic monkey-patch surface, used by
  // tools like ts-node, jest, and require-in-the-middle. Stable across Node 18-22.
  const moduleProto = Module as unknown as {
    _resolveFilename: (request: string, ...args: unknown[]) => string
  }
  const originalResolve = moduleProto._resolveFilename
  moduleProto._resolveFilename = function (request: string, ...args: unknown[]) {
    if (request === 'fsevents') {
      const err = new Error(
        "Cannot find module 'fsevents' (intentionally stubbed by xuanpu/fsevents-patch — see src/main/fsevents-patch.ts)"
      ) as NodeJS.ErrnoException
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    return originalResolve.call(this, request, ...args)
  }
}
