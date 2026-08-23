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

import type { BracketPair, Position, Selection, TextEdit } from "@tecode/api";
import type { LineReader } from "./movement";
import { collapsedSelection } from "./selectionMerge";
import { comparePositions, dropOverlapping, transformPosition } from "./positionTransform";

/** Whether `selection` is a collapsed cursor (no selected range). */
function isCollapsed(selection: Selection): boolean {
  return comparePositions(selection.start, selection.end) === 0;
}

/** One selection's outcome for one typed bracket/quote character `ch` —
 * the edits it contributes (0, 1, or 2) and its own resulting selection,
 * computed independently of every other cursor (`buildBracketEditBatch`
 * reconciles cross-cursor overlaps afterward, mirroring `editing.ts`'s
 * `buildEditBatch`). */
interface BracketOutcome {
  edits: TextEdit[];
  selection: Selection;
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
 * code unit with no line break, so shifting a same-line position by
 * `ch.length`/`close.length` (always `1`) after an insertion is exact —
 * no need for `positionTransform.ts`'s general multi-line machinery for
 * the wrap case specifically (case 2 and the collapsed cases below still
 * report positions for `buildBracketEditBatch` to reconcile against OTHER
 * cursors' edits via that module, which does handle the general case).
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
      // 11.1) — identical in shape to `editing.ts`'s `buildInsertEdit`,
      // so reuse `transformPosition` the same way it does rather than
      // hand-computing the multi-line case.
      const edit: TextEdit = { range: { start: selection.start, end: selection.end }, newText: ch };
      return { edits: [edit], selection: collapsedSelection(transformPosition(selection.end, [edit])) };
    }
    // Wrap: insert `ch` before the selection and `close` after it. Both
    // are collapsed, single-character (no newline) inserts, so
    // `transformPosition` against the OPEN edit alone gives each
    // endpoint's exact post-open-insert position; the CLOSE edit is
    // deliberately excluded from that transform — it sits exactly at
    // `end`, and the wrapped selection must land BEFORE the bracket it
    // just caused to be inserted there, not after it.
    const openEdit: TextEdit = { range: { start: selection.start, end: selection.start }, newText: ch };
    const newStart = transformPosition(selection.start, [openEdit]);
    const newEnd = transformPosition(selection.end, [openEdit]);
    const closeEdit: TextEdit = { range: { start: selection.end, end: selection.end }, newText: opensWith.close };
    return {
      edits: [openEdit, closeEdit],
      selection: { start: newStart, end: newEnd, anchor: newStart, active: newEnd },
    };
  }

  const active = selection.active;
  const line = reader.getLine(active.line);
  const nextChar = line[active.character];

  if (closesAny && nextChar === ch) {
    const newActive: Position = { line: active.line, character: active.character + ch.length };
    return { edits: [], selection: collapsedSelection(newActive) };
  }

  if (opensWith) {
    const newActive: Position = { line: active.line, character: active.character + ch.length };
    return {
      edits: [{ range: { start: active, end: active }, newText: ch + opensWith.close }],
      selection: collapsedSelection(newActive),
    };
  }

  const newActive: Position = { line: active.line, character: active.character + ch.length };
  return {
    edits: [{ range: { start: active, end: active }, newText: ch }],
    selection: collapsedSelection(newActive),
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
 * (unapplied) outcome.
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
    if (survived) return outcome.selection;
    return collapsedSelection(transformPosition(selection.active, kept));
  });

  return { edits: kept, selections: newSelections };
}
