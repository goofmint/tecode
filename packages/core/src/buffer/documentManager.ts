/**
 * `DocumentManager`: open/close/save lifecycle over `CoreDocument` (Req
 * 5.5, design.md §7.2). Owns the `Map<Uri, CoreDocument>` backing
 * `tecode.workspace.openDocument`/`documents`, resolves each document's
 * `languageId` on open (a stub ahead of the real language registry, Task
 * 2.8), fires `onLanguage:*` activation, and saves atomically (write a
 * temp file in the same directory, then rename over the target — never
 * leaves a half-written file on disk).
 *
 * Built with {@link createDocumentManager} rather than a class, per house
 * convention (matches `createCommandRegistry`, `createContextService`).
 */

import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Event, Listener, Uri } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import type { Clock } from "./clock";
import { createDocument, type CoreDocument } from "./document";
import { uriToPath } from "./uri";

/** Files at or above this size (bytes) open read-only rather than being
 * loaded for editing (Req 5.5). 10 MB, binary. */
export const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024;

/**
 * The narrow slice of `node:fs/promises` {@link createDocumentManager}
 * needs. Exists as an injectable seam (defaulting to the real module) so
 * tests can simulate failures — e.g. a `rename` that fails after `write`
 * succeeds — without touching the real filesystem's error paths (there is
 * no portable, fast way to force `rename` to fail otherwise). Not part of
 * the public API surface; a documented, deliberately minimal escape hatch.
 */
