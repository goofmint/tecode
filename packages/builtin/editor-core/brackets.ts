/**
 * Pure logic for `editor-core`'s bracket auto-close commands (Req 11.1;
 * design.md §6.1, §13; tasks.md's Task 2.4): "insert" (an open bracket with
 * a collapsed cursor inserts the pair, caret between), "type-over" (the
 * closing character typed immediately before its own matching closer just
 * advances past it), and "selection-wrap" (an open bracket typed over a
 * non-empty selection wraps it). No `@tecode/core` import (the ESLint
 * layering rule); reads through a {@link LineReader}.
 *
 * **Why these are commands, not a pre-insert hook**: design.md §6.1's
 * pipeline has no "before insert" seam — a bound keystroke is either fully
 * consumed by the keymap layer or falls through whole to plain typing
 * (`editor/inputRouter.ts`, Task 2.2). `index.ts`'s manifest binds each
 * bracket/quote character directly to one of these commands, so the
 * keymap layer consumes the keystroke BEFORE the plain-typing fallthrough
 * ever sees it — the command itself is therefore responsible for the
 * "plain insert" case too (when the language has no bracket pairs
 * registered, `pairs` is `[]` and every keystroke degrades to a bare
 * insert, exactly what fallthrough would have done anyway).
 */

import type { BracketPair, Selection, TextEdit } from "@tecode/api";
import type { LineReader } from "./movement";
import { collapsedSelection } from "./selectionMerge";
import { comparePositions, dropOverlapping, transformPosition } from "./positionTransform";

/** Whether `selection` is a collapsed cursor (no selected range). */
function isCollapsed(selection: Selection): boolean {
  return comparePositions(selection.start, selection.end) === 0;
}

/**
 * One selection's outcome for one typed bracket/quote character `ch`,
 * computed independently of every other cursor: `edits` are the REAL edits
 * it contributes (0, 1, or 2) to apply to the document, and `resolve` lazily
 * recomputes this outcome's final selection once {@link buildBracketEditBatch}
 * knows which edits from every OTHER surviving cursor also apply this
 * keystroke (`otherKeptEdits` — this outcome's own `edits` already
 * excluded).
 *
 * A single-cursor keystroke never has any `otherKeptEdits`, so `resolve([])`
 * always reduces to exactly the position this outcome would report on its
 * own — `resolve` is not an alternative computation, it is the SAME
 * per-case math below with one extra ingredient: the same "TRACKING edit(s)"
 * used to place this outcome's own caret, fed into `positionTransform.ts`'s
 * `transformPosition` ALONGSIDE `otherKeptEdits` in one call, exactly the
 * "own `range.end`, transformed through every surviving edit" recipe
 * `editing.ts`'s `buildEditBatch` uses (see that module's TSDoc) — except
 * here the tracking edit is sometimes a fiction (see case 3/4 below) rather
 * than always the real one actually applied, because bracket auto-close's
 * own caret target is not always "after everything this edit inserted" the
 * way plain typing's is.
 *
 * Feeding `otherKeptEdits` through `transformPosition` this way — rather
 * than transforming this outcome's ALREADY-computed local selection through
 * `otherKeptEdits` as a second, separate step — matters: the already-local
 * position has this outcome's own shift baked in, so comparing it against
 * another edit's ORIGINAL (pre-any-edit) position with `transformPosition`
 * (which expects an original-frame input) can misclassify which side of
 * that other edit this cursor ends up on whenever the two edits' points are
 * close together on the same line. Passing the pre-edit reference point
 * (`active`, or `selection.start`/`selection.end` for the wrap case) instead
 * keeps every position `transformPosition` ever sees in one consistent,
 * original frame.
 */
interface BracketOutcome {
  edits: TextEdit[];
  resolve(otherKeptEdits: readonly TextEdit[]): Selection;
}

/**
 * The single-cursor outcome of typing `ch` at `selection` against the
 * active language's `pairs` (this module's TSDoc's three cases, in
 * priority order):
 *
 * 1. Non-collapsed selection + `ch` is a registered OPEN bracket → wrap:
 *    insert `ch` before the selection and its matching close after it,
 *    selection ends up spanning exactly the original (now-shifted) text.
 * 2. Non-collapsed selection + anything else → ordinary "insert replaces
 *    selection, collapse to end" (Req 11.1), same as plain typing.
 * 3. Collapsed cursor, `ch` closes some pair, AND the very next character
 *    is that same closer → type-over: advance past it, no edit.
 * 4. Collapsed cursor, `ch` opens some pair → insert the pair, caret lands
 *    between the two inserted characters.
 * 5. Collapsed cursor, anything else → plain insert of `ch` alone.
 *
 * Every bracket/quote character this module handles is exactly one UTF-16
 * code unit with no line break, so every edit built below is single-line —
 * `resolve`'s cross-cursor combination never has to reason about line
 * deltas, only same-line character shifts.
 *
 * Each case's `resolve` closure captures exactly the TRACKING edit(s) that
 * reproduce this case's own local math when combined with `otherKeptEdits`
 * via `transformPosition`:
 *
 * - Case 1 (wrap): tracks `selection.start` and `selection.end` each
 *   through `[openEdit, ...otherKeptEdits]` — `closeEdit` is deliberately
 *   NOT a tracking edit for either endpoint (it sits exactly at
 *   `selection.end`, and the wrapped selection must land BEFORE the
 *   bracket it just caused to be inserted there, not after it — same
 *   reasoning as the single-cursor case, unaffected by other cursors).
 * - Case 2 (replace selection): tracks `selection.end` through
 *   `[edit, ...otherKeptEdits]` — identical in shape to `editing.ts`'s own
 *   `buildEditBatch` tracking recipe, since this is exactly the same
 *   "insert replaces selection, collapse to end" edit shape.
 * - Case 3 (type-over): no real edit, but the caret still advances by
 *   `ch.length` over the existing closer — tracked with a FICTIONAL
 *   single-character insert edit of `ch`'s own length at `active` (never
 *   applied to the document; `edits` stays `[]`), so it composes with
 *   `otherKeptEdits` exactly like a real same-length insert would.
 * - Case 4 (pair-insert): the real edit inserts `ch + close` (length 2+),
 *   but the caret lands only `ch.length` in, BETWEEN the two inserted
 *   characters — tracked with the same kind of fictional `ch`-length
 *   insert edit as case 3, not the real (longer) one, so the "between the
 *   brackets" placement survives combination with other cursors' edits.
 * - Case 5 (plain insert): tracks `active` through `[edit, ...
 *   otherKeptEdits]` — the real edit already has the right shape (a plain
 *   `ch`-length insert), no fiction needed.
 */
