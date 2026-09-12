/**
 * `FoldController` (Issue #150) — the one place that turns a fold GESTURE
 * ("fold here", "unfold all", a gutter click) into an
 * `EditorState.collapsedFolds` write, joining the two halves folding needs:
 * `languages/foldService.ts` (which regions of this document CAN fold) and
 * `ui/editorSession.ts` (which of them this tab currently has collapsed).
 *
 * Modeled on `ui/findService.ts`: a plain factory-built service around an
 * `EditorSessionService`, exposing its own `session` reference so a
 * composition root can verify that everything reading the active editor is
 * reading the SAME session (`api/create.ts` does exactly that check for
 * `FindService`, and does it here too). Every mutation goes through
 * `editorSession.setState`, so a fold toggle re-renders `Shell` through the
 * identical path a cursor move already does — there is no second,
 * folding-specific notification channel.
 *
 * Both the `tecode.editor.folds` API namespace (`api/foldNamespace.ts`) and
 * `EditorView`'s gutter click land here, so a keyboard command and a mouse
 * click can never drift apart in what they mean by "the fold at this line".
 */

import type {
  Disposable,
  DocumentChangeEvent,
  Event,
  FoldRange,
  Selection,
  TextEdit,
  Uri,
} from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import { comparePositions } from "../editor/positionTransform";
import type { FoldService } from "../languages/foldService";
import type { EditorSessionService } from "./editorSession";
import { foldStartingAt, hasFold, innermostFoldAt } from "./foldMapping";

/** A permanently-empty ranges array, shared so "nothing is collapsed here"
 * never allocates and always compares equal by reference. */
const NO_FOLDS: readonly FoldRange[] = [];

/**
 * The line `line` is actually DRAWN at once `folds` are collapsed: `line`
 * itself when it is visible, otherwise the header of the region hiding it
 * — walked outward, so a line buried in nested regions resolves to the
 * outermost still-visible header rather than to another hidden one.
 *
 * Each pass can only move strictly UP (a region's header always sits above
 * the lines it hides), so `folds.length` passes is a hard upper bound —
 * even a pathological collapsed set (overlapping, repeated, out of order)
 * terminates.
 */
function visibleLineFor(folds: readonly FoldRange[], line: number): number {
  let current = line;
  for (let pass = 0; pass < folds.length; pass++) {
    const hiding = folds.find((fold) => current > fold.startLine && current <= fold.endLine);
    if (!hiding) return current;
    current = hiding.startLine;
  }
  return current;
}

/**
 * Pull every caret that `folds` would hide up onto the header of the region
 * hiding it (CodeRabbit, PR #155). Folding at the cursor otherwise leaves
 * the caret on a line that is no longer drawn: `EditorView` hides the
 * hardware cursor entirely, and the next Up/Down press moves relative to an
 * invisible line — the caret appears to teleport. Moving it to the fold
 * header is what every editor does, and it keeps `EditorState.selections`
 * describing a position the user can actually see.
 *
 * A lifted selection collapses to a plain cursor at column 0: this module
 * has no document reader to clamp a preserved column against, and a
 * selection whose active end just disappeared into a fold has no meaningful
 * extent left anyway. Selections that stay visible are returned untouched,
 * and the ORIGINAL array is returned when nothing moved, so a fold that
 * cannot affect the caret writes no new selection identity at all.
 */
function liftSelectionsOutOfFolds(
  selections: readonly Selection[],
  folds: readonly FoldRange[],
): Selection[] | undefined {
  let changed = false;
  const lifted = selections.map((selection): Selection => {
    const line = visibleLineFor(folds, selection.active.line);
    if (line === selection.active.line) return selection;
    changed = true;
    const position = { line, character: 0 };
    return { start: position, end: position, anchor: position, active: position };
  });
  return changed ? lifted : undefined;
}

/** How many lines `edit` adds (positive) or removes (negative). `newText`'s
 * own line count minus the line span it replaces — the standard line-delta
 * of a `TextEdit`, computed the same way `editor/positionTransform.ts`
 * reasons about edits. */
function lineDeltaOf(edit: TextEdit): number {
  const insertedLineBreaks = edit.newText.split("\n").length - 1;
  const removedLineBreaks = edit.range.end.line - edit.range.start.line;
  return insertedLineBreaks - removedLineBreaks;
}

