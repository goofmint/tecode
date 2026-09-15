/**
 * `FindFileService` (Issue #164): the stateful layer behind the find-file
 * minibuffer — Emacs' `find-file` (`C-x C-f`) rendered as a one-line path
 * input at the bottom of the editor area (`findFileWidget.tsx`), driven by
 * `findFileCommand.ts`'s `workbench.action.files.findFile` plus its own
 * `findFile.*` widget commands.
 *
 * **One global state, not per-tab** (Issue #164's Design Choice 1): unlike
 * `findService.ts` (whose `FindState` lives in each tab's `EditorState`,
 * because a search query belongs to the buffer it searches), find-file is a
 * single transient prompt — there is exactly one of it open at a time for
 * the whole window, so this service owns its own {@link FindFileState}
 * object and nothing about it is written into `EditorState` at all.
 *
 * **Deliberately thin about opening files**: {@link FindFileService.accept}
 * resolves the typed path and then executes the EXISTING
 * `workbench.action.files.openUri` command (`openFileCommand.ts`) — it never
 * touches `DocumentManager` itself. That is what makes "type a path that
 * does not exist yet, get an empty, non-dirty buffer in a tab, with nothing
 * written to disk" fall out for free: `documentManager.ts`'s own ENOENT
 * branch (Req 5.6, Issue #88) already implements exactly that, so this
 * module adds no new file-creation policy of its own (Issue #164's Design
 * Choice 3 — the permissive posture: a missing PARENT directory is not
 * rejected here either; the error surfaces at save time).
 *
 * **Completion is Emacs' `minibuffer-complete`** ({@link
 * FindFileService.complete}): one candidate completes outright (a directory
 * gaining a trailing `/` so the next Tab lists inside it), several
 * candidates extend the query to their longest common prefix, and a query
 * that cannot be extended any further shows the candidate list instead. All
 * entries of the directory are candidates — hidden files included, and
 * `.gitignore` deliberately NOT consulted (Issue #164's 論点 2: Emacs shows
 * everything; `ctrl+p`'s workspace quick-open is the ignore-respecting
 * entry point, and the two policies are intentionally different).
 *
 * **Stale-result policy** (Issue #164's Phase 3, mirroring
 * `search/store.ts`'s `generation`/`isStale` precedent): `readdir` is
 * async, so a second Tab pressed before the first one's listing arrives
 * would otherwise splice an answer computed for an older query. A
 * generation counter is bumped SYNCHRONOUSLY before the first `await` and
 * re-checked after it; a superseded result is dropped silently, with no
 * state write and no `onDidChange`. No `AbortSignal` — `FileSystem.readdir`
 * takes none.
 *
 * **Never throws**: a `readdir` that rejects (the directory does not exist
 * yet, or is unreadable) means "no candidates", not an error to surface —
 * the user is mid-typing a path that may legitimately not exist yet, which
 * is the whole point of the feature.
 */

import { dirname } from "node:path";
import type { Disposable, Event, FileSystem, Listener, Uri } from "@tecode/api";
import { pathToUri, uriToPath } from "../buffer/uri";
import type { EditorSessionService } from "./editorSession";
import {
  appendTrailingSeparator,
  longestCommonPrefix,
  resolvePathInput,
  splitPathInput,
  spliceCompletion,
} from "./findFilePath";

/** How many candidate names {@link FindFileState.candidates} ever holds
 * (Issue #164's Phase 3 cap, same "bound an unbounded listing" reasoning as
 * `command-palette`'s own `QUICK_OPEN_MAX_RESULTS`) — a directory with more
 * matching entries than this reports the remainder as
 * {@link FindFileState.truncatedCount} instead of materializing all of
 * them. */
export const FIND_FILE_MAX_CANDIDATES = 500;

/** The find-file minibuffer's whole state (this module's TSDoc's "One
 * global state"). Replaced wholesale on every change — never mutated in
 * place — so a React consumer can compare identities. */
export interface FindFileState {
  /** Whether the widget is mounted at all (`shell.tsx`'s `EditorArea`
   * reads exactly this to decide). */
  isOpen: boolean;
  /** The raw path text the user has typed, in whatever form they typed it
   * (`~/`, `../`, absolute). */
  query: string;
  /** The absolute directory {@link query} currently points INTO, already
   * `~`-expanded and `..`-resolved — what the widget displays so the user
   * can see which directory a Tab would list (Issue #164's "入力中は「今
   * どのディレクトリを見ているか」が分かる表示にする"). */
  dirPath: string;
  /** The candidate entry names shown when a completion could not extend
   * the query any further (directories carry a trailing `/`). Empty
   * whenever the last completion DID extend the query, and whenever no
   * completion has run for the current query. */
  candidates: readonly string[];
  /** How many further candidates {@link FIND_FILE_MAX_CANDIDATES} dropped
   * from {@link candidates}; `0` when nothing was dropped. */
  truncatedCount: number;
}

