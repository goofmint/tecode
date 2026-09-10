/**
 * `DocumentManager`: open/close/save lifecycle over `CoreDocument` (Req
 * 5.5, design.md §7.2). Owns the `Map<Uri, CoreDocument>` backing
 * `tecode.workspace.openDocument`/`documents`, resolves each document's
 * `languageId` on open (via {@link DocumentManagerDeps.resolveLanguageId}
 * — the real language registry's `resolveLanguageId`, Task 2.8's
 * `languages/languageRegistry.ts`, wired in by `main.ts`'s composition
 * root; a stub default when omitted, this interface's own TSDoc), fires
 * `onLanguage:*` activation, and saves atomically (write a
 * temp file in the same directory, then rename over the target — never
 * leaves a half-written file on disk).
 *
 * Built with {@link createDocumentManager} rather than a class, per house
 * convention (matches `createCommandRegistry`, `createContextService`).
 *
 * **External file changes (Issue #119)**: when {@link DocumentManagerDeps.watch}
 * is supplied, every open document is also watched for changes another
 * process makes to its file on disk. Three deliberate design decisions
 * shape all of it (`handleExternalChangeEvent`/`saveNow` below implement
 * these; `openDocumentUncached` sets up the watch itself):
 *
 * 1. **Watch the PARENT directory, never the file itself** — `saveNow`'s
 *    own atomic save (temp file + `rename`) swaps the file's inode, which
 *    would silently kill a single-file watch the moment a document saves
 *    itself even once. A parent-directory watch survives that, and gets
 *    delete/recreate for free (matches the explorer's own story).
 * 2. **Never overwrite unsaved edits** — an external change is only ever
 *    auto-reloaded into a `dirty === false` buffer. A `dirty` buffer is
 *    left untouched; it only gets a `notifyUser` warning. There is no
 *    three-way merge/diff UI in this MVP.
 * 3. **Disk signature (`mtimeMs`+`size`) as a self-loop filter** — this
 *    document's OWN save must not look like an external change. A cheap
 *    signature comparison is the first-pass filter; only a signature
 *    mismatch triggers an actual re-read and content comparison against
 *    the buffer, so the manager's own save (which refreshes the tracked
 *    signature right after its `rename` succeeds) never round-trips
 *    through a spurious reload.
 */

