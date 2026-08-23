/**
 * Pure per-selection editing logic for `editor-core`'s basic editing
 * commands (Req 11.1; design.md §13): newline-with-auto-indent, Tab/
 * Shift+Tab indentation, and delete-left/delete-right (registered as
 * commands for palette/programmatic use — Req 11.1 lists "insert/delete"
 * among what `editor-core` provides — even though a bound Backspace/Delete
 * keystroke is already handled by `@tecode/core`'s `editor/inputRouter.ts`
 * fallthrough, Task 2.2; `index.ts`'s manifest deliberately does not bind
 * keys to these two, to avoid double-handling).
 *
 * Every builder here returns one `TextEdit | undefined` per selection;
 * {@link buildEditBatch} turns a whole `selections[]` into one batch — the
 * edits to apply, plus each selection's resulting collapsed cursor —
 * dropping overlaps and merging cursors that land on the same point after
 * the batch, exactly like `@tecode/core`'s `editor/inputRouter.ts` does for
 * plain typing/backspace/delete (Task 2.2), reusing `positionTransform.ts`'s
 * `range.end`-tracking (see that module's TSDoc for why `range.end`, not
 * `active`, is what must be tracked here).
 */

import type { Position, Selection, TextEdit } from "@tecode/api";
import { charToVisualColumn, type LineReader } from "./movement";
import { comparePositions, dropOverlapping, transformPosition } from "./positionTransform";
import { collapsedSelection } from "./selectionMerge";
import { nextGraphemeEnd, previousGraphemeStart } from "./wordBoundary";

/** Whether `selection` is a plain collapsed cursor (no selected range). */
function isCollapsed(selection: Selection): boolean {
  return comparePositions(selection.start, selection.end) === 0;
}

/**
 * Build the edit that inserts `text` at `selection` (Req 11.1's "insert
 * replaces the selection, collapse to end"): replaces the selection's whole
 * range if non-collapsed, or inserts at the collapsed cursor otherwise. Used
 * by both {@link buildNewlineEdit} and {@link buildTabEdit} — there is no
 * separate "type a character" command in `editor-core` (plain typing stays
 * `editor/inputRouter.ts`'s job, Task 2.2), but Tab/Enter both need this
 * same "insert, replacing any active selection" behavior for their own
 * fixed text.
 */
export function buildInsertEdit(selection: Selection, text: string): TextEdit {
  return { range: { start: selection.start, end: selection.end }, newText: text };
}

/**
 * Backspace at `selection` (Req 11.1): deletes the selected range if
 * non-collapsed; otherwise the previous grapheme, or joins with the
 * previous line at column 0. `undefined` at the document start (a boundary
 * no-op, matching `editor/inputRouter.ts`'s own convention).
 */
export function buildBackspaceEdit(reader: LineReader, selection: Selection): TextEdit | undefined {
  if (!isCollapsed(selection)) {
    return { range: { start: selection.start, end: selection.end }, newText: "" };
  }
  const active = selection.active;
  if (active.character > 0) {
    const line = reader.getLine(active.line);
    const start = { line: active.line, character: previousGraphemeStart(line, active.character) };
    return { range: { start, end: active }, newText: "" };
  }
  if (active.line > 0) {
    const previousLineLength = reader.getLine(active.line - 1).length;
    const start = { line: active.line - 1, character: previousLineLength };
    return { range: { start, end: active }, newText: "" };
  }
  return undefined;
}

/**
 * Forward-delete at `selection` (Req 11.1): deletes the selected range if
 * non-collapsed; otherwise the next grapheme, or joins with the next line
 * at end of line. `undefined` at the document end.
 */
export function buildDeleteEdit(reader: LineReader, selection: Selection): TextEdit | undefined {
  if (!isCollapsed(selection)) {
    return { range: { start: selection.start, end: selection.end }, newText: "" };
  }
  const active = selection.active;
  const line = reader.getLine(active.line);
  if (active.character < line.length) {
    const end = { line: active.line, character: nextGraphemeEnd(line, active.character) };
    return { range: { start: active, end }, newText: "" };
  }
  if (active.line < reader.lineCount - 1) {
    const end = { line: active.line + 1, character: 0 };
    return { range: { start: active, end }, newText: "" };
  }
  return undefined;
}

/**
 * Enter/auto-indent at `selection` (Req 11.1): inserts a newline followed
 * by a copy of the CURRENT line's leading whitespace (the line the caret is
 * on, read via `reader.getLine` — `tecode.editor.getLine` in practice),
 * regardless of where on that line the caret sits, and regardless of
 * whether `selection` also has a range to replace.
 */
