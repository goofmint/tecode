/**
 * Pure line-operation logic for `editor-core`'s `editor.action.duplicateLine`
 * / `moveLinesUp` / `moveLinesDown` / `deleteLine` commands (Req 11.1;
 * design.md §13; tasks.md's Task 2.4). Every function here reads the whole
 * document through a {@link LineReader} (`tecode.editor.getLine`/
 * `lineCount`) and returns a single whole-document {@link TextEdit} plus the
 * resulting `selections[]` — no `@tecode/core` import (the ESLint layering
 * rule).
 *
 * **Whole-document edit, not per-line surgical edits**: these commands are
 * invoked occasionally (a keybinding press), not per-keystroke, so
 * correctness matters far more than minimizing the `onDidChange` dirty
 * range here — unlike `editing.ts`'s per-selection edits (which run on
 * every Tab/Enter/Backspace). Each builder below simulates the whole
 * operation on a plain `string[]` copy of every line (`reader.getLine` for
 * `0..lineCount-1`) and emits ONE edit spanning the entire buffer,
 * replacing it with the simulated result — trivially correct by
 * construction, with none of the position-transform edge cases a
 * fine-grained multi-edit batch would need to get right for arbitrary
 * multi-cursor line groups.
 *
 * **Dedupe cursors sharing a line first** (Req 11.1): {@link
 * groupSelectionLines} turns every selection's affected line range into a
 * sorted list of maximal, non-overlapping, non-touching groups — two
 * cursors on the same line (or on directly adjacent lines) become ONE
 * group, moved/duplicated/deleted as a single block, exactly like every
 * mainstream editor's multi-cursor line commands.
 */

import type { Position, Selection, TextEdit } from "@tecode/api";
import type { LineReader } from "./movement";
import { collapsedSelection, mergeSelections } from "./selectionMerge";

/** An inclusive `[start, end]` line range, both 0-based. */
export type LineRange = [start: number, end: number];

/**
 * The inclusive line range `selection` affects for a line operation
 * (Req 11.1). A non-collapsed selection that ends exactly at column 0 of a
 * later line (`end.character === 0`, `end.line > start.line`) does not
 * "reach into" that line — the common editor convention that selecting up
 * to, but not into, a line leaves that line untouched by a line-oriented
 * command. A collapsed cursor's range is trivially its own single line.
 */
export function affectedLineRange(selection: Selection): LineRange {
  const { start, end } = selection;
  if (end.line > start.line && end.character === 0) {
    return [start.line, end.line - 1];
  }
  return [start.line, end.line];
}

/**
 * Merge every selection's {@link affectedLineRange} into ascending,
 * disjoint, maximal-contiguous groups (this module's TSDoc's "dedupe
 * cursors sharing a line first") — two ranges that overlap OR touch
 * (`nextStart <= lastEnd + 1`) merge into one, so two cursors on adjacent
 * lines move/duplicate/delete together as a single block.
 */
export function groupSelectionLines(selections: readonly Selection[]): LineRange[] {
  const ranges = selections.map(affectedLineRange).sort((a, b) => a[0] - b[0]);
  const groups: LineRange[] = [];
  for (const [start, end] of ranges) {
    const last = groups[groups.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      groups.push([start, end]);
    }
  }
  return groups;
}

/** Read every line of the active document into a plain array (this
 * module's TSDoc's "simulate on a copy" strategy). */
function readAllLines(reader: LineReader): string[] {
  const lines: string[] = [];
  for (let i = 0; i < reader.lineCount; i++) lines.push(reader.getLine(i));
  return lines;
}

/** The `TextEdit` that replaces the ENTIRE buffer (`originalLines`, as read
 * before simulation) with `newLines` — the one edit every builder below
 * emits. */
function buildWholeDocumentEdit(originalLines: readonly string[], newLines: readonly string[]): TextEdit {
  const lastLine = originalLines.length - 1;
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: lastLine, character: originalLines[lastLine]!.length },
    },
    newText: newLines.join("\n"),
  };
}

/** What every builder below returns: the one edit to apply (`undefined`
 * when the command is a whole-document no-op — nothing to duplicate/move/
 * delete, or every group already at a buffer boundary) plus the resulting,
 * overlap-merged `selections[]`. Collapsed cursors only: line operations
 * collapse any selection to a single caret at its new location (matching
 * `editing.ts`'s own collapsing convention for line-shaped edits). */
export interface LineOpResult {
  edit: TextEdit | undefined;
  selections: Selection[];
}

/**
 * `editor.action.duplicateLine` (Req 11.1): for each group `[a, b]`, insert
 * a copy of lines `a..b` immediately below `b`. A selection whose `active`
 * line falls inside a group lands on the DUPLICATE (shifted down by the
 * group's own size — "Copy Line Down" convention: the caret follows the new
 * copy); a selection outside every group shifts down by the total size of
 * every group entirely above it, unaffected otherwise. Never a no-op: there
 * is always at least one group when `selections` is non-empty.
 */
