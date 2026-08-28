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
 * *original* (pre-batch) coordinate space. A position strictly inside an
 * edit's replaced range has no meaningful "where did it go", so it is first
 * clamped to that edit's `range.start` — the **anchor**. (When no edit
 * contains the position, the anchor is the position itself; because edits
 * are non-overlapping, at most one edit can contain it, so the anchor is
 * well-defined regardless of the order `edits` arrive in.) Every remaining
 * edit then falls into exactly one of two buckets, decided purely by
 * comparing the *anchor* to that edit's own original `range`:
 *
 * 1. **Entirely before the anchor** (`range.end <= anchor` in the original
 *    space): the anchor shifts by this edit's line/character delta. Because
 *    edits are non-overlapping, at most one such edit shares the anchor's
 *    original line as its `range.end.line`, but several *different* lines'
 *    worth of such edits can all be "before" the anchor — each contributes
 *    its OWN length delta independently, and, since these deltas are just
 *    fixed integers describing how much text before the anchor on its own
 *    line changed length, summing them (in any order) gives the correct
 *    total. That is what lets this function loop over `edits` in whatever
 *    order the caller hands them: the clamp is resolved *before* the loop,
 *    so a containing edit encountered mid-loop can no longer overwrite
 *    shifts already accumulated from preceding "before" edits.
 * 2. **At or after the anchor** (`range.start >= anchor`): unaffected —
 *    text below/after the anchor is not this edit's concern. (The
 *    containing edit itself, if any, also lands here relative to its own
 *    `range.start` and contributes nothing beyond the clamp.)
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
  // Resolve the clamp FIRST (this module's TSDoc): a position strictly
  // inside an edit's replaced range anchors to that edit's `range.start`
  // in original coordinates, and the loop below then shifts the anchor by
  // every preceding edit's delta — so the result no longer depends on
  // where in the batch the containing edit happens to sit.
  const containingEdit = edits.find(
    ({ range }) =>
      comparePositions(range.start, position) < 0 && comparePositions(position, range.end) < 0,
  );
  const anchor = containingEdit ? containingEdit.range.start : position;
  let line = anchor.line;

  // Every edit "before" the anchor (bucket 1 above), regardless of `edits`'
  // own order — `line` is a pure sum, exactly as this module's TSDoc
  // describes: each preceding edit contributes its own `netLineDelta`
  // independently of every other one.
  const preceding = edits.filter(
    (edit) => edit !== containingEdit && comparePositions(anchor, edit.range.end) >= 0,
  );
  for (const { range, newText } of preceding) {
    const insertedLineCount = splitIntoLines(newText).length - 1;
    const removedLineCount = range.end.line - range.start.line;
    line += insertedLineCount - removedLineCount;
  }

  // `character`, unlike `line`, is NOT a pure sum once more than one
  // preceding edit shares the anchor's ORIGINAL line — Issue #91's
  // `EditorInputRouter.insertText` is this codebase's first caller to ever
  // hand `transformPosition` a genuinely multi-line `newText` (every edit
  // shape `routeKeyEvent`'s own `buildEditBatch` builds — a single typed
  // character, or an always-`newText: ""` backspace/delete — is single-line,
  // so this branch was previously unexercised here). A SINGLE-line preceding
  // edit's character contribution is a fixed, order-independent delta
  // (`newEndCharacter - range.end.character`, added on top of whatever
  // `character` already is) — that's what makes the reassignment loop below
  // correct regardless of processing order for that case, matching this
  // module's own TSDoc reasoning. A MULTI-line preceding edit is different:
  // it does not shift the anchor's column, it RESETS it — the anchor's line
  // no longer starts at any original column at all once at least one
  // newline has been inserted before it, it starts fresh at whatever column
  // that edit's OWN last inserted line ends at. So same-line preceding
  // edits must be walked CLOSEST-TO-THE-ANCHOR FIRST (descending
  // `range.end`): every single-line edit encountered before the first
  // multi-line one accumulates the usual per-edit delta, and the moment a
  // multi-line edit is reached, `character` is reset to that edit's own
  // tail-line length and the walk stops — any edit further left (closer to
  // the original line's start) no longer affects `character` at all (it
  // already contributed to `line`, in the sum above, since its own inserted
  // newlines happened before this position either way). This is
  // `@tecode/builtin/editor-core`'s `positionTransform.ts` — a module that
  // cannot import this one (the `builtin`/`core` ESLint layering rule) and
  // so carries its own copy — documents as a deliberate fix over an
  // earlier version of THIS function; ported back here now that this
  // module has its own multi-line caller. When every same-line preceding
  // edit is single-line (every case exercised before this task), this
  // reduces to exactly the previous per-edit-in-any-order accumulation,
  // since plain addition commutes — `positionTransform.test.ts`'s existing
  // cases are unchanged by this rewrite.
  let character = anchor.character;
  const sameLine = preceding
    .filter((edit) => edit.range.end.line === anchor.line)
    .sort((a, b) => comparePositions(b.range.end, a.range.end));
  for (const { range, newText } of sameLine) {
    const insertedLines = splitIntoLines(newText);
    const insertedLineCount = insertedLines.length - 1;
    if (insertedLineCount === 0) {
      character = character - range.end.character + range.start.character + newText.length;
      continue;
    }
    const lastInsertedLineLength = insertedLines[insertedLines.length - 1]!.length;
    character = character - range.end.character + lastInsertedLineLength;
    break;
  }

  return { line, character };
}
