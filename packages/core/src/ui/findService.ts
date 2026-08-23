/**
 * `FindService` (Req 11.1, design.md §13's "Find/replace state is
 * per-editor... pure command handlers over `tecode.editor` +
 * `document.transaction`"): the stateful layer behind `tecode.editor.find`
 * (`api/create.ts`) and `findWidget.tsx`. Owns every mutation of a tab's
 * `EditorState.find` (`editorState.ts`'s `FindState`) — `editor-core`'s
 * commands and the find widget both only ever call through here, never
 * write `EditorState.find` directly.
 *
 * **Architecture decision (design.md §13)**: all find state/logic/UI lives
 * in `@tecode/core`; `editor-core` (a built-in extension, `@tecode/api`
 * only) contributes nothing but commands and keybindings that delegate to
 * `ctx.api.editor.find.*`. This mirrors `ui/editorSession.ts`'s own
 * "component-external code and React both need to read/write the same live
 * state" shape: `findWidget.tsx` reads `EditorState.find` reactively (via
 * `editorSession.onDidChange`, exactly like `EditorView` already does for
 * `selections`/`scrollTop`), while `editor-core`'s command handlers and
 * this service's own document-change subscription write to it from outside
 * React entirely.
 *
 * **Live match updates** (Req 11.1): once a document becomes active with an
 * open (or previously-used) `FindState`, this service subscribes to that
 * document's OWN `onDidChange` and recomputes `matches` on every edit —
 * simplicity over incremental dirty-range diffing (`editor/find.ts`'s
 * `computeMatches` re-scans the whole buffer every time, which is
 * acceptable for the MVP's line-by-line scan). The subscription itself is
 * re-pointed whenever the active document changes (`editorSession.
 * onDidChange`), so switching tabs never leaves a stale listener attached
 * to a document that is no longer active, and a newly-active tab's own
 * `FindState` (if any) starts tracking its own buffer immediately.
 *
 * **Reveal-on-navigate**: deliberately does NOT touch `EditorState.
 * selections` or `scrollTop` itself — `editorView.tsx`'s own per-render
 * scroll derivation reads `state.find` directly (when a find widget is
 * open with an active match, it reveals that match's line via the exact
 * same `revealLine` viewport math it already uses for the primary cursor)
 * so this service only needs to keep `find.activeMatchIndex` correct;
 * `EditorView` reacts to it on the very next render, with no separate
 * "guess the viewport height and reveal it myself" logic duplicated here.
 * This also keeps navigation from clobbering whatever the user's actual
 * cursor/selections were before find was opened (design.md §13's "match
 * highlighting distinct from selections" — this service never conflates
 * the two).
 *
 * **Index policy — two different clamps, deliberately** (this module's
 * `wrapIndex`/`reanchorIndex`):
 * - `next`/`previous` treat `matches` as a fixed ring to cycle around:
 *   modulo wraparound, past-the-end goes to 0, before-the-start goes to the
 *   last entry.
 * - A recompute triggered by the BUFFER changing (a document edit, whether
 *   from `replaceCurrent`/`replaceAll` or any other edit while find stays
 *   open) does not "cycle" — it re-clamps whatever index was active into
 *   the new match count, treating a previously-unset (`-1`) index as
 *   "jump to the first match" rather than wrapping to the last one the
 *   ring-cycle formula would otherwise produce. For `replaceCurrent`
 *   specifically, this is what makes "recomputes and advances" true
 *   without any special-cased "advance" step: removing the replaced match
 *   shifts every later match one slot earlier, so re-clamping the SAME
 *   index number onto the shrunken array lands on whatever match now
 *   occupies that slot — the next one in document order (or wraps to the
 *   first if the replaced match was the last).
 * - A recompute triggered by the QUERY/case-sensitivity changing
 *   (`setQuery`/`toggleCaseSensitive`) instead re-anchors to the nearest
 *   match at/after the current primary cursor (search-cursor semantics,
 *   the same "jump to what's relevant to where you are" a user expects
 *   from live-search-as-you-type), wrapping to the first match if none
 *   qualify.
 */

import type { Disposable, Event, Listener, Position, Range } from "@tecode/api";
import { buildReplaceAllEdits, buildReplaceEdit, computeMatches, type LineReader } from "../editor/find";
import { comparePositions } from "../editor/positionTransform";
import type { CoreDocument } from "../buffer/document";
import { createInitialFindState, type FindState } from "./editorState";
import type { EditorSessionService } from "./editorSession";

/** Dependencies for {@link createFindService}. Narrowed to a `Pick` (matches
 * `editor/inputRouter.ts`'s/`api/editorNamespace.ts`'s own dependency
 * narrowing) so a test can inject a minimal fake instead of a whole real
 * `EditorSessionService`. */
