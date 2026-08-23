/**
 * Position/edit-batch math for `editor-core`'s editing commands (Req 11.1),
 * duplicated from `@tecode/core`'s `editor/positionTransform.ts` rather than
 * imported — `editor-core` can only import `@tecode/api` (the ESLint
 * layering rule in `eslint.config.mjs`) — with the exact same algorithm and
 * the exact same non-overlapping-edits precondition. See that module's
 * TSDoc for the full derivation; the summary that matters here:
 *
 * A position strictly inside an edit's replaced range has no meaningful
 * "where did it go", so it clamps to that edit's `range.end` first — NOT
 * `range.start` as `@tecode/core`'s version documents, because this
 * module's callers (`editing.ts`) always want "where does the caret land
 * after this edit", and `range.end` (in ORIGINAL, pre-edit coordinates)
 * happens to give the right answer for every edit shape `editing.ts`
 * builds, including ones core's router never had to handle:
 *
 * - A collapsed insert (`range.start === range.end === active`): `range.end`
 *   IS `active`, so this is identical to core's version for this case.
 * - A single-grapheme backspace (`range.end === active`, the deleted
 *   grapheme is to active's left): same as above.
 * - A single-grapheme forward-delete (`range.start === active`, `range.end`
 *   one grapheme later): tracking `range.end` still resolves correctly —
 *   with `newText === ""`, the "recompute this edit's new end position"
 *   math below reduces to exactly `range.start`, i.e. the caret does not
 *   move, matching forward-delete's documented behavior.
 * - Replacing a NON-collapsed selection with typed/inserted text (Req
 *   11.1's "insert replaces the selection, collapse to end"): `range.end`
 *   is the selection's far edge regardless of which end was the anchor and
 *   which was the caret (`Range.start`/`end` are always in document order,
 *   `@tecode/api`'s own `Range` TSDoc) — tracking it resolves to the end of
 *   the inserted text, which is exactly where the caret must land. Tracking
 *   the selection's `active` point instead (as core's router does, safely,
 *   since every edit shape IT builds keeps `active` exactly at `range.end`
 *   or `range.start`) would be WRONG here for a backward selection (`active
 *   === range.start`), landing the caret before the inserted text instead
 *   of after it.
 *
 * **One deliberate fix over core's formula**: core's version computes a
 * same-line anchor's post-edit character as `range.start.character +
 * (insertedLineCount === 0 ? newText.length : lastInsertedLineLength)` —
 * unconditionally adding `range.start.character`. That is only correct
 * for a SINGLE-line replacement (`insertedLineCount === 0`, the only shape
 * core's `editor/inputRouter.ts` ever builds — a typed character, or an
 * always-`newText: ""` backspace/delete): the replacement stays on one
 * line, so a trailing position is naturally `range.start.character` plus
 * however far into the replacement text it sits. For a MULTI-line
 * replacement (`insertedLineCount > 0` — `editing.ts`'s newline/auto-indent
 * command builds exactly this, `"\n" + indent`), the anchor's own line no
 * longer starts at `range.start.character` at all — it starts fresh at
 * column 0 on a brand-new line — so the correct term is just
 * `lastInsertedLineLength`, with no `range.start.character` added. Core's
 * formula is simply never exercised on that branch today (none of its
 * current edit shapes are multi-line), so this is not "fixing a bug
 * observed elsewhere," just not carrying forward a formula this module's
 * own newline command would otherwise miscompute on every Enter press
 * (`positionTransform.test.ts`'s "newline insert" case is the regression
 * guard).
 *
 * `editing.ts`'s `buildEditBatch` is what actually supplies `range.end` as
 * the tracked point per selection — this module only implements the
 * transform itself.
 */

import type { Position, TextEdit } from "@tecode/api";

/** Ascending comparison for two {@link Position}s — line first, then
 * character within the line. Exported for `editing.ts`'s overlap-dropping
 * and `selectionMerge.ts`'s sort (mirrors `@tecode/core`'s
 * `editor/positionTransform.ts` exporting the same helper for
 * `editor/inputRouter.ts`). */
export function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

/** Split `text` into lines on any of `\r\n`/`\n` (matches `@tecode/core`'s
 * `editor/positionTransform.ts`'s own local `splitIntoLines`, duplicated
 * for the same reason this whole module is). */
function splitIntoLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/**
 * Map `position` through `edits` (this module's TSDoc) — `edits` must be
 * non-overlapping; their relative order does not matter (same proof as
 * `@tecode/core`'s version, with `range.end` as the clamp target instead of
 * `range.start`).
 */
export function transformPosition(position: Position, edits: readonly TextEdit[]): Position {
  const containingEdit = edits.find(
    ({ range }) =>
      comparePositions(range.start, position) < 0 && comparePositions(position, range.end) < 0,
  );
  const anchor = containingEdit ? containingEdit.range.end : position;
  let line = anchor.line;
  let character = anchor.character;

  for (const edit of edits) {
    if (edit === containingEdit) continue;
    const { range, newText } = edit;
    const insertedLines = splitIntoLines(newText);
    const insertedLineCount = insertedLines.length - 1;
    const removedLineCount = range.end.line - range.start.line;
    const netLineDelta = insertedLineCount - removedLineCount;

    if (comparePositions(anchor, range.end) >= 0) {
      if (anchor.line === range.end.line) {
        const lastInsertedLineLength = insertedLines[insertedLines.length - 1]!.length;
        // See this module's TSDoc "One deliberate fix over core's
        // formula": a multi-line replacement's tail line starts fresh at
        // column 0, not at `range.start.character`.
        const newEndCharacter =
          insertedLineCount === 0 ? range.start.character + newText.length : lastInsertedLineLength;
        character = character - range.end.character + newEndCharacter;
      }
      line += netLineDelta;
    }
  }

  return { line, character };
}

/**
 * Drop any edit that overlaps one already kept, scanning in ascending
 * position order — the earlier (lower-position) edit wins (mirrors
 * `@tecode/core`'s `editor/inputRouter.ts`'s `dropOverlapping`, duplicated
 * for the same layering reason as the rest of this module). `editing.ts`'s
 * per-selection edits only overlap in the rare case of two cursors whose
 * independent operations (e.g. two simultaneous line-join backspaces)
 * produce colliding ranges; the later one's cursor simply does not move
 * this keystroke.
 */
export function dropOverlapping(edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => comparePositions(a.range.start, b.range.start));
  const kept: TextEdit[] = [];
  for (const edit of sorted) {
    const previous = kept[kept.length - 1];
    if (previous && comparePositions(edit.range.start, previous.range.end) < 0) continue;
    kept.push(edit);
  }
  return kept;
}
