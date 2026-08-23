/**
 * `createFileSystem`: the implementation behind `tecode.workspace.fs` (Req
 * 10.1, 10.2; design.md §12). Wraps `node:fs/promises` for
 * read/write/stat/readdir and `node:fs`'s `watch` for change notification —
 * a thin pass-through, not a virtual filesystem, but kept behind this one
 * seam so a future virtual/sandboxed filesystem only has to replace this
 * module (design.md §12's "wraps `node:fs/promises` + `fs.watch` behind the
 * API so future virtual filesystems stay possible").
 *
 * **No sandboxing** (Req 10.2, explicitly out of scope for the MVP):
 * extensions get the same filesystem access as the host process. What this
 * module *does* guarantee, matching every other core service, is that it
 * never crashes the process — a synchronous `fs.watch` failure (e.g. the
 * path does not exist yet) or an asynchronous watcher error is reported
 * (when a {@link HostLog} is injected) and swallowed rather than thrown or
 * left as an unhandled `"error"` event (mirrors `config/service.ts`'s
 * `createNodeConfigFs`).
 */

import * as nodeFs from "node:fs/promises";
import { watch as nodeFsWatch, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type {
  DirEntry,
  Disposable,
  FileChangeEvent,
  FileChangeType,
  FileStat,
  FileSystem,
  FileType,
  Listener,
  Uri,
} from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import { pathToUri, uriToPath } from "./uri";

/** Dependencies for {@link createFileSystem}. Every field is optional —
 * `createFileSystem()` with no arguments is a complete, working
 * filesystem; `log` only adds visibility into watch failures that would
 * otherwise be silently swallowed. */
export interface FileSystemDeps {
  /** Structured log for watch-setup and asynchronous watcher failures
   * (design.md §14). Omitted (the default) swallows these silently —
   * `FileSystem.watch` still never throws or crashes either way. */
  log?: HostLog;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `documentManager.ts`'s/`registry.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Map a `node:fs` `Dirent`/`Stats`-shaped pair of directory/file/symlink
 * checks onto {@link FileType}. */
function classify(entry: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}): FileType {
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isFile()) return "file";
  return "unknown";
}

/**
 * Build a `FileSystem` (Req 10.1's `workspace.fs`, Req 10.2). `deps.log` is
 * optional — see {@link FileSystemDeps}.
 */