export interface FindServiceDeps {
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "getState" | "setState" | "onDidChange">;
}

/** The find service's public shape — the same 9 actions `tecode.editor.
 * find` (`@tecode/api`'s `FindNamespace`) exposes to extensions, since
 * `api/create.ts` wires this service's methods straight through as that
 * namespace (this module's TSDoc). */
export interface FindService {
  open(): void;
  close(): void;
  setQuery(query: string): void;
  setReplaceQuery(query: string): void;
  toggleCaseSensitive(): void;
  next(): void;
  previous(): void;
  replaceCurrent(): void;
  replaceAll(): void;
  /** Fires after any state change this service makes (this module's TSDoc)
   * — same "just re-render, don't diff what changed" shape as
   * `EditorSessionService.onDidChange`. Note `editorSession.setState` ALSO
   * fires `editorSession.onDidChange` for the exact same change — a
   * `findWidget.tsx` that already subscribes to the session does not need
   * this one too; it exists for a caller that wants to observe find
   * specifically without subscribing to every other session change. */
  onDidChange: Event<void>;
  /** Unsubscribe from `editorSession` and the currently-tracked document,
   * and clear all `onDidChange` listeners. Idempotent. */
  dispose(): void;
}

/** Cycle `index` around a ring of `length` entries (this module's TSDoc's
 * "Index policy") — `next`/`previous`'s wraparound. `length === 0` has no
 * valid index at all. */
function wrapIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return ((index % length) + length) % length;
}

/** Re-clamp a previously-active index onto a freshly recomputed match list
 * after a BUFFER change (this module's TSDoc's "Index policy") — a
 * previously-unset (`-1`) index jumps to the first match; an in-range index
 * is taken modulo the new length (never negative, since it was already
 * `>= 0`), which is what gives `replaceCurrent` its "advance" behavior for
 * free. */
function reclampIndex(previousIndex: number, length: number): number {
  if (length === 0) return -1;
  if (previousIndex < 0) return 0;
  return previousIndex % length;
}

/** The nearest match at/after `cursor` (search-cursor semantics, this
 * module's TSDoc's "Index policy"), wrapping to the first match if none
 * qualify. `-1` for an empty `matches`. */
function reanchorIndex(matches: readonly Range[], cursor: Position): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => comparePositions(match.start, cursor) >= 0);
  return index === -1 ? 0 : index;
}

