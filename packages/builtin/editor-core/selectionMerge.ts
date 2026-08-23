/**
 * `mergeSelections`: collapse overlapping/adjacent selections into one
 * after a multi-cursor movement or selection command (Req 6.6, 11.1's "all
 * handlers map over `selections` and merge overlaps"; design.md §13). Two
 * cursors that land on the same point, or two selections whose ranges now
 * touch or overlap, become a single selection — matching how every
 * mainstream multi-cursor editor reconciles cursors after a move.
 */

import type { Position, Selection } from "@tecode/api";
import { comparePositions } from "./positionTransform";

/** Whether `selection`'s caret is at (or ahead of) its anchor — i.e. it was
 * extended left-to-right. A collapsed selection (`anchor === active`)
 * counts as forward, which only matters for tie-breaking when merging with
 * a genuinely-directional neighbor. */
function isForward(selection: Selection): boolean {
  return comparePositions(selection.anchor, selection.active) <= 0;
}

/** Merge `a` and `b` (already known to overlap or touch) into one
 * selection spanning both ranges. Direction (which end is `anchor` vs
 * `active`) is preserved when both inputs agree; a mixed-direction merge
 * (one forward, one backward) defaults to forward — an arbitrary but
 * deterministic tie-break, since there is no single correct answer once
 * the two selections disagree. */
function mergeTwo(a: Selection, b: Selection): Selection {
  const start = comparePositions(a.start, b.start) <= 0 ? a.start : b.start;
  const end = comparePositions(a.end, b.end) >= 0 ? a.end : b.end;
  const forward = isForward(a) && isForward(b) ? true : !isForward(a) && !isForward(b) ? false : true;
  return forward
    ? { start, end, anchor: start, active: end }
    : { start, end, anchor: end, active: start };
}

/**
 * Sort `selections` by position and merge any pair that overlaps or
 * touches (`next.start <= previous.end`) — including two collapsed
 * cursors landing on the exact same point. Always returns at least one
 * entry for a non-empty input (a document's selections are never
 * empty — `EditorState`'s own invariant, `@tecode/core`'s
 * `ui/editorState.ts`), and returns entries in ascending position order.
 */
export function mergeSelections(selections: readonly Selection[]): Selection[] {
  if (selections.length <= 1) return [...selections];

  const sorted = [...selections].sort((a, b) => comparePositions(a.start, b.start));
  const merged: Selection[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (comparePositions(current.start, last.end) <= 0) {
      merged[merged.length - 1] = mergeTwo(last, current);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/** Build a collapsed selection (cursor) at `position` — a tiny shared
 * helper (`movement.ts`/`editing.ts` both need it) kept here since it's
 * this module's own vocabulary (a `Selection` with `start === end ===
 * anchor === active`). */
export function collapsedSelection(position: Position): Selection {
  return { start: position, end: position, anchor: position, active: position };
}