import * as nodeFs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Disposable, Event, FileChangeEvent, Listener, Uri } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import type { Clock } from "./clock";
import { createDocument, type CoreDocument } from "./document";
import { pathToUri, uriToPath } from "./uri";

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
  /**
   * `mtimeMs` (added for Issue #119, alongside the pre-existing `size`/
   * `mode`) is the disk-change signature `openDocumentUncached`/`saveNow`/
   * the watch-driven external-change check compare against: two `stat`
   * calls reporting the same `mtimeMs`+`size` pair are treated as "nothing
   * changed" without ever re-reading the file's bytes. Every real
   * `fs.Stats` object already carries this (the real `createNodeFs`, and
   * every test fake that just delegates to `node:fs/promises`' own `stat`,
   * need no change) — only a fake built by hand (`documentManager.test.
   * ts`'s `DocumentManagerFs` literals) must now also supply it.
   */
  stat(path: string): Promise<{ size: number; mode: number; mtimeMs: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The real {@link DocumentManagerFs}, backed by `node:fs/promises`. */
function createNodeFs(): DocumentManagerFs {
  return {
    stat: (path) => nodeFs.stat(path),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
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
   * always returns `"plaintext"`; production wiring passes
   * `languages/languageRegistry.ts`'s `LanguageRegistry.resolveLanguageId`
   * (Task 2.8, `main.ts`'s composition root). */
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
  /**
   * Watch a file or directory for changes (Issue #119) — same signature as
   * `buffer/fileSystem.ts`'s `FileSystem.watch`, so production wiring
   * passes that module's real `createFileSystem(...).watch` straight
   * through (`main.ts`'s composition root) with no adapter needed. Called
   * by `openDocumentUncached` against each open document's PARENT
   * directory, never the file itself — an atomic `save()` (this module's
   * own `saveNow`) replaces the file via `rename`, which swaps its inode;
   * a single-file watch would silently go dead the moment this document
   * saves itself even once. Watching the parent directory instead never
   * goes dead across a rename, and gets deletion/recreation for free
   * (matches the explorer's own directory-watch story). Omitted (the
   * default) disables external-change detection entirely — every document
   * behaves exactly as it did before Issue #119 (no watch is ever set up,
   * no disk signature is ever compared at save time beyond what already
   * existed).
   */
  watch?: (uri: Uri, listener: Listener<FileChangeEvent>) => Disposable;
  /**
   * Optional user-facing notice callback (Issue #119) — kept separate from
   * `sink`/`log` (both real filesystem-failure reporting paths) because
   * "this file changed on disk" / "this file was deleted" / "save refused:
   * disk changed" are advisories, not I/O failures: nothing here failed to
   * execute, the manager is deliberately declining to act. Routes through
   * to `tecode.window.showMessage` in production (`main.ts`'s composition
   * root, `WindowMessageService.showMessage`) — this module stays
   * decoupled from that service's real type so core's buffer layer never
   * has to import the UI layer just to warn about a stale buffer.
   * Guarded exactly like every other injected callback in this module
   * (`onLanguageActivation`'s own TSDoc): a throwing `notifyUser` must
   * never break the caller that triggered it. Omitted (the default)
   * silently drops these notices — external-change detection/save-conflict
   * refusal still happen either way, only the user-facing heads-up is
   * skipped.
   */
  notifyUser?: (message: string, kind: "warning") => void;
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
   * **A path that does not exist yet opens as a new, empty, non-dirty
   * document instead of failing** (Req 5.6, Issue #88): when the initial
   * `stat` fails with `ENOENT` specifically, this is treated as "a file
   * the user hasn't saved yet" rather than an error — `text` is `""` and
   * `readonly` is `false`. `createDocument`'s `dirty` starts `false` and
   * only flips on an actual edit (`document.ts`), so an untouched new
   * buffer never prompts a save-changes confirmation on quit, and saving
   * it without ever typing into it still writes nothing to disk
   * (`saveNow` always performs its write — it does not itself gate on
   * `dirty` — so this guarantee comes entirely from the buffer starting
   * clean, not from `save()` skipping a no-op).
   *
   * Deliberately UNCONDITIONAL on `ENOENT` — unlike `cli/argv.ts`'s
   * `resolveStartupTarget`, this does NOT also require `dirname(path)` to
   * exist. `resolveStartupTarget` layers its own stricter "parent must
   * exist" guard on top, because CLI startup can react to a typo'd deep
   * path with an immediate, specific warning instead of silently opening
   * an editor. This lower-level primitive is shared by every caller
   * (including `tecode.workspace.openDocument`, called by extensions with
   * arbitrary paths, not just CLI startup) and stays simple: a path whose
   * parent genuinely doesn't exist still surfaces a clear, specific
   * error — just deferred to `save()` time instead of `openDocument`
   * time (the temp-file `writeFile` in `saveNow` fails with its own
   * `ENOENT`, reported through `log`/`sink` exactly like any other save
   * failure).
   *
   * Every OTHER read failure (`EACCES`, `EIO`, or a stat/read that fails
   * for any reason besides "missing") keeps the pre-Issue-#88 contract
   * exactly: both rejects the returned promise AND is reported through
   * `log`/`sink` — `openDocument` is an explicit, caller-awaited action
   * (unlike `applyEdits`, which the UI drives on every keystroke), so
   * the caller needs to know synchronously that it failed, while the
   * log/sink still get a durable record for the status bar and
   * `developer.showLog`. Silently opening a permission-denied path as an
   * empty buffer instead would be worse than the failure it replaces: a
   * later save would overwrite a file the user was never able to read.
   */
  openDocument(uri: Uri): Promise<CoreDocument>;
  /** All currently open documents, as a fresh array snapshot. */
  readonly documents: readonly CoreDocument[];
  /** Save `uri`'s current text to disk atomically (write a temp file in
   * the same directory, then rename over the target). Returns `true` on
   * success, `false` on a no-op (unopened `uri`, readonly document) or a
   * write/rename failure.
   *
   * Durability trade-off (deliberate): the temp file is NOT fsync'd
   * before the rename. The rename guarantees readers never observe a
   * partial file, but a crash or power loss in the small window between
   * write and the data reaching stable storage could leave the target
   * empty or truncated. For an interactive editor save the added fsync
   * latency on every Ctrl+S is not worth closing that window in the MVP;
   * revisit if a durability contract is ever required. A no-op reports through `sink` but is not
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
  /**
   * Fires after a document is reloaded from disk because it changed
   * externally while non-`dirty` (Issue #119, `document.ts`'s internal
   * `reloadFromDisk`). Never fires for a `save()`-triggered write (that is
   * `onDidSave`'s own event) or for a `dirty` document's external change
   * (that document is deliberately left untouched — see `notifyUser`'s
   * TSDoc on {@link DocumentManagerDeps}). `ui/editorSession.ts`'s
   * `EditorSessionService` subscribes to this to clamp a reloaded
   * document's `EditorState.selections`/`scrollTop` back into bounds when
   * the reload shrank the document out from under a stale cursor.
   */
  onDidReload: Event<CoreDocument>;
  /**
   * Dispose every still-live watch this manager set up (Issue #119) — one
   * per currently open document, registered by `openDocumentUncached`
   * against `deps.watch`. Idempotent; a safe no-op when `deps.watch` was
   * never supplied (nothing was ever watched). Does NOT close any
   * documents or fire `onDidClose` — this only releases the filesystem
   * watch handles, matching `main.ts`'s `performShutdown` calling this
   * alongside (not instead of) every other startup-owned disposable.
   */
  dispose(): void;
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`, `"EEXIST"`) from a
 * caught unknown, or `undefined` when it carries none. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
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
  const watch = deps.watch;

  const documentsMap = new Map<Uri, CoreDocument>();
  const openListeners = new Set<Listener<CoreDocument>>();
  const closeListeners = new Set<Listener<CoreDocument>>();
  const saveListeners = new Set<Listener<CoreDocument>>();
  const reloadListeners = new Set<Listener<CoreDocument>>();
  let tempCounter = 0;

  /** Each open document's last-known disk signature (Issue #119) —
   * `mtimeMs`+`size`, the cheap first-pass filter `openDocumentUncached`
   * seeds, `saveNow` refreshes after a successful rename, and the
   * watch-driven external-change check both compares against AND (when a
   * change turns out to be this document's own save landing, or the
   * buffer's text already matches disk) refreshes. No entry for a uri
   * means "unknown" — either the document was never opened against a real
   * file (Req 5.6/Issue #88's ENOENT-opens-empty path) or it was closed;
   * every comparison below treats "unknown" as "assume changed" rather
   * than silently skipping the check. */
  const diskSignatures = new Map<Uri, { mtimeMs: number; size: number }>();
  /** One filesystem watch per currently open document, keyed by the
   * document's own uri (registered against its PARENT directory — see
   * `DocumentManagerDeps.watch`'s TSDoc) — disposed on `close(uri)` and on
   * this manager's own `dispose()`. */
  const watchDisposables = new Map<Uri, Disposable>();
  /** Per-uri serialized chain for external-change processing (Issue #119)
   * — mirrors `saveQueues` below (and `config/service.ts`'s per-file
   * reload chains): two watch events for the same uri firing in quick
   * succession must not run overlapping checks, or a slower-to-finish
   * older check could land after — and stomp on the result of — a newer
   * one. No debounce, same MVP trade-off `config/service.ts` documents. */
  const externalChangeChains = new Map<Uri, Promise<void>>();

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

  /** Guarded `deps.notifyUser` — same rationale as {@link notifySafely},
   * for the separate user-facing-advisory channel (Issue #119,
   * `DocumentManagerDeps.notifyUser`'s own TSDoc on why it's distinct from
   * `sink`/`log`). A no-op when `deps.notifyUser` was never supplied. */
  function notifyUserSafely(message: string): void {
    if (!deps.notifyUser) return;
    try {
      deps.notifyUser(message, "warning");
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
    // Issue #119: the initial disk signature, seeded from THIS stat when
    // the file actually exists — `undefined` (no entry ever set) for the
    // ENOENT/new-file path below, since there is no disk state yet to
    // remember.
    let initialSignature: { mtimeMs: number; size: number } | undefined;
    try {
      const stat = await fs.stat(path);
      readonly = stat.size >= LARGE_FILE_THRESHOLD_BYTES;
      text = await fs.readFile(path, "utf8");
      initialSignature = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        const err: HostError = {
          message: `Failed to open document: ${describeError(cause)}`,
          path: uri,
        };
        logSafely("error", err);
        notifySafely(err);
        throw cause;
      }
      // ENOENT: a new file that doesn't exist on disk yet (Req 5.6, Issue
      // #88) — see this function's TSDoc above for why this is
      // unconditional and how a truly broken path still gets a clear
      // error, just deferred to save() time.
      text = "";
      readonly = false;
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
    if (initialSignature) diskSignatures.set(uri, initialSignature);
    fire(openListeners, document, "onDidOpen");

    // Issue #119: watch this document's PARENT directory (see
    // `DocumentManagerDeps.watch`'s TSDoc for why parent-not-file) so
    // external changes are detected for as long as the document stays
    // open. Registered right after the document is registered/announced,
    // exactly like every other per-document setup step above.
    if (watch) {
      try {
        const parentUri = pathToUri(dirname(path));
        const disposable = watch(parentUri, (event) => {
          if (event.uri !== uri) return;
          scheduleExternalChangeCheck(uri, document);
        });
        watchDisposables.set(uri, disposable);
      } catch (cause) {
        logSafely("warning", {
          message: `Could not watch "${uri}" for external changes: ${describeError(cause)}`,
          path: uri,
        });
      }
    }

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

  /** Queue one external-change check for `uri`, running strictly after
   * whatever check is already in flight for the SAME uri (this module's
   * TSDoc on {@link externalChangeChains} above). */
  function scheduleExternalChangeCheck(uri: Uri, document: CoreDocument): void {
    const prev = externalChangeChains.get(uri) ?? Promise.resolve();
    const next = prev.then(
      () => handleExternalChangeEvent(uri, document),
      () => handleExternalChangeEvent(uri, document),
    );
    externalChangeChains.set(uri, next);
  }

  /**
   * One watch event's worth of work (Issue #119): `stat` the target,
   * decide whether anything actually changed, and either reload a clean
   * buffer, warn about a dirty one, or do nothing — see this module's
   * top-level design notes (`documentManager.ts`'s own module TSDoc points
   * back at Issue #119's plan for the full decision tree). Never throws:
   * every branch that can fail (`stat`, `readFile`) is caught and reported
   * through `log`, matching this module's other guarded-boundary
   * functions.
   */
  async function handleExternalChangeEvent(uri: Uri, document: CoreDocument): Promise<void> {
    // The document may have been closed (or replaced by a fresh open of
    // the same uri) while this check sat queued behind an earlier one on
    // the same uri's serialized chain — bail out rather than reloading or
    // warning about a document nobody holds a reference to anymore.
    if (documentsMap.get(uri) !== document) return;

    const path = uriToPath(uri);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await fs.stat(path);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        logSafely("warning", {
          message: `Failed to check "${uri}" for external changes: ${describeError(cause)}`,
          path: uri,
        });
        return;
      }
      // Deleted on disk: keep the buffer open exactly as it is — neither
      // closing it nor reloading it — and just warn. Deliberately leaves
      // the tracked signature untouched (this module's TSDoc on
      // `diskSignatures`): if the file reappears, the next event's
      // comparison still runs against what we last knew, not "nothing".
      notifyUserSafely(`"${uri}" was deleted on disk.`);
      return;
    }

    const known = diskSignatures.get(uri);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
      // Signature unchanged: the cheap first-pass filter (this module's
      // TSDoc on `diskSignatures`) — never even reads the file's bytes.
      return;
    }

    let diskText: string;
    try {
      diskText = await fs.readFile(path, "utf8");
    } catch (cause) {
      logSafely("warning", {
        message: `Failed to read "${uri}" after an external change: ${describeError(cause)}`,
        path: uri,
      });
      return;
    }

    if (diskText === document.getText()) {
      // The signature moved (e.g. this document's OWN save just landed —
      // self-loop suppression, this module's TSDoc) but the bytes did not:
      // just refresh the signature so the next GENUINE external edit is
      // still detected, without disturbing the buffer or firing anything.
      diskSignatures.set(uri, { mtimeMs: stat.mtimeMs, size: stat.size });
      return;
    }

    if (document.dirty) {
      // Never clobber unsaved edits (design decision #2, this module's
      // top-level notes): warn only, and deliberately do NOT update the
      // signature — `saveNow`'s own stat comparison must still see this
      // mismatch and refuse to overwrite the newer disk content.
      notifyUserSafely(`"${uri}" was changed on disk.`);
      return;
    }

    document.reloadFromDisk(diskText);
    diskSignatures.set(uri, { mtimeMs: stat.mtimeMs, size: stat.size });
    fire(reloadListeners, document, "onDidReload");
  }

  /** Per-uri chain of in-flight saves: a second save of the same uri
   * waits for the first to fully finish (rename included), so an older
   * snapshot's rename can never land after — and silently clobber — a
   * newer save's bytes on disk. */
  const saveQueues = new Map<Uri, Promise<unknown>>();

  function save(uri: Uri): Promise<boolean> {
    const prev = saveQueues.get(uri) ?? Promise.resolve();
    const run = prev.then(
      () => saveNow(uri),
      () => saveNow(uri),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    saveQueues.set(uri, tail);
    void tail.then(() => {
      if (saveQueues.get(uri) === tail) saveQueues.delete(uri);
    });
    return run;
  }

  async function saveNow(uri: Uri): Promise<boolean> {
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
    const text = document.getText();
    const versionAtWrite = document.version;

    // Capture the target's current mode (when it exists) so the rename
    // does not silently reset an executable or restricted file to the
    // temp file's default umask mode. Only ENOENT ("first save of a new
    // file") may continue with the default mode — any other stat failure
    // (EIO, EACCES, ...) means the target is not trustworthy right now,
    // so report and abort rather than saving with a possibly-wrong mode.
    let targetMode: number | undefined;
    try {
      const stat = await fs.stat(path);
      targetMode = stat.mode;
      // Issue #119: refuse to blindly overwrite a file that changed on
      // disk since we last knew about it — either the watch-driven check
      // already warned about it while this document stayed dirty (and
      // deliberately left the signature stale, this module's TSDoc), or
      // no watch is even wired up and this is the first time anyone
      // noticed. `known === undefined` ("we have no tracked signature at
      // all", Req 5.6/Issue #88's new-file path) is NOT a conflict — that
      // is the pre-existing "first save creates the file" contract this
      // check must leave untouched.
      const known = diskSignatures.get(uri);
      if (known && (known.mtimeMs !== stat.mtimeMs || known.size !== stat.size)) {
        notifyUserSafely(
          `Cannot save: "${uri}" changed on disk since it was last read. Reload to see the latest content before saving again.`,
        );
        return false;
      }
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        const err: HostError = {
          message: `Failed to save document: ${describeError(cause)}`,
          path: uri,
        };
        logSafely("error", err);
        notifySafely(err);
        return false;
      }
    }

    // Create the temp file EXCLUSIVELY ("wx" — O_CREAT|O_EXCL): a plain
    // writeFile follows an existing symlink, so a link pre-created at the
    // predictable temp name could redirect the write to an arbitrary
    // file. EEXIST (someone squatted the name) retries under fresh names.
    let tempPath: string | undefined;
    try {
      for (let attempt = 0; attempt < 3 && tempPath === undefined; attempt++) {
        const candidate = join(
          dirname(path),
          `.${basename(path)}.tmp-${process.pid}-${tempCounter++}`,
        );
        try {
          await fs.writeFile(candidate, text, { encoding: "utf8", flag: "wx" });
          tempPath = candidate;
        } catch (cause) {
          if (errorCode(cause) !== "EEXIST") throw cause;
        }
      }
      if (tempPath === undefined) {
        throw new Error("every candidate temp-file name already exists");
      }
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
      if (tempPath !== undefined) {
        try {
          await fs.unlink(tempPath);
        } catch {
          // Best-effort cleanup only — a stray temp file is a lesser
          // problem than losing the save-failure report above.
        }
      }
      return false;
    }

    // Issue #119: the bytes just renamed into place ARE disk's current
    // state now — refresh the tracked signature so the next
    // external-change check (watch-driven, or this same document's next
    // save) compares against reality instead of what was there before
    // this save. Best-effort: a failed re-stat here only means the NEXT
    // check re-reads the file to confirm rather than trusting a signature
    // — not worth failing an otherwise-successful save over, so this
    // drops the (now unknown) signature rather than aborting.
    try {
      const postSaveStat = await fs.stat(path);
      diskSignatures.set(uri, { mtimeMs: postSaveStat.mtimeMs, size: postSaveStat.size });
    } catch {
      diskSignatures.delete(uri);
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
    diskSignatures.delete(uri);
    externalChangeChains.delete(uri);
    const disposable = watchDisposables.get(uri);
    if (disposable) {
      watchDisposables.delete(uri);
      try {
        disposable.dispose();
      } catch {
        // Best-effort — matches this module's other guarded dispose calls.
      }
    }
    fire(closeListeners, document, "onDidClose");
  }

  function dispose(): void {
    for (const disposable of watchDisposables.values()) {
      try {
        disposable.dispose();
      } catch {
        // Best-effort — see close()'s identical guard above.
      }
    }
    watchDisposables.clear();
  }

  return {
    openDocument,
    get documents() {
      return Array.from(documentsMap.values());
    },
    save,
    close,
    dispose,
    onDidOpen: makeEvent(openListeners),
    onDidClose: makeEvent(closeListeners),
    onDidSave: makeEvent(saveListeners),
    onDidReload: makeEvent(reloadListeners),
  };
}
