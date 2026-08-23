/**
 * {@link transformPosition}: map a `Position` through a batch of
 * non-overlapping `TextEdit`s to where it lands once the batch has been
 * applied (Task 2.2's cursor-advance requirement, design.md §6.1, §8.3:
 * "Key input that reaches the view ... becomes an insert `applyEdits` at
 * all cursors" — after that batch commits, every OTHER cursor above/below
 * the edit needs its position recomputed too, not just the cursor whose own
 * keystroke it was).
 *
 * This is the standard "translate a position across a text edit" mapping
 * (the same shape LSP incremental sync uses for `Range`s), implemented
 * directly against this codebase's `Position`/`Range`/`TextEdit` shapes
 * (`@tecode/api`) rather than pulled in as a dependency.
 *
 * **Why a plain per-edit delta works, and why edit order doesn't matter**:
 * `edits` are always non-overlapping (the same precondition
 * `LineBuffer.applyEdits` itself requires) and expressed in one shared
 * *original* (pre-batch) coordinate space. For any given `position`, each
 * edit falls into exactly one of three buckets, decided purely by comparing
 * `position` to that edit's own original `range` — never to any other
 * edit's range, and never to a running "already shifted" position:
 *
 * 1. **Entirely before `position`** (`range.end <= position`in the original
 *    space): `position` shifts by this edit's line/character delta. Because
 *    edits are non-overlapping, at most one such edit shares `position`'s
 *    original line as its `range.end.line`, but several *different* lines'
 *    worth of such edits can all be "before" `position` — each contributes
 *    its OWN length delta independently, and, since these deltas are just
 *    fixed integers describing how much text before `position` on its own
 *    line changed length, summing them (in any order) gives the correct
 *    total. That is what lets this function loop over `edits` in whatever
 *    order the caller hands them.
 * 2. **Strictly containing `position`** (`range.start < position <
 *    range.end`): `position` sat inside text this edit removed/replaced;
 *    there is no meaningful "where did it go", so it clamps to the edit's
 *    `range.start` (the position also lands there stably no matter how many
 *    more "before" edits get folded in afterwards, since edits are
 *    non-overlapping and sorted — no other edit's range can also touch this
 *    same original position).
 * 3. **At or after `position`** (`range.start >= position`): unaffected —
 *    text below/after `position` is not this edit's concern.
 *
 * Every one of Task 2.2's edit shapes (a single-position insert; a
 * `[active-1, active)` or line-join backspace; a `[active, active+1)` or
 * line-join forward-delete) is built so the *editing* cursor's own position
 * always equals either its edit's `range.start` (forward-delete: the cursor
 * does not move) or its `range.end` (insert/backspace: the cursor moves to
 * exactly where the edit's replacement text ends) — bucket 1 or 3 above,
 * never bucket 2 — so a cursor's own keystroke always resolves correctly
 * through this same general machinery, without special-casing "is this
 * edit mine".
 */

import type { Position, TextEdit } from "@tecode/api";

/** Ascending comparison for two {@link Position}s — line first, then
 * character within the line. Exported so `editor/inputRouter.ts` can sort
 * selections/edits with the exact same ordering this module's own
 * reasoning (its TSDoc) depends on. */
export function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

/** Split `text` into lines on any of `\r\n`/`\n`, matching
 * `lineBuffer.ts`'s own `splitIntoLines` — duplicated locally (rather than
 * imported) since `lineBuffer.ts` does not export it and this one-line
 * helper is not worth widening that module's surface for. */
function splitIntoLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/**
 * Map `position` through `edits` (Task 2.2, this module's TSDoc) — the
 * position `edits`, applied as one atomic `LineBuffer.applyEdits` batch,
 * would leave it at. `edits` must be non-overlapping (the same precondition
 * `LineBuffer.applyEdits` enforces); their relative order does not matter
 * (this module's TSDoc explains why).
 */
export function transformPosition(position: Position, edits: readonly TextEdit[]): Position {
  let line = position.line;
  let character = position.character;

  for (const edit of edits) {
    const { range, newText } = edit;
    const insertedLines = splitIntoLines(newText);
    const insertedLineCount = insertedLines.length - 1;
    const removedLineCount = range.end.line - range.start.line;
    const netLineDelta = insertedLineCount - removedLineCount;

    if (comparePositions(position, range.end) >= 0) {
      // Bucket 1 (this module's TSDoc): position is at-or-after this
      // edit's end, in ORIGINAL coordinates.
      if (position.line === range.end.line) {
        const lastInsertedLineLength = insertedLines[insertedLines.length - 1]!.length;
        const newEndCharacter =
          range.start.character + (insertedLineCount === 0 ? newText.length : lastInsertedLineLength);
        character = character - range.end.character + newEndCharacter;
      }
      line += netLineDelta;
      continue;
    }

    if (comparePositions(position, range.start) > 0) {
      // Bucket 2: position was strictly inside text this edit removed —
      // clamp to where that text used to start.
      line = range.start.line;
      character = range.start.character;
      continue;
    }

    // Bucket 3: position is before this edit's range.start — unaffected.
  }

  return { line, character };
}
