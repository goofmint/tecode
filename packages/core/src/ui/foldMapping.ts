/**
 * Pure "display line <-> document line" math for code folding (Issue #150)
 * — the layer that lets `EditorView` keep drawing a simple, contiguous
 * window of rows even though the document underneath now has holes in it.
 *
 * Before folding, the two coordinate spaces were identical and the whole
 * editor could (and did) treat `document line == row on screen`
 * everywhere: `viewport.ts`'s `computeVisibleLineRange`/`revealLine`, the
 * row loop, the hardware-cursor row math. Rather than teach each of those
 * about folds, this module converts at the boundary: `EditorView` does its
 * scroll/viewport arithmetic entirely in DISPLAY lines (so `viewport.ts`
 * stays exactly the pure line-count arithmetic it always was, untouched),
 * and resolves each display row back to a document line here.
 *
 * **The identity fast path is the important one.** With nothing collapsed
 * — every document, every keystroke, until the user actually folds
 * something — {@link createFoldMapping} returns a shared, allocation-free
 * identity mapping whose `toDocumentLine`/`toDisplayLine` are `x => x`.
 * Only a genuinely folded document pays for the two index arrays.
 *
 * No UI dependency: every function here is deterministic arithmetic over
 * numbers and {@link FoldRange}s, unit-testable without a renderer, matching
 * `viewport.ts`/`cursorPosition.ts`'s "keep pure functions pure" house
 * convention.
 */

import type { FoldRange } from "@tecode/api";

/** The projection between a document's lines and the rows actually drawn
 * for it, for one particular set of collapsed regions. */
export interface FoldMapping {
  /** How many rows the document occupies on screen — `lineCount` when
   * nothing is collapsed, and always at least 1. */
  visibleLineCount: number;
  /** The document line drawn at display row `displayLine`. Clamped into
   * `[0, lineCount - 1]` for an out-of-range row, so a caller never gets a
   * line index `LineBuffer.getLine` would throw a `RangeError` for. */
  toDocumentLine(displayLine: number): number;
  /** The display row `documentLine` is drawn at. For a HIDDEN line, this
   * is the row of the collapsed region that swallowed it (its `startLine`,
   * which always stays visible) — so "scroll to this line" reveals the
   * fold that contains it rather than an empty row. */
  toDisplayLine(documentLine: number): number;
  /** Whether `documentLine` is hidden inside a collapsed region. A
   * region's own `startLine` is never hidden. */
  isLineHidden(documentLine: number): boolean;
}

/** The identity projection, shared across every unfolded document (this
 * module's TSDoc's "identity fast path") — `visibleLineCount` is the only
 * per-document part, so the closures are rebuilt but nothing is indexed. */
function createIdentityMapping(lineCount: number): FoldMapping {
  const maxLine = Math.max(0, lineCount - 1);
  const clamp = (line: number): number => Math.max(0, Math.min(Math.trunc(line) || 0, maxLine));
  return {
    visibleLineCount: Math.max(1, lineCount),
    toDocumentLine: clamp,
    toDisplayLine: clamp,
    isLineHidden: () => false,
  };
}

/**
 * Build the {@link FoldMapping} for a `lineCount`-line document with
 * `collapsedFolds` collapsed (`EditorState.collapsedFolds`).
 *
 * Ranges may overlap, nest, repeat, or point outside the document (a
 * collapsed fold surviving an edit that shrank the buffer) — all of that
 * is normalized here rather than at every call site: each range hides
 * `startLine + 1 ..= endLine`, clamped into the document, and a range
 * whose start is already out of bounds hides nothing.
 */
