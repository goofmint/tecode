/**
 * Pure cursor-movement math for `editor-core`'s movement/selection commands
 * (Req 11.1; design.md §13) — char (grapheme-aware), word, line
 * (home/end/up/down), and document granularity, each collapsed (a plain
 * move) or extending (shift held: anchor fixed, caret moves). Every
 * function here reads only through a {@link LineReader} (`tecode.editor.
 * getLine`/`lineCount`) — no document mutation, no `@tecode/core` import.
 */

import type { Position, Selection } from "@tecode/api";
import { comparePositions } from "./positionTransform";
import { collapsedSelection, mergeSelections } from "./selectionMerge";
import { nextGraphemeEnd, previousGraphemeStart, wordBoundaryLeft, wordBoundaryRight } from "./wordBoundary";

/** The slice of `tecode.editor` movement needs to read the active
 * document's text — `getLine`/`lineCount` are exactly `EditorNamespace`'s
 * own shape (`@tecode/api`'s `namespaces.ts`), so `tecode.editor` itself
 * satisfies this without any adapter. */
export interface LineReader {
  getLine(line: number): string;
  lineCount: number;
}

/** `Math.trunc` a possibly-fractional/`NaN` tab size down to a positive
 * integer, defaulting to 4 — matches `@tecode/core`'s `ui/cellWidth.ts`'s
 * own normalization policy (a bad config value is a display concern, not
 * worth crashing a movement command over). Duplicated locally (`editor-core`
 * cannot import `@tecode/core` — the ESLint layering rule). */
function normalizeTabSize(tabSize: number): number {
  const truncated = Number.isFinite(tabSize) ? Math.trunc(tabSize) : 0;
  return truncated >= 1 ? truncated : 4;
}

/**
 * The visual column `character` renders at within `line`, advancing tab
 * runs to the next `tabSize`-wide stop (`column += tabSize - (column %
 * tabSize)`, this task's documented tab-stop algorithm, reimplemented
 * locally — see {@link normalizeTabSize}'s TSDoc on why). Every other
 * grapheme counts as exactly one column — unlike `@tecode/core`'s
 * `ui/cellWidth.ts`, this does NOT account for CJK/wide-character terminal
 * cell width, since up/down column preservation only needs to be
 * self-consistent between {@link visualColumnToChar} and this function, not
 * pixel/cell-accurate against the renderer.
 */
export function charToVisualColumn(line: string, character: number, tabSize: number): number {
  const size = normalizeTabSize(tabSize);
  const clamped = Math.max(0, Math.min(Math.trunc(character) || 0, line.length));
  let column = 0;
  let index = 0;
  while (index < clamped) {
    if (line[index] === "\t") {
      column += size - (column % size);
    } else {
      column += 1;
    }
    index++;
  }
  return column;
}

/** The character offset in `line` whose visual column is closest to (the
 * first one at-or-past) `column` — the inverse of {@link
 * charToVisualColumn}, used to preserve a caret's visual column across an
 * up/down move onto a line with different tab/content layout. */
export function visualColumnToChar(line: string, column: number, tabSize: number): number {
  const size = normalizeTabSize(tabSize);
  let currentColumn = 0;
  for (let index = 0; index < line.length; index++) {
    if (currentColumn >= column) return index;
    currentColumn += line[index] === "\t" ? size - (currentColumn % size) : 1;
  }
  return line.length;
}

/** Move one grapheme left, crossing to the end of the previous line at
 * column 0 (this task's "char" granularity). Stays put at the document
 * start. */
export function moveCharLeft(reader: LineReader, position: Position): Position {
  if (position.character > 0) {
    const line = reader.getLine(position.line);
    return { line: position.line, character: previousGraphemeStart(line, position.character) };
  }
  if (position.line > 0) {
    const previousLine = reader.getLine(position.line - 1);
    return { line: position.line - 1, character: previousLine.length };
  }
  return position;
}

/** Move one grapheme right, crossing to the start of the next line at end
 * of line. Stays put at the document end. */
export function moveCharRight(reader: LineReader, position: Position): Position {
  const line = reader.getLine(position.line);
  if (position.character < line.length) {
    return { line: position.line, character: nextGraphemeEnd(line, position.character) };
  }
  if (position.line < reader.lineCount - 1) {
    return { line: position.line + 1, character: 0 };
  }
  return position;
}

