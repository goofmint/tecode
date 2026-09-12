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

import type { Event, FoldRange, Uri } from "@tecode/api";
import type { FoldService } from "../languages/foldService";
import type { EditorSessionService } from "./editorSession";
import { foldStartingAt, hasFold, innermostFoldAt } from "./foldMapping";

/** A permanently-empty ranges array, shared so "nothing is collapsed here"
 * never allocates and always compares equal by reference. */
const NO_FOLDS: readonly FoldRange[] = [];

/** Dependencies for {@link createFoldController}. */
export interface FoldControllerDeps {
  /** Where the collapsed set lives (`EditorState.collapsedFolds`).
   * Narrowed to a `Pick`, matching `findService.ts`'s own dependency
   * narrowing, so a test can inject a minimal fake. */
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "getState" | "setState">;
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
}

/** Build a {@link FoldController} (Issue #150). */
export function createFoldController(deps: FoldControllerDeps): FoldController {
  const { editorSession, foldService } = deps;

  function getCollapsedFolds(uri: Uri): readonly FoldRange[] {
    return editorSession.getState(uri).collapsedFolds ?? NO_FOLDS;
  }

  function writeCollapsed(uri: Uri, collapsedFolds: FoldRange[]): void {
    const state = editorSession.getState(uri);
    editorSession.setState(uri, { ...state, collapsedFolds });
  }

  /** The innermost COLLAPSED region containing `line` — what an "unfold
   * here" gesture expands. Resolved against the collapsed set rather than
   * the foldable set so it keeps working for a region the grammar no
   * longer reports (a mid-edit reparse), which would otherwise leave rows
   * hidden with no way to get them back. */
  function collapsedFoldAt(uri: Uri, line: number): FoldRange | undefined {
    return innermostFoldAt(getCollapsedFolds(uri), line);
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
  };
}