/** Dependencies for {@link createFindFileService}. Narrowed to `Pick`s
 * (matches `FindServiceDeps`/`OpenFileCommandDeps`' own narrowing) so a
 * test can inject minimal fakes instead of a whole real session,
 * filesystem, or command registry. */
export interface FindFileServiceDeps {
  /** Read-only: the active document's own directory is the initial value
   * and the base for relative paths (Emacs' own `default-directory`
   * behavior). */
  editorSession: Pick<EditorSessionService, "getActiveDocument">;
  /** The workspace root, used as the base directory whenever no document
   * is active. */
  rootUri: Uri;
  fs: Pick<FileSystem, "readdir">;
  /** The user's home directory, for `~` expansion — injected rather than
   * read from `node:os` here so this service stays unit-testable against a
   * temporary directory. */
  homeDir: string;
  /** `CommandRegistry.execute`, used for exactly one command:
   * `workbench.action.files.openUri` (this module's TSDoc). */
  executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>;
}

/** The find-file service's public shape (this module's TSDoc). */
export interface FindFileService {
  /** The current state — a fresh object on every change (this module's
   * `writeState`). */
  getState(): FindFileState;
  /** Open the minibuffer, seeded with the active document's directory (or
   * the workspace root when no document is active), trailing separator
   * included so a Tab lists that directory straight away. A no-op when
   * already open (a guarded toggle, like `FindService.open`). */
  open(): void;
  /** Close the minibuffer and forget the typed path/candidates. A no-op
   * when already closed. */
  close(): void;
  /** Replace the typed path (every keystroke the widget's `Input`
   * reports). Clears any candidate list, since it described the PREVIOUS
   * query. */
  setQuery(query: string): void;
  /** Resolve the typed path and hand it to
   * `workbench.action.files.openUri`, then close (this module's TSDoc's
   * "Deliberately thin about opening files").
   *
   * @returns `true` when a path was actually opened; `false` when the call
   * was a no-op — the widget is closed, or the query names a DIRECTORY
   * rather than a file (empty, or ending in a separator). The second case
   * deliberately leaves the widget open so the user can keep typing a file
   * name: this editor has no directory-listing buffer to open instead
   * (Emacs would show dired), and asking `openUri` to open a directory
   * would only fail with `EISDIR` in the log.
   */
  accept(): boolean;
  /** Emacs' `minibuffer-complete` for the current query (this module's
   * TSDoc's "Completion is Emacs' `minibuffer-complete`"). Resolves once
   * the listing has been applied — or dropped, when a newer call
   * superseded it. Never rejects. */
  complete(): Promise<void>;
  /** Fires after any state change this service makes — same "just
   * re-render, don't diff what changed" shape as
   * `EditorSessionService.onDidChange`/`FindService.onDidChange`. */
  onDidChange: Event<void>;
  /** Clear all `onDidChange` listeners and make every further state change
   * a no-op. Idempotent. */
  dispose(): void;
}

/** The initial (closed, empty) state — also what {@link
 * FindFileService.close} returns to. */
function createClosedState(): FindFileState {
  return { isOpen: false, query: "", dirPath: "", candidates: [], truncatedCount: 0 };
}