export function buildNewlineEdit(reader: LineReader, selection: Selection): TextEdit {
  const currentLine = reader.getLine(selection.active.line);
  const indent = /^[ \t]*/.exec(currentLine)![0]!;
  return buildInsertEdit(selection, `\n${indent}`);
}

/**
 * Tab at `selection` (Req 11.1): inserts spaces up to the next
 * `tabSize`-wide stop (this task's tab-stop algorithm) when `insertSpaces`
 * is true, or a literal `"\t"` otherwise — replacing the selection's range
 * if it has one, exactly like {@link buildInsertEdit}. The stop is computed
 * from the CURSOR's own visual column (`movement.ts`'s `charToVisualColumn`),
 * not the start of the line, so Tab still advances a properly-indented
 * amount when the caret isn't at column 0.
 */
export function buildTabEdit(
  reader: LineReader,
  selection: Selection,
  tabSize: number,
  insertSpaces: boolean,
): TextEdit {
  if (!insertSpaces) {
    return buildInsertEdit(selection, "\t");
  }
  const line = reader.getLine(selection.active.line);
  const column = charToVisualColumn(line, selection.active.character, tabSize);
  const size = Number.isFinite(tabSize) && Math.trunc(tabSize) >= 1 ? Math.trunc(tabSize) : 4;
  const spacesNeeded = size - (column % size);
  return buildInsertEdit(selection, " ".repeat(spacesNeeded));
}

/**
 * Shift+Tab ("outdent") at `selection` (Req 11.1): removes up to one
 * `tabSize`-wide unit of the CURRENT LINE's leading whitespace (VS Code's
 * "remove one indentation level" convention — not the character to the
 * selection's own left). `undefined` when the line has no leading
 * whitespace to remove.
 */
export function buildOutdentEdit(
  reader: LineReader,
  selection: Selection,
  tabSize: number,
): TextEdit | undefined {
  const size = Number.isFinite(tabSize) && Math.trunc(tabSize) >= 1 ? Math.trunc(tabSize) : 4;
  const line = reader.getLine(selection.active.line);
  const leading = /^[ \t]*/.exec(line)![0]!;
  if (leading.length === 0) return undefined;

  let column = 0;
  let index = 0;
  while (index < leading.length && column < size) {
    column += leading[index] === "\t" ? size - (column % size) : 1;
    index++;
  }
  return {
    range: {
      start: { line: selection.active.line, character: 0 },
      end: { line: selection.active.line, character: index },
    },
    newText: "",
  };
}

/** What {@link buildEditBatch} produces: the edits to apply (already
 * overlap-resolved — safe to pass straight to `Document.applyEdits`) and
 * each surviving selection's post-edit collapsed cursor, overlap-merged. */
export interface EditBatch {
  edits: TextEdit[];
  selections: Selection[];
}

/**
 * Build the full multi-cursor edit batch for one command invocation (Req
 * 6.6, 11.1's "all handlers map over `selections` and merge overlaps"):
 * runs `buildOne` per selection, drops any edit that overlaps one already
 * kept (the earlier one wins), computes each selection's resulting
 * position by tracking its own edit's `range.end` through the surviving
 * edits when its edit survived, or its original `active` point otherwise
 * (`positionTransform.ts`'s `transformPosition`), and merges cursors that
 * land on the same point. A selection whose `buildOne` returns `undefined`
 * (a boundary no-op) keeps its position, still subject to being shifted by
 * OTHER selections' edits in the same batch.
 */
export function buildEditBatch(
  selections: readonly Selection[],
  buildOne: (selection: Selection) => TextEdit | undefined,
): EditBatch {
  const rawEdits = selections.map(buildOne);
  const definedEdits = rawEdits.filter((edit): edit is TextEdit => edit !== undefined);
  const edits = dropOverlapping(definedEdits);
  const survivingSet = new Set(edits);

  const newPositions: Position[] = selections.map((selection, i) => {
    const own = rawEdits[i];
    const trackPoint = own && survivingSet.has(own) ? own.range.end : selection.active;
    return transformPosition(trackPoint, edits);
  });

  const sortedPositions = [...newPositions].sort(comparePositions);
  const mergedSelections: Selection[] = [];
  for (const position of sortedPositions) {
    const last = mergedSelections[mergedSelections.length - 1];
    if (last && comparePositions(last.active, position) === 0) continue;
    mergedSelections.push(collapsedSelection(position));
  }

  return { edits, selections: mergedSelections };
}