export function createFoldMapping(
  collapsedFolds: readonly FoldRange[] | undefined,
  lineCount: number,
): FoldMapping {
  const total = Math.max(1, Math.trunc(lineCount) || 1);
  if (!collapsedFolds || collapsedFolds.length === 0) return createIdentityMapping(total);

  const hidden = new Uint8Array(total);
  let anyHidden = false;
  for (const fold of collapsedFolds) {
    const start = Math.trunc(fold.startLine) || 0;
    if (start < 0 || start >= total) continue;
    const end = Math.min(Math.trunc(fold.endLine) || 0, total - 1);
    for (let line = start + 1; line <= end; line++) {
      if (hidden[line] === 1) continue;
      hidden[line] = 1;
      anyHidden = true;
    }
  }
  if (!anyHidden) return createIdentityMapping(total);

  // `displayToDocument[d]` is the document line drawn at row `d`;
  // `documentToDisplay[l]` is the row line `l` is drawn at — for a hidden
  // line, the row of the nearest preceding VISIBLE line, which is exactly
  // the enclosing collapsed region's still-visible `startLine` (a hidden
  // line always has one above it, since line 0 can never be hidden: every
  // range hides only lines strictly after its own start).
  const displayToDocument: number[] = [];
  const documentToDisplay = new Int32Array(total);
  for (let line = 0; line < total; line++) {
    if (hidden[line] === 1) {
      documentToDisplay[line] = displayToDocument.length - 1;
      continue;
    }
    documentToDisplay[line] = displayToDocument.length;
    displayToDocument.push(line);
  }

  const maxDisplay = displayToDocument.length - 1;
  const maxLine = total - 1;
  return {
    visibleLineCount: displayToDocument.length,
    toDocumentLine(displayLine: number): number {
      const clamped = Math.max(0, Math.min(Math.trunc(displayLine) || 0, maxDisplay));
      return displayToDocument[clamped]!;
    },
    toDisplayLine(documentLine: number): number {
      const clamped = Math.max(0, Math.min(Math.trunc(documentLine) || 0, maxLine));
      return documentToDisplay[clamped]!;
    },
    isLineHidden(documentLine: number): boolean {
      if (documentLine < 0 || documentLine > maxLine) return false;
      return hidden[Math.trunc(documentLine) || 0] === 1;
    },
  };
}

/** Whether `range` covers `line` (its header line included). */
export function foldContainsLine(range: FoldRange, line: number): boolean {
  return line >= range.startLine && line <= range.endLine;
}

/** Whether `ranges` already holds a range with the exact same span as
 * `range` — folds are identified by their span, not by object identity
 * (`FoldService` hands out fresh objects on every reparse). */
export function hasFold(ranges: readonly FoldRange[], range: FoldRange): boolean {
  return ranges.some((r) => r.startLine === range.startLine && r.endLine === range.endLine);
}

/**
 * The INNERMOST range in `ranges` containing `line` — the one a "fold
 * here"/"unfold here" gesture acts on, matching what every editor means by
 * folding at the cursor. Innermost is resolved as "latest start, then
 * earliest end"; `undefined` when no range contains `line`.
 *
 * A range STARTING at `line` always wins over one that merely contains it,
 * which is what makes a gutter click on a header line fold that header's
 * own region rather than its parent.
 */
export function innermostFoldAt(
  ranges: readonly FoldRange[],
  line: number,
): FoldRange | undefined {
  let best: FoldRange | undefined;
  for (const range of ranges) {
    if (!foldContainsLine(range, line)) continue;
    if (!best) {
      best = range;
      continue;
    }
    if (range.startLine > best.startLine) best = range;
    else if (range.startLine === best.startLine && range.endLine < best.endLine) best = range;
  }
  return best;
}

/** The range in `ranges` that STARTS at `line`, if any — the fold a gutter
 * marker on that row represents. The widest one wins when several share a
 * start line, so the marker and a click on it always mean the same region. */
export function foldStartingAt(ranges: readonly FoldRange[], line: number): FoldRange | undefined {
  let best: FoldRange | undefined;
  for (const range of ranges) {
    if (range.startLine !== line) continue;
    if (!best || range.endLine > best.endLine) best = range;
  }
  return best;
}

/** Drop every collapsed fold that no longer fits a `lineCount`-line
 * document (Issue #119's post-reload clamping policy, applied to folds):
 * a reload/undo that shrinks the buffer must not leave a fold hiding rows
 * past its end. A fold whose END overruns the document is kept, truncated
 * to the last line, as long as it still hides at least one line. Returns
 * the ORIGINAL array when nothing needed changing, so a caller can compare
 * references to decide whether anything happened. */
export function clampFoldsToDocument(
  folds: readonly FoldRange[],
  lineCount: number,
): readonly FoldRange[] {
  const maxLine = Math.max(0, Math.trunc(lineCount) - 1);
  const clamped: FoldRange[] = [];
  let changed = false;
  for (const fold of folds) {
    if (fold.startLine < 0 || fold.startLine >= maxLine) {
      changed = true;
      continue;
    }
    if (fold.endLine > maxLine) {
      clamped.push({ startLine: fold.startLine, endLine: maxLine });
      changed = true;
      continue;
    }
    clamped.push(fold);
  }
  return changed ? clamped : folds;
}