/** Build a {@link FindFileService} (Issue #164). */
export function createFindFileService(deps: FindFileServiceDeps): FindFileService {
  const { editorSession, rootUri, fs, homeDir, executeCommand } = deps;
  const listeners = new Set<Listener<void>>();
  let state: FindFileState = createClosedState();
  let disposed = false;
  // Bumped synchronously before every `readdir` (this module's TSDoc's
  // "Stale-result policy"); a listing whose captured value no longer
  // matches is discarded.
  let generation = 0;

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches every
    // other `onDidChange` in this codebase (`findService.ts`,
    // `editorSession.ts`, `document.ts`).
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures.
      }
    }
  }

  /** The single write path — every mutation below funnels through here, so
   * `onDidChange` can never be forgotten (`findService.ts`'s `writeFind`
   * plays the same role there). */
  function writeState(next: FindFileState): void {
    if (disposed) return;
    state = next;
    fireChange();
  }

  /** The directory relative paths resolve against: the active document's
   * own directory, or the workspace root when no document is active
   * (Emacs' `default-directory`). */
  function baseDir(): string {
    const document = editorSession.getActiveDocument();
    if (document) return dirname(uriToPath(document.uri));
    return uriToPath(rootUri);
  }

  /** `query` plus the directory it points into, recomputed together so
   * {@link FindFileState.dirPath} can never drift from the typed text. */
  function withQuery(base: FindFileState, query: string, candidates: readonly string[], truncatedCount: number): FindFileState {
    const { dirPath } = splitPathInput(query, baseDir(), homeDir);
    return { ...base, query, dirPath, candidates, truncatedCount };
  }

  function open(): void {
    if (state.isOpen) return;
    // The active document's own directory, trailing separator included so
    // the very first Tab lists that directory rather than completing its
    // own name (`findFilePath.ts`'s `appendTrailingSeparator`).
    const initial = appendTrailingSeparator(baseDir());
    writeState(withQuery({ ...createClosedState(), isOpen: true }, initial, [], 0));
  }

  function close(): void {
    if (!state.isOpen) return;
    generation += 1;
    writeState(createClosedState());
  }

  function setQuery(query: string): void {
    if (!state.isOpen) return;
    if (state.query === query) return;
    generation += 1;
    // Candidates always describe the query they were computed for — a new
    // keystroke retires them (Emacs hides its `*Completions*` buffer the
    // same way).
    writeState(withQuery(state, query, [], 0));
  }

  function accept(): boolean {
    if (!state.isOpen) return false;
    const base = baseDir();
    const { partial } = splitPathInput(state.query, base, homeDir);
    // A directory (or an empty query) has no file to open — see
    // `FindFileService.accept`'s TSDoc on why this stays open instead.
    if (partial.length === 0) return false;
    const path = resolvePathInput(state.query, base, homeDir);
    close();
    // `openUri` never throws (`openFileCommand.ts`'s "Never throws") — it
    // logs a bad argument/failed open itself, so there is nothing for this
    // caller to handle. `void` rather than `await`: `accept` is driven by a
    // synchronous keybinding handler, and the tab activation the command
    // performs reaches the shell through `editorSession.onDidChange`
    // whenever it lands.
    void executeCommand("workbench.action.files.openUri", pathToUri(path));
    return true;
  }

  async function complete(): Promise<void> {
    if (!state.isOpen) return;
    const query = state.query;
    const { dirPath, partial } = splitPathInput(query, baseDir(), homeDir);
    // Captured BEFORE the first `await` (this module's TSDoc's
    // "Stale-result policy").
    generation += 1;
    const requested = generation;
    let names: string[];
    try {
      const entries = await fs.readdir(pathToUri(dirPath));
      names = entries
        // Every entry is a candidate — no `.gitignore`/hidden-file
        // filtering (this module's TSDoc).
        .filter((entry) => entry.name.startsWith(partial))
        // A directory completes WITH its separator, so the next Tab lists
        // inside it instead of re-completing the same name.
        .map((entry) => (entry.type === "directory" ? appendTrailingSeparator(entry.name) : entry.name))
        .sort();
    } catch {
      // "No candidates", not an error (this module's TSDoc's "Never
      // throws") — a path the user is still typing need not exist.
      return;
    }
    if (requested !== generation) return; // Superseded by a newer completion.
    if (disposed || !state.isOpen || state.query !== query) return;
    if (names.length === 0) return;

    const sole = names[0];
    if (names.length === 1 && sole !== undefined) {
      writeState(withQuery(state, spliceCompletion(query, partial, sole), [], 0));
      return;
    }
    // Only try to extend when the user has STARTED typing a partial name —
    // "ディレクトリ末尾で Tab" (partial = "") always shows the candidate list
    // instead of silently extending, because there is nothing to extend.
    if (partial.length > 0) {
      const prefix = longestCommonPrefix(names);
      if (prefix.length > partial.length) {
        // Extended the query — Emacs shows no candidate list in this case.
        writeState(withQuery(state, spliceCompletion(query, partial, prefix), [], 0));
        return;
      }
    }
    // Cannot be extended any further (or partial is empty): show what the choices are (Issue
    // #164's "それ以上伸ばせない／ディレクトリ末尾で Tab → 候補一覧を表示").
    const shown = names.slice(0, FIND_FILE_MAX_CANDIDATES);
    writeState(withQuery(state, query, shown, names.length - shown.length));
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        listeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
  }

  return {
    getState: () => state,
    open,
    close,
    setQuery,
    accept,
    complete,
    onDidChange,
    dispose,
  };
}