/**
 * Move `fold` to where it sits after `edit` is applied, or `undefined` when
 * the edit invalidated it (CodeRabbit, PR #155 — a collapsed fold stores
 * absolute line numbers, so an edit ABOVE it would otherwise leave it
 * hiding the wrong rows).
 *
 * Four cases, by where the edit falls relative to the region:
 *
 * - entirely BELOW the region (`edit.start > endLine`): nothing moves.
 * - entirely ABOVE it (`edit.end < startLine`): the whole region shifts by
 *   the edit's line delta.
 * - strictly INSIDE it (below the header, at or above the end): only
 *   `endLine` moves — the header itself is untouched, which is what keeps a
 *   fold anchored while its body is edited.
 * - anything else — an edit STRADDLING the header or the end line — is
 *   dropped. The region's own boundaries are exactly what such an edit puts
 *   in doubt (deleting a function's signature line, pasting over its
 *   closing brace), and `FoldService` re-runs its query on this very same
 *   edit, so an accurate replacement range is available immediately.
 *   Dropping REVEALS lines; the alternative — guessing — risks hiding the
 *   wrong ones, which is the failure mode a user cannot undo by scrolling.
 *
 * A region that ends up degenerate (nothing left to hide) is dropped too.
 */
function remapFoldThroughEdit(fold: FoldRange, edit: TextEdit): FoldRange | undefined {
  const editStart = edit.range.start.line;
  const editEnd = edit.range.end.line;
  const delta = lineDeltaOf(edit);

  if (editStart > fold.endLine) return fold;
  if (delta === 0 && editStart >= fold.startLine && editEnd <= fold.endLine) return fold;
  if (editEnd < fold.startLine) {
    return { startLine: fold.startLine + delta, endLine: fold.endLine + delta };
  }
  if (editStart > fold.startLine && editEnd <= fold.endLine) {
    const endLine = fold.endLine + delta;
    return endLine > fold.startLine ? { startLine: fold.startLine, endLine } : undefined;
  }
  return undefined;
}

/**
 * Move every collapsed region through a whole `DocumentChangeEvent`'s
 * batch of edits. The batch is walked BOTTOM-UP (descending start
 * position) — the same order `document.ts`'s `buffer.applyEdits` and
 * `languages/highlightService.ts`'s `handleChange` both use, and what makes
 * every edit's pre-batch coordinates valid to apply in sequence.
 *
 * Returns the ORIGINAL array when every region came through unmoved, so the
 * caller can skip its `setState` entirely on an edit that changed no fold.
 */
function remapFoldsThroughEdits(
  folds: readonly FoldRange[],
  edits: readonly TextEdit[],
): readonly FoldRange[] {
  const sorted = Array.from(edits).sort((a, b) => comparePositions(b.range.start, a.range.start));
  let changed = false;
  const remapped: FoldRange[] = [];
  for (const fold of folds) {
    let current: FoldRange | undefined = fold;
    for (const edit of sorted) {
      current = remapFoldThroughEdit(current, edit);
      if (!current) break;
    }
    if (!current) {
      changed = true;
      continue;
    }
    if (current.startLine !== fold.startLine || current.endLine !== fold.endLine) changed = true;
    remapped.push(current);
  }
  return changed ? remapped : folds;
}

/** Dependencies for {@link createFoldController}. */
export interface FoldControllerDeps {
  /** Where the collapsed set lives (`EditorState.collapsedFolds`).
   * Narrowed to a `Pick`, matching `findService.ts`'s own dependency
   * narrowing, so a test can inject a minimal fake. */
  editorSession: Pick<
    EditorSessionService,
    "getActiveDocument" | "getState" | "setState" | "onDidChange"
  >;
  /** Where the foldable regions come from (`languages/foldService.ts`). */
  foldService: Pick<FoldService, "getFoldRanges" | "onDidChange">;
}

/** The fold controller's public surface (Issue #150). Every method takes an
 * explicit `uri` rather than assuming the active document, so
 * `EditorView` — which renders one specific document — and the
 * active-editor-scoped API namespace can share one implementation. */