/** Build an {@link FindService} (Req 11.1, design.md §13). */
export function createFindService(deps: FindServiceDeps): FindService {
  const { editorSession } = deps;
  const listeners = new Set<Listener<void>>();
  let disposed = false;
  let trackedDocument: CoreDocument | undefined;
  let documentSub: Disposable | undefined;

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches every
    // other `onDidChange` in this codebase (`editorSession.ts`,
    // `document.ts`, `context.ts`).
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures.
      }
    }
  }

  function reader(document: CoreDocument): LineReader {
    return { getLine: (line) => document.getLine(line), lineCount: document.lineCount };
  }

  function readFind(document: CoreDocument): FindState {
    return editorSession.getState(document.uri).find ?? createInitialFindState();
  }

  /** Replace `document`'s `find` state wholesale and notify (this module's
   * shared write path — every action below funnels through this). */
  function writeFind(document: CoreDocument, find: FindState): void {
    const state = editorSession.getState(document.uri);
    editorSession.setState(document.uri, { ...state, find });
    fireChange();
  }

  /**
   * Recompute `document`'s matches from its live current text (this
   * module's TSDoc's "Live match updates"). `reanchor` selects which of the
   * two index policies applies: `true` for a query/case-sensitivity change
   * (search-cursor re-anchor), `false` for a buffer change (re-clamp/
   * advance). A no-op if `document` has no `find` state at all yet (no
   * widget has ever been opened for it — nothing to recompute).
   */
  function recompute(document: CoreDocument, reanchor: boolean): void {
    const state = editorSession.getState(document.uri);
    const find = state.find;
    if (!find) return;
    const matches = computeMatches(reader(document), find.query, find.caseSensitive);
    const activeMatchIndex = reanchor
      ? reanchorIndex(matches, state.selections[0]?.active ?? { line: 0, character: 0 })
      : reclampIndex(find.activeMatchIndex, matches.length);
    editorSession.setState(document.uri, { ...state, find: { ...find, matches, activeMatchIndex } });
    fireChange();
  }

  /** Point the live-recompute subscription (this module's TSDoc) at
   * `document`, detaching from whatever it was previously attached to.
   * A no-op if `document` is already the tracked one (including
   * `undefined === undefined`, when there is still no active document).
   *
   * **Catch-up recompute on switch-in** (CodeRabbit finding on PR #59): the
   * live-recompute subscription only runs while `document` IS the tracked
   * (active) one — an edit made to a document while it is inactive (e.g.
   * another extension calling `document.applyEdits` directly, or a second
   * editor view onto the same buffer) reaches no subscription at all, so
   * that document's `FindState.matches` goes stale. Simply re-subscribing
   * here is not enough: `matches` still holds whatever was computed before
   * the document went inactive, and `replaceCurrent`/`replaceAll` would
   * replace text at those STALE ranges against the document's now-current
   * content. Recomputing immediately on switch-in — via the same
   * buffer-change reclamp policy `document.onDidChange` itself drives
   * (`reanchor: false`, this module's TSDoc's "Index policy") — closes
   * that gap: `matches`/`activeMatchIndex` are always fresh by the time any
   * caller can act on this newly-active document, whether or not it was
   * ever edited while inactive. `recompute` is already a no-op when
   * `document` has no `FindState` at all (nothing to catch up), so this
   * costs nothing for a document find was never opened on.
   */
  function retrackDocument(document: CoreDocument | undefined): void {
    if (document === trackedDocument) return;
    documentSub?.dispose();
    documentSub = undefined;
    trackedDocument = document;
    if (document) {
      documentSub = document.onDidChange(() => recompute(document, false));
      // `trackedDocument` is already reassigned above, so the
      // `editorSession.onDidChange` this call to `recompute`/`writeFind`
      // triggers (via `setState`) re-enters `retrackDocument` with the SAME
      // `document` and hits the `document === trackedDocument` early return
      // instead of looping.
      recompute(document, false);
    }
  }

  // Cover a caller built after a document was already active, and keep
  // retracking as the active document changes (Task 2.2's
  // `editorSession.onDidChange` — fires on every active-document switch,
  // among other things).
  retrackDocument(editorSession.getActiveDocument());
  const sessionSub = editorSession.onDidChange(() => {
    if (!disposed) retrackDocument(editorSession.getActiveDocument());
  });

  function open(): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (find.isOpen) return;
    writeFind(document, { ...find, isOpen: true });
  }

  function close(): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (!find.isOpen) return;
    writeFind(document, { ...find, isOpen: false });
  }

  function setQuery(query: string): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (find.query === query) return;
    writeFind(document, { ...find, query });
    recompute(document, true);
  }

  function setReplaceQuery(replaceQuery: string): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (find.replaceQuery === replaceQuery) return;
    writeFind(document, { ...find, replaceQuery });
  }

  function toggleCaseSensitive(): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    writeFind(document, { ...find, caseSensitive: !find.caseSensitive });
    recompute(document, true);
  }

  function next(): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (find.matches.length === 0) return;
    writeFind(document, { ...find, activeMatchIndex: wrapIndex(find.activeMatchIndex + 1, find.matches.length) });
  }

  function previous(): void {
    const document = editorSession.getActiveDocument();
    if (!document) return;
    const find = readFind(document);
    if (find.matches.length === 0) return;
    writeFind(document, { ...find, activeMatchIndex: wrapIndex(find.activeMatchIndex - 1, find.matches.length) });
  }

  function replaceCurrent(): void {
    const document = editorSession.getActiveDocument();
    if (!document || document.readonly) return;
    const find = readFind(document);
    const match = find.matches[find.activeMatchIndex];
    if (!match) return;
    // One `applyEdits` call = one undo step (`document.ts`'s own contract,
    // matching `editor/inputRouter.ts`'s own reasoning for why plain
    // typing needs no extra `transaction` wrapper) — no `transaction`
    // needed for a SINGLE edit. This synchronously fires `document.
    // onDidChange`, which `retrackDocument`'s subscription above already
    // catches to recompute `matches`/re-clamp `activeMatchIndex` (this
    // module's TSDoc's "advances" reasoning) before this call returns.
    document.applyEdits([buildReplaceEdit(match, find.replaceQuery)]);
  }

  function replaceAll(): void {
    const document = editorSession.getActiveDocument();
    if (!document || document.readonly) return;
    const find = readFind(document);
    if (find.matches.length === 0) return;
    const edits = buildReplaceAllEdits(find.matches, find.replaceQuery);
    // ONE undo group across every replacement (Req 11.1) — matches
    // `editor-core`'s own `registerLineOp`/`registerEditing` pattern for
    // "one command, one undo step" over a multi-edit batch.
    document.transaction(() => document.applyEdits(edits));
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
    documentSub?.dispose();
    documentSub = undefined;
    sessionSub.dispose();
    listeners.clear();
  }

  return {
    open,
    close,
    setQuery,
    setReplaceQuery,
    toggleCaseSensitive,
    next,
    previous,
    replaceCurrent,
    replaceAll,
    onDidChange,
    dispose,
  };
}