export function createFileSystem(deps: FileSystemDeps = {}): FileSystem {
  function logSafely(err: HostError): void {
    if (!deps.log) return;
    try {
      deps.log.append("warning", err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  async function read(uri: Uri): Promise<Uint8Array> {
    return nodeFs.readFile(uriToPath(uri));
  }

  async function write(uri: Uri, content: Uint8Array): Promise<void> {
    await nodeFs.writeFile(uriToPath(uri), content);
  }

  /**
   * `stat` reports on the target a symlink points at (size/mtime/ctime of
   * the resolved file) while still reporting `type: "symlink"` for it — the
   * one case that needs both an `lstat` (to detect the symlink without
   * following it) and a `stat` (to describe what it resolves to). A broken
   * symlink (the `stat` follow-through fails) falls back to the link's own
   * metadata rather than rejecting outright.
   */
  async function stat(uri: Uri): Promise<FileStat> {
    const path = uriToPath(uri);
    const linkStat = await nodeFs.lstat(path);
    if (linkStat.isSymbolicLink()) {
      try {
        const target = await nodeFs.stat(path);
        return {
          type: "symlink",
          size: target.size,
          mtime: target.mtimeMs,
          ctime: target.ctimeMs,
        };
      } catch {
        return {
          type: "symlink",
          size: linkStat.size,
          mtime: linkStat.mtimeMs,
          ctime: linkStat.ctimeMs,
        };
      }
    }
    return {
      type: classify(linkStat),
      size: linkStat.size,
      mtime: linkStat.mtimeMs,
      ctime: linkStat.ctimeMs,
    };
  }

  /**
   * `Req 10.1's delete/rename/mkdir` (Task 3.3, Req 11.2): thin
   * `node:fs/promises` pass-throughs, matching `read`/`write`/`stat`'s own
   * "reject on failure, preserve the original error" contract — no
   * try/catch here, exactly like every other method above; a caller that
   * needs a never-throwing surface (the explorer built-in) wraps these
   * itself and reports via `window.showMessage(..., "error")` (design.md
   * §14).
   */
  async function deleteEntry(uri: Uri): Promise<void> {
    // `recursive: true` lets this delete a non-empty directory too (Req
    // 11.2's "delete" — the explorer does not require an empty-directory
    // precondition); `force: false` (the default) so a missing path still
    // rejects rather than silently no-op'ing.
    await nodeFs.rm(uriToPath(uri), { recursive: true });
  }

  async function rename(oldUri: Uri, newUri: Uri): Promise<void> {
    await nodeFs.rename(uriToPath(oldUri), uriToPath(newUri));
  }

  async function mkdir(uri: Uri): Promise<void> {
    // No `recursive: true`: Req 11.2's "New Folder" always creates one
    // folder inside an already-visible (and therefore already-existing)
    // directory — surfacing a missing-parent failure here, rather than
    // silently creating intermediate directories, matches `write`'s own
    // choice to let a missing-parent `ENOENT` propagate rather than paper
    // over it.
    await nodeFs.mkdir(uriToPath(uri));
  }

  async function readdir(uri: Uri): Promise<DirEntry[]> {
    const path = uriToPath(uri);
    const entries = await nodeFs.readdir(path, { withFileTypes: true });
    return entries.map((entry: Dirent) => ({
      name: entry.name,
      type: classify(entry),
    }));
  }

  /**
   * `node:fs.watch`'s `(eventType, filename)` callback reports `filename`
   * relative to the watched directory when watching a directory, but the
   * watched file's own basename (or nothing, on some platforms) when
   * watching a single file — determined once, synchronously, at watch
   * setup via `statSync` (a failure here, e.g. the path does not exist yet,
   * falls back to treating it as a single-file watch: an MVP limitation
   * matching `config/service.ts`'s "watch attempted once at startup" note).
   *
   * `node:fs.watch`'s `"rename"` event is an umbrella for create, delete,
   * and rename — there is no portable way to tell which without checking
   * the filesystem, so a `"rename"` event triggers a best-effort
   * existence check: the path still existing reports `"created"`,
   * otherwise `"deleted"`. A rapid create-then-delete can race this check
   * and land on `"deleted"`; acceptable for the MVP (no consumer needs
   * exact create/delete disambiguation under that race yet).
   */
  function watch(uri: Uri, listener: Listener<FileChangeEvent>): Disposable {
    const path = uriToPath(uri);

    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      // Path does not exist (yet) or is inaccessible — see TSDoc above.
    }

    let disposed = false;

    function notify(event: FileChangeEvent): void {
      if (disposed) return;
      try {
        listener(event);
      } catch (cause) {
        logSafely({
          message: `FileSystem watch listener for "${uri}" threw: ${describeError(cause)}`,
          path: uri,
        });
      }
    }

    function resolveAffected(filename: string | Buffer | null): { path: string; uri: Uri } {
      const name = typeof filename === "string" ? filename : undefined;
      const affectedPath = isDirectory && name ? join(path, name) : path;
      return { path: affectedPath, uri: pathToUri(affectedPath) };
    }

    function handleEvent(eventType: string, filename: string | Buffer | null): void {
      if (disposed) return;
      const affected = resolveAffected(filename);

      if (eventType === "change") {
        notify({ type: "changed", uri: affected.uri });
        return;
      }

      // "rename" — resolve created vs. deleted (see TSDoc above).
      void nodeFs.stat(affected.path).then(
        () => notify({ type: "created" as FileChangeType, uri: affected.uri }),
        () => notify({ type: "deleted" as FileChangeType, uri: affected.uri }),
      );
    }

    let watcher: ReturnType<typeof nodeFsWatch>;
    try {
      watcher = nodeFsWatch(path, (eventType, filename) => handleEvent(eventType, filename));
    } catch (cause) {
      logSafely({
        message: `Could not watch "${uri}" for changes: ${describeError(cause)}`,
        path: uri,
      });
      return { dispose() {} };
    }

    // An FSWatcher is an EventEmitter: an "error" event with no listener is
    // rethrown as an uncaught exception and kills the whole process.
    // Absorb it, close the now-dead watcher, and report rather than crash
    // (matches config/service.ts's createNodeConfigFs).
    watcher.on("error", (cause) => {
      try {
        watcher.close();
      } catch {
        // Already closed/broken — nothing more to release.
      }
      logSafely({
        message:
          `Watcher for "${uri}" failed: ${describeError(cause)}. Live updates for this ` +
          `path stop until a new watch() call.`,
        path: uri,
      });
    });

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          watcher.close();
        } catch {
          // Best-effort — see documentManager.ts's/service.ts's dispose().
        }
      },
    };
  }

  return { read, write, stat, readdir, watch, delete: deleteEntry, rename, mkdir };
}