export interface FoldController {
  /** The `EditorSessionService` this controller writes through — exposed
   * purely so `api/create.ts` can assert it is the same instance every
   * other active-editor-scoped namespace reads (the identity check
   * `FindService.session` already exists for). */
  session: FoldControllerDeps["editorSession"];
  /** Every foldable region of `uri`, in document order (a straight
   * passthrough to `FoldService.getFoldRanges`, including its
   * reference-stability contract). */
  getFoldRanges(uri: Uri): readonly FoldRange[];
  /** The regions currently collapsed in `uri`'s tab. */
  getCollapsedFolds(uri: Uri): readonly FoldRange[];
  /** Fires whenever `uri`'s FOLDABLE regions change — `FoldService.
   * onDidChange`, passed through. Collapsing/expanding fires
   * `EditorSessionService.onDidChange` instead. */
  onDidChange: Event<void>;
  /** Collapse the innermost foldable region containing `line`. A no-op
   * when none contains it, or when it is already collapsed. */
  foldAt(uri: Uri, line: number): void;
  /** Expand the innermost COLLAPSED region containing `line`. A no-op when
   * none does. */
  unfoldAt(uri: Uri, line: number): void;
  /** {@link unfoldAt} when a collapsed region contains `line`, else
   * {@link foldAt} — the gutter click and `editor.action.toggleFold`. */
  toggleAt(uri: Uri, line: number): void;
  /** Collapse every foldable region of `uri`. */
  foldAll(uri: Uri): void;
  /** Expand everything collapsed in `uri`'s tab. */
  unfoldAll(uri: Uri): void;
  /** Whether `line` is currently drawn (`false` only when hidden inside a
   * collapsed region). */
  isLineVisible(uri: Uri, line: number): boolean;
  /** Unsubscribe from `editorSession` and the currently-tracked document.
   * Idempotent — same contract as `FindService.dispose`. */
  dispose(): void;
}