export function buildDuplicateLineResult(reader: LineReader, selections: readonly Selection[]): LineOpResult {
  const originalLines = readAllLines(reader);
  const groups = groupSelectionLines(selections);

  const newLines = [...originalLines];
  // Insert from the bottom group up so an earlier insertion's index shift
  // never invalidates a not-yet-processed group's own (still-original)
  // indices.
  for (const [a, b] of [...groups].sort((x, y) => y[0] - x[0])) {
    newLines.splice(b + 1, 0, ...originalLines.slice(a, b + 1));
  }

  /** How far `oldLine`'s content moves: the sum of every group fully above
   * it, plus its own group's size if `oldLine` sits inside one (landing on
   * the duplicate — this function's TSDoc). */
  function shiftFor(oldLine: number): number {
    let shift = 0;
    for (const [a, b] of groups) {
      if (oldLine > b) shift += b - a + 1;
      else if (oldLine >= a) return shift + (b - a + 1);
    }
    return shift;
  }

  const selectionsOut = selections.map((selection) => {
    const oldLine = selection.active.line;
    const newPosition: Position = { line: oldLine + shiftFor(oldLine), character: selection.active.character };
    return collapsedSelection(newPosition);
  });

  return {
    edit: buildWholeDocumentEdit(originalLines, newLines),
    selections: mergeSelections(selectionsOut),
  };
}

/** Shared by {@link buildMoveLinesUpResult}/{@link buildMoveLinesDownResult}
 * (Req 11.1): move every movable group by one line in `direction` (`-1` up,
 * `1` down), swapping it with the single adjacent line on that side. A
 * group already at the buffer boundary on that side (`a === 0` for up,
 * `b === lineCount - 1` for down) is immovable and left untouched — when
 * EVERY group is immovable this way, the whole command is a no-op
 * (`edit: undefined`), matching `index.ts`'s existing "no edits → don't
 * call applyEdits" convention for a boundary no-op.
 */
function buildMoveLinesResult(reader: LineReader, selections: readonly Selection[], direction: -1 | 1): LineOpResult {
  const originalLines = readAllLines(reader);
  const lineCount = originalLines.length;
  const groups = groupSelectionLines(selections);

  const newLines = [...originalLines];
  const movable = new Map<string, boolean>();
  for (const [a, b] of groups) {
    const canMove = direction === -1 ? a > 0 : b < lineCount - 1;
    movable.set(`${a}:${b}`, canMove);
    if (!canMove) continue;
    if (direction === -1) {
      const window = newLines.slice(a - 1, b + 1); // [lineAbove, ...group]
      newLines.splice(a - 1, window.length, ...window.slice(1), window[0]!);
    } else {
      const window = newLines.slice(a, b + 2); // [...group, lineBelow]
      newLines.splice(a, window.length, window[window.length - 1]!, ...window.slice(0, -1));
    }
  }

  const anyMoved = [...movable.values()].some(Boolean);
  if (!anyMoved) {
    return { edit: undefined, selections: [...selections] };
  }

  const selectionsOut = selections.map((selection) => {
    const oldLine = selection.active.line;
    const group = groups.find(([a, b]) => oldLine >= a && oldLine <= b);
    const delta = group && movable.get(`${group[0]}:${group[1]}`) ? direction : 0;
    return collapsedSelection({ line: oldLine + delta, character: selection.active.character });
  });

  return {
    edit: buildWholeDocumentEdit(originalLines, newLines),
    selections: mergeSelections(selectionsOut),
  };
}

/** `editor.action.moveLinesUp` (Req 11.1). */
export function buildMoveLinesUpResult(reader: LineReader, selections: readonly Selection[]): LineOpResult {
  return buildMoveLinesResult(reader, selections, -1);
}

/** `editor.action.moveLinesDown` (Req 11.1). */
export function buildMoveLinesDownResult(reader: LineReader, selections: readonly Selection[]): LineOpResult {
  return buildMoveLinesResult(reader, selections, 1);
}

/**
 * `editor.action.deleteLine` (Req 11.1): remove every group's lines
 * entirely. Deleting every line in the buffer leaves a single empty line
 * (a `LineBuffer` can never have zero lines — `buffer/lineBuffer.ts`'s own
 * invariant); a selection inside a deleted group lands at column 0 of
 * whatever now occupies that group's old starting line, clamped to the
 * new last line when the deletion removed everything at or below it (this
 * function's TSDoc's "trailing-newline edge": deleting through the
 * document's last line has nothing below to land on).
 */
export function buildDeleteLineResult(reader: LineReader, selections: readonly Selection[]): LineOpResult {
  const originalLines = readAllLines(reader);
  const groups = groupSelectionLines(selections);

  const newLines = [...originalLines];
  for (const [a, b] of [...groups].sort((x, y) => y[0] - x[0])) {
    newLines.splice(a, b - a + 1);
  }
  if (newLines.length === 0) newLines.push("");
  const finalLineCount = newLines.length;

  /** Total size of every group entirely above `line` (this function's
   * TSDoc's shift bookkeeping, mirroring `buildDuplicateLineResult`'s
   * `shiftFor`). */
  function removedAbove(line: number): number {
    let removed = 0;
    for (const [a, b] of groups) {
      if (b < line) removed += b - a + 1;
    }
    return removed;
  }

  const selectionsOut = selections.map((selection) => {
    const oldLine = selection.active.line;
    const group = groups.find(([a, b]) => oldLine >= a && oldLine <= b);
    if (!group) {
      return collapsedSelection({ line: oldLine - removedAbove(oldLine), character: selection.active.character });
    }
    const landingLine = Math.max(0, Math.min(group[0] - removedAbove(oldLine), finalLineCount - 1));
    return collapsedSelection({ line: landingLine, character: 0 });
  });

  return {
    edit: buildWholeDocumentEdit(originalLines, newLines),
    selections: mergeSelections(selectionsOut),
  };
}