/** Move one word left (`wordBoundary.ts`'s `wordBoundaryLeft`), crossing to
 * the end of the previous line when already at column 0. */
export function moveWordLeft(reader: LineReader, position: Position): Position {
  if (position.character === 0) {
    if (position.line === 0) return position;
    const previousLine = reader.getLine(position.line - 1);
    return { line: position.line - 1, character: previousLine.length };
  }
  const line = reader.getLine(position.line);
  return { line: position.line, character: wordBoundaryLeft(line, position.character) };
}

/** Move one word right (`wordBoundary.ts`'s `wordBoundaryRight`), crossing
 * to the start of the next line when already at end of line. */
export function moveWordRight(reader: LineReader, position: Position): Position {
  const line = reader.getLine(position.line);
  if (position.character >= line.length) {
    if (position.line >= reader.lineCount - 1) return position;
    return { line: position.line + 1, character: 0 };
  }
  return { line: position.line, character: wordBoundaryRight(line, position.character) };
}

/** "Smart home": the first press goes to the line's first non-whitespace
 * character; pressing it again (or starting already there) goes to column
 * 0 — the common convention most editors use for the Home key. */
export function moveLineHome(reader: LineReader, position: Position): Position {
  const line = reader.getLine(position.line);
  const match = /^[ \t]*/.exec(line)![0]!;
  const indentEnd = match.length;
  const target = position.character === indentEnd ? 0 : indentEnd;
  return { line: position.line, character: target };
}

/** End of the current line. */
export function moveLineEnd(reader: LineReader, position: Position): Position {
  return { line: position.line, character: reader.getLine(position.line).length };
}

/** Move `deltaLines` lines up/down, preserving the caret's visual column
 * (this module's TSDoc's tab-stop algorithm) — the SAME move's target
 * column, not a "sticky" column remembered across several consecutive
 * up/down presses (out of scope here: that requires per-editor state this
 * pure function has no seam for). Clamped: moving up from the first line
 * (or down from the last) leaves `position` unchanged rather than jumping
 * to a boundary line. */
function moveVertical(reader: LineReader, position: Position, tabSize: number, deltaLines: number): Position {
  const targetLine = position.line + deltaLines;
  if (targetLine < 0 || targetLine > reader.lineCount - 1) return position;
  const column = charToVisualColumn(reader.getLine(position.line), position.character, tabSize);
  const targetLineText = reader.getLine(targetLine);
  return { line: targetLine, character: visualColumnToChar(targetLineText, column, tabSize) };
}

export function moveLineUp(reader: LineReader, position: Position, tabSize: number): Position {
  return moveVertical(reader, position, tabSize, -1);
}

export function moveLineDown(reader: LineReader, position: Position, tabSize: number): Position {
  return moveVertical(reader, position, tabSize, 1);
}

/** The document's very first position. */
export function moveDocumentStart(): Position {
  return { line: 0, character: 0 };
}

/** The document's very last position (end of its last line). */
export function moveDocumentEnd(reader: LineReader): Position {
  const lastLine = Math.max(0, reader.lineCount - 1);
  return { line: lastLine, character: reader.getLine(lastLine).length };
}

/**
 * Apply `moveOne` (one of the `move*` functions above) to every selection's
 * `active` point (Req 6.6, 11.1's "all handlers map over `selections`"),
 * producing either a collapsed cursor at the new position (`extend:
 * false`) or an extended selection (`extend: true`: `anchor` stays put,
 * `active` moves to the new position) — then merges overlaps (`
 * selectionMerge.ts`). This is what every movement/selection command
 * handler in `index.ts` calls; the granularity-specific logic lives only in
 * the `move*` functions.
 */
export function applyMovement(
  selections: readonly Selection[],
  extend: boolean,
  moveOne: (position: Position) => Position,
): Selection[] {
  const moved = selections.map((selection): Selection => {
    const newActive = moveOne(selection.active);
    if (!extend) return collapsedSelection(newActive);
    const anchor = selection.anchor;
    const forward = comparePositions(anchor, newActive) <= 0;
    return {
      start: forward ? anchor : newActive,
      end: forward ? newActive : anchor,
      anchor,
      active: newActive,
    };
  });
  return mergeSelections(moved);
}