export interface DocumentManagerFs {
  stat(path: string): Promise<{ size: number; mode: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The real {@link DocumentManagerFs}, backed by `node:fs/promises`. */
function createNodeFs(): DocumentManagerFs {
  return {
    stat: (path) => nodeFs.stat(path),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    writeFile: (path, data, encoding) => nodeFs.writeFile(path, data, encoding),
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
    unlink: (path) => nodeFs.unlink(path),
  };
}

/** Dependencies for {@link createDocumentManager}. */
export interface DocumentManagerDeps {
  /** Structured log for open/save failures (design.md §14). */
  log: HostLog;
  /** Where user-facing open/save errors are surfaced (Req 5.5,
   * design.md §14). */
  sink: StatusSink;
  /** Resolve a `Uri` to a language ID (Req 8.3). Defaults to a stub that
   * always returns `"plaintext"` — the real language registry lands in
   * Task 2.8. */
  resolveLanguageId?: (uri: Uri) => string;
  /** Called after a document opens, with its resolved `languageId`, so
   * the host can fire the matching `onLanguage:*` extension-activation
   * event (design.md §7.2, consumed by Task 1.12). Guarded: a throwing
   * callback must not fail `openDocument`. */
  onLanguageActivation?: (languageId: string) => void;
  /** Time source passed through to every `createDocument` call, so tests
   * can control undo-stack typing coalescing (mirrors `document.ts`'s
   * `clock` injection). Defaults to the system clock. */
  clock?: Clock;
  /** Filesystem seam — see {@link DocumentManagerFs}. Defaults to
   * `node:fs/promises`. */
  fs?: DocumentManagerFs;
}

/** The document-manager service itself (design.md §7.2). */
export interface DocumentManager {
  /**
   * Open (or return the already-open) document for `uri` (Req 5.5).
   * Stats the file first; files at or above
   * {@link LARGE_FILE_THRESHOLD_BYTES} open with `readonly: true`. Reads
   * the file as UTF-8, resolves its `languageId`, builds the document,
   * registers it, fires `onDidOpen`, then calls `onLanguageActivation`
   * (guarded).
   *
   * A read failure (missing file, permission error, stat failure, ...)
   * both rejects the returned promise AND is reported through
   * `log`/`sink` — `openDocument` is an explicit, caller-awaited action
   * (unlike `applyEdits`, which the UI drives on every keystroke), so
   * the caller needs to know synchronously that it failed, while the
   * log/sink still get a durable record for the status bar and
   * `developer.showLog`.
   */
  openDocument(uri: Uri): Promise<CoreDocument>;
  /** All currently open documents, as a fresh array snapshot. */
  readonly documents: readonly CoreDocument[];
  /** Save `uri`'s current text to disk atomically (write a temp file in
   * the same directory, then rename over the target). Returns `true` on
   * success, `false` on a no-op (unopened `uri`, readonly document) or a
   * write/rename failure. A no-op reports through `sink` but is not
   * logged as an error (it is not a filesystem failure); a write/rename
   * failure is reported through both `sink` and `log`, leaves `dirty`
   * true, fires no `onDidSave`, and best-effort removes the temp file.
   */
  save(uri: Uri): Promise<boolean>;
  /** Close `uri`: drop it from the manager and fire `onDidClose`.
   * Documents have no `dispose` of their own today — dropping the
   * manager's sole reference is enough for GC. An unknown `uri` is a
   * safe no-op (no event). */
  close(uri: Uri): void;
  onDidOpen: Event<CoreDocument>;
  onDidClose: Event<CoreDocument>;
  onDidSave: Event<CoreDocument>;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches document.ts's/registry.ts's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Build a `DocumentManager` (Req 5.5, design.md §7.2).
 */
export function createDocumentManager(deps: DocumentManagerDeps): DocumentManager {
  const { log, sink } = deps;
  const resolveLanguageId = deps.resolveLanguageId ?? (() => "plaintext");
  const fs = deps.fs ?? createNodeFs();
  const clock = deps.clock;

  const documentsMap = new Map<Uri, CoreDocument>();
  const openListeners = new Set<Listener<CoreDocument>>();
  const closeListeners = new Set<Listener<CoreDocument>>();
  const saveListeners = new Set<Listener<CoreDocument>>();
  let tempCounter = 0;

  /** Guarded `sink.error` — a broken/throwing sink must not make manager
   * methods throw (design.md §14, matches registry.ts's `notifySafely`). */
  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  /** Guarded `log.append` — same rationale as {@link notifySafely}. */
  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed — see notifySafely.
    }
  }

  function makeEvent<T>(listeners: Set<Listener<T>>): Event<T> {
    return (listener) => {
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
        },
      };
    };
  }

  function fire<T>(listeners: Set<Listener<T>>, event: T, context: string): void {
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop
    // (keymap/context.ts's onDidChange pattern).
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (cause) {
        logSafely("error", {
          message: `DocumentManager ${context} listener threw: ${describeError(cause)}`,
        });
      }
    }
  }

  /** In-flight opens keyed by uri: two concurrent `openDocument` calls for
   * the same uri must share one promise, or both would miss the documents
   * map (it is only populated after the awaited reads) and each build its
   * own instance, double-firing `onDidOpen`. */
  const pendingOpens = new Map<Uri, Promise<CoreDocument>>();

  function openDocument(uri: Uri): Promise<CoreDocument> {
    const existing = documentsMap.get(uri);
    if (existing) return Promise.resolve(existing);
    const pending = pendingOpens.get(uri);
    if (pending) return pending;
    const promise = openDocumentUncached(uri).finally(() => {
      pendingOpens.delete(uri);
    });
    pendingOpens.set(uri, promise);
    return promise;
  }

  async function openDocumentUncached(uri: Uri): Promise<CoreDocument> {
    const path = uriToPath(uri);
    let readonly = false;
    let text: string;
    try {
      const stat = await fs.stat(path);
      readonly = stat.size >= LARGE_FILE_THRESHOLD_BYTES;
      text = await fs.readFile(path, "utf8");
    } catch (cause) {
      const err: HostError = {
        message: `Failed to open document: ${describeError(cause)}`,
        path: uri,
      };
      logSafely("error", err);
      notifySafely(err);
      throw cause;
    }

    const languageId = resolveLanguageId(uri);
    const document = createDocument({
      uri,
      languageId,
      text,
      readonly,
      sink,
      log,
      clock,
    });

    documentsMap.set(uri, document);
    fire(openListeners, document, "onDidOpen");

    if (deps.onLanguageActivation) {
      try {
        deps.onLanguageActivation(languageId);
      } catch (cause) {
        logSafely("error", {
          message: `DocumentManager onLanguageActivation callback threw: ${describeError(cause)}`,
          path: uri,
        });
      }
    }

    return document;
  }

  async function save(uri: Uri): Promise<boolean> {
    const document = documentsMap.get(uri);
    if (!document) {
      notifySafely({
        message: `Cannot save: no open document for ${uri}`,
        path: uri,
      });
      return false;
    }
    if (document.readonly) {
      notifySafely({
        message: `Cannot save: document is read-only: ${uri}`,
        path: uri,
      });
      return false;
    }

    const path = uriToPath(uri);
    const tempPath = join(
      dirname(path),
      `.${basename(path)}.tmp-${process.pid}-${tempCounter++}`,
    );
    const text = document.getText();
    const versionAtWrite = document.version;

    // Capture the target's current mode (when it exists) so the rename
    // does not silently reset an executable or restricted file to the
    // temp file's default umask mode.
    let targetMode: number | undefined;
    try {
      targetMode = (await fs.stat(path)).mode;
    } catch {
      // First save of a not-yet-existing file: keep the default mode.
    }

    let wroteTemp = false;
    try {
      await fs.writeFile(tempPath, text, "utf8");
      wroteTemp = true;
      if (targetMode !== undefined) {
        await fs.chmod(tempPath, targetMode);
      }
      await fs.rename(tempPath, path);
    } catch (cause) {
      const err: HostError = {
        message: `Failed to save document: ${describeError(cause)}`,
        path: uri,
      };
      logSafely("error", err);
      notifySafely(err);
      if (wroteTemp) {
        try {
          await fs.unlink(tempPath);
        } catch {
          // Best-effort cleanup only — a stray temp file is a lesser
          // problem than losing the save-failure report above.
        }
      }
      return false;
    }

    // An edit that landed while the write was in flight is not in the
    // bytes just renamed into place: keep `dirty` so the document still
    // reads as unsaved, instead of silently misreporting the newest edit
    // as saved.
    if (document.version === versionAtWrite) {
      document.markSaved();
    }
    fire(saveListeners, document, "onDidSave");
    return true;
  }

  function close(uri: Uri): void {
    const document = documentsMap.get(uri);
    if (!document) return;
    documentsMap.delete(uri);
    fire(closeListeners, document, "onDidClose");
  }

  return {
    openDocument,
    get documents() {
      return Array.from(documentsMap.values());
    },
    save,
    close,
    onDidOpen: makeEvent(openListeners),
    onDidClose: makeEvent(closeListeners),
    onDidSave: makeEvent(saveListeners),
  };
}