/** Build a {@link FoldController} (Issue #150). */
export function createFoldController(deps: FoldControllerDeps): FoldController {
  const { editorSession, foldService } = deps;

  // The single tracked document whose edits this controller remaps folds
  // through (`retrackDocument` below), mirroring `findService.ts`'s own
  // `trackedDocument`/`documentSub` pair.
  let trackedDocument: CoreDocument | undefined;
  let documentSub: Disposable | undefined;
  let disposed = false;

  function getCollapsedFolds(uri: Uri): readonly FoldRange[] {
    return editorSession.getState(uri).collapsedFolds ?? NO_FOLDS;
  }

  /** Write a new collapsed set, pulling any caret the new set would hide up
   * onto its fold's header in the SAME `setState` ({@link liftSelectionsOutOfFolds})
   * — one state write, so a fold can never be observed with the caret still
   * pointing inside it. */
  function writeCollapsed(uri: Uri, collapsedFolds: FoldRange[]): void {
    const state = editorSession.getState(uri);
    const lifted = liftSelectionsOutOfFolds(state.selections, collapsedFolds);
    editorSession.setState(uri, {
      ...state,
      collapsedFolds,
      ...(lifted ? { selections: lifted } : {}),
    });
  }

  /** The COLLAPSED region an "unfold here" gesture expands. Resolved
   * against the collapsed set rather than the foldable set so it keeps
   * working for a region the grammar no longer reports (a mid-edit
   * reparse), which would otherwise leave rows hidden with no way to get
   * them back.
   *
   * Uses the EXACT same "a region starting on this line wins, widest
   * first" rule as {@link foldAt} (CodeRabbit, PR #155): with `{4, 10}` and
   * `{4, 6}` both collapsed, picking the innermost would remove `{4, 6}`
   * on a click at line 4 and leave `{4, 10}` still hiding the very same
   * rows — a toggle that visibly does nothing. Matching `foldAt`'s choice
   * makes fold and unfold exact inverses at every line. */
  function collapsedFoldAt(uri: Uri, line: number): FoldRange | undefined {
    const collapsed = getCollapsedFolds(uri);
    return foldStartingAt(collapsed, line) ?? innermostFoldAt(collapsed, line);
  }

  function foldAt(uri: Uri, line: number): void {
    const collapsed = getCollapsedFolds(uri);
    const ranges = foldService.getFoldRanges(uri);
    // A region starting exactly on `line` is what a gutter marker on that
    // row means, so it wins over any parent that merely contains the line.
    const candidate = foldStartingAt(ranges, line) ?? innermostFoldAt(ranges, line);
    if (!candidate || hasFold(collapsed, candidate)) return;
    writeCollapsed(uri, [...collapsed, candidate]);
  }

  function unfoldAt(uri: Uri, line: number): void {
    const collapsed = getCollapsedFolds(uri);
    const target = collapsedFoldAt(uri, line);
    if (!target) return;
    writeCollapsed(
      uri,
      collapsed.filter((r) => !(r.startLine === target.startLine && r.endLine === target.endLine)),
    );
  }

  function toggleAt(uri: Uri, line: number): void {
    if (collapsedFoldAt(uri, line)) unfoldAt(uri, line);
    else foldAt(uri, line);
  }

  function foldAll(uri: Uri): void {
    const ranges = foldService.getFoldRanges(uri);
    if (ranges.length === 0) return;
    writeCollapsed(
      uri,
      ranges.map((r) => ({ startLine: r.startLine, endLine: r.endLine })),
    );
  }

  function unfoldAll(uri: Uri): void {
    if (getCollapsedFolds(uri).length === 0) return;
    writeCollapsed(uri, []);
  }

  function isLineVisible(uri: Uri, line: number): boolean {
    for (const fold of getCollapsedFolds(uri)) {
      if (line > fold.startLine && line <= fold.endLine) return false;
    }
    return true;
  }

  /**
   * Keep this document's COLLAPSED regions anchored across its own edits
   * (CodeRabbit, PR #155). `FoldService` re-runs its query on every edit and
   * so always reports accurate FOLDABLE ranges, but `collapsedFolds` stores
   * absolute line numbers that nothing was moving: collapsing `{4, 10}` and
   * then inserting a line at the top left the fold hiding lines 5..10 while
   * the region itself had moved to `{5, 11}` — the wrong rows hidden, and a
   * stray trailing line shown.
   *
   * The zero-collapsed-folds early return is load-bearing, not just an
   * optimization: it is what keeps this off the typing hot path entirely
   * (Req 13.1) for the overwhelmingly common case of a document with
   * nothing folded — no remap work, and no `setState` (so no re-render)
   * either. The same "only write when something actually changed" guard
   * applies when folds ARE present but the edit missed all of them.
   */
  function handleDocumentChange(document: CoreDocument, event: DocumentChangeEvent): void {
    const collapsed = getCollapsedFolds(document.uri);
    if (collapsed.length === 0) return;
    const remapped = remapFoldsThroughEdits(collapsed, event.edits);
    if (remapped === collapsed) return;
    writeCollapsed(document.uri, Array.from(remapped));
  }

  /** Point the remap subscription at `document`, detaching from whatever it
   * was attached to before — the same single-tracked-document shape (and
   * the same reentrancy reasoning) as `findService.ts`'s own
   * `retrackDocument`: `writeCollapsed` fires `editorSession.onDidChange`,
   * which re-enters here with the SAME document and hits the early return
   * rather than looping.
   *
   * Unlike find, there is no catch-up pass on switch-in: an edit made to a
   * document while it was inactive is not remapped. Re-tracking cannot fix
   * that either — the edits have already been applied and their deltas are
   * gone — and the consequence is bounded (a stale fold hides shifted rows
   * until it is toggled), where find's equivalent gap would have made
   * `replaceAll` write at stale ranges. */
  function retrackDocument(document: CoreDocument | undefined): void {
    if (document === trackedDocument) return;
    documentSub?.dispose();
    documentSub = undefined;
    trackedDocument = document;
    if (document) {
      documentSub = document.onDidChange((event) => handleDocumentChange(document, event));
    }
  }

  retrackDocument(editorSession.getActiveDocument());
  const sessionSub = editorSession.onDidChange(() => {
    if (!disposed) retrackDocument(editorSession.getActiveDocument());
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    sessionSub.dispose();
    documentSub?.dispose();
    documentSub = undefined;
    trackedDocument = undefined;
  }

  return {
    session: editorSession,
    getFoldRanges: (uri) => foldService.getFoldRanges(uri),
    getCollapsedFolds,
    onDidChange: foldService.onDidChange,
    foldAt,
    unfoldAt,
    toggleAt,
    foldAll,
    unfoldAll,
    isLineVisible,
    dispose,
  };
}