function buildOutcomeForSelection(
  reader: LineReader,
  selection: Selection,
  ch: string,
  pairs: readonly BracketPair[],
): BracketOutcome {
  const opensWith = pairs.find((p) => p.open === ch);
  const closesAny = pairs.some((p) => p.close === ch);

  if (!isCollapsed(selection)) {
    if (!opensWith) {
      // Ordinary "insert replaces selection, collapse to end" (Req
      // 11.1) — identical in shape to `editing.ts`'s `buildInsertEdit`.
      const edit: TextEdit = { range: { start: selection.start, end: selection.end }, newText: ch };
      return {
        edits: [edit],
        resolve: (other) => collapsedSelection(transformPosition(selection.end, [edit, ...other])),
      };
    }
    // Wrap: insert `ch` before the selection and `close` after it.
    const openEdit: TextEdit = { range: { start: selection.start, end: selection.start }, newText: ch };
    const closeEdit: TextEdit = { range: { start: selection.end, end: selection.end }, newText: opensWith.close };
    return {
      edits: [openEdit, closeEdit],
      resolve: (other) => {
        const tracking = [openEdit, ...other];
        const newStart = transformPosition(selection.start, tracking);
        const newEnd = transformPosition(selection.end, tracking);
        return { start: newStart, end: newEnd, anchor: newStart, active: newEnd };
      },
    };
  }

  const active = selection.active;
  const line = reader.getLine(active.line);
  const nextChar = line[active.character];

  if (closesAny && nextChar === ch) {
    const tracking: TextEdit = { range: { start: active, end: active }, newText: ch };
    return {
      edits: [],
      resolve: (other) => collapsedSelection(transformPosition(active, [tracking, ...other])),
    };
  }

  if (opensWith) {
    const edit: TextEdit = { range: { start: active, end: active }, newText: ch + opensWith.close };
    const tracking: TextEdit = { range: { start: active, end: active }, newText: ch };
    return {
      edits: [edit],
      resolve: (other) => collapsedSelection(transformPosition(active, [tracking, ...other])),
    };
  }

  const edit: TextEdit = { range: { start: active, end: active }, newText: ch };
  return {
    edits: [edit],
    resolve: (other) => collapsedSelection(transformPosition(active, [edit, ...other])),
  };
}

/** What {@link buildBracketEditBatch} returns — mirrors `editing.ts`'s own
 * `EditBatch` shape (kept as a separate, identically-shaped type here since
 * `editing.ts` cannot be imported without dragging in its own, unrelated
 * insert/backspace/delete builders). */
export interface BracketEditBatch {
  edits: TextEdit[];
  selections: Selection[];
}

/**
 * Build the full multi-cursor batch for one bracket/quote keystroke `ch`
 * (Req 6.6, 11.1): run {@link buildOutcomeForSelection} per cursor, then
 * reconcile cross-cursor overlaps exactly like `editing.ts`'s
 * `buildEditBatch` — drop any edit that collides with one from an earlier
 * cursor (the earlier cursor wins), and for a cursor whose own edit(s) got
 * dropped this way, fall back to tracking its original `active` point
 * through whatever edits DID survive rather than reporting its own
 * (unapplied) outcome. For a cursor whose own edit(s) DID survive, its
 * final selection is `outcome.resolve(otherSurvivingEdits)` — every OTHER
 * cursor's surviving edit(s), so a same-line neighbor's inserted bracket(s)
 * correctly shift this cursor's own resulting position (see
 * {@link buildOutcomeForSelection}'s TSDoc for why `resolve` needs the
 * ORIGINAL pre-edit reference point rather than this outcome's own
 * already-local selection to combine those shifts correctly).
 */
export function buildBracketEditBatch(
  reader: LineReader,
  selections: readonly Selection[],
  ch: string,
  pairs: readonly BracketPair[],
): BracketEditBatch {
  const outcomes = selections.map((selection) => buildOutcomeForSelection(reader, selection, ch, pairs));
  const allEdits = outcomes.flatMap((o) => o.edits);
  const kept = dropOverlapping(allEdits);
  const keptSet = new Set(kept);

  const newSelections = selections.map((selection, i) => {
    const outcome = outcomes[i]!;
    const survived = outcome.edits.every((edit) => keptSet.has(edit));
    if (!survived) return collapsedSelection(transformPosition(selection.active, kept));
    const otherKept = kept.filter((edit) => !outcome.edits.includes(edit));
    return outcome.resolve(otherKept);
  });

  return { edits: kept, selections: newSelections };
}
