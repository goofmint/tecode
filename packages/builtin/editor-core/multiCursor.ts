/**
 * Pure logic for `editor.action.addSelectionToNextFindMatch` (ctrl+d, Req
 * 11.1; design.md §13; tasks.md's Task 2.4): "an empty primary selection
 * expands to the word at the cursor; a non-empty primary selection adds the
 * next occurrence of its text as a new primary selection, wrapping at the
 * buffer end and skipping ranges already selected." No `@tecode/core`
 * import (the ESLint layering rule); reads through a {@link LineReader}.
 *
 * `selections[0]` is always the PRIMARY cursor (`@tecode/api`'s
 * `EditorNamespace.cursor` TSDoc, `@tecode/core`'s `ui/editorState.ts`) —
 * every result here keeps that invariant by placing the newly
 * expanded/added selection at index 0 and leaving every other selection's
 * relative order untouched, rather than running the result through
 * `selectionMerge.ts`'s `mergeSelections` (which re-sorts by position and
 * would silently discard "primary" as a concept).
 */

import type { Position, Selection } from "@tecode/api";
import { comparePositions } from "./positionTransform";
import { toGraphemes } from "./wordBoundary";

/** The slice of `tecode.editor` this module needs — identical to
 * `movement.ts`'s own `LineReader`, duplicated locally so this module has
 * no dependency on `movement.ts` beyond what it actually uses (`getLine`/
 * `lineCount`; every caller in practice passes the same `tecode.editor`
 * object either way). */
export interface LineReader {
  getLine(line: number): string;
  lineCount: number;
}

/** Whether `selection` is a collapsed cursor (no selected range). */
function isCollapsed(selection: Selection): boolean {
  return comparePositions(selection.start, selection.end) === 0;
}

/** Join every line of the document into one string with the offset each
 * line starts at (this module's own line↔offset mapping — `editor-core`
 * cannot import `@tecode/core`'s `LineBuffer.offsetAt`/`positionAt`, the
 * ESLint layering rule, and a full-buffer scan here is only paid on an
 * explicit ctrl+d press, never per keystroke). `lineStarts[i]` is line
 * `i`'s first character's offset into `text`; lines are joined with `"\n"`
 * regardless of the document's actual EOL — this module only ever compares
 * offsets it computed itself, so the join character need not match the
 * document's real line endings, only be self-consistent.
 */
function readBuffer(reader: LineReader): { text: string; lineStarts: number[] } {
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < reader.lineCount; i++) {
    const line = reader.getLine(i);
    lineStarts.push(offset);
    lines.push(line);
    offset += line.length + 1;
  }
  return { text: lines.join("\n"), lineStarts };
}

/** Convert `position` to an offset into {@link readBuffer}'s `text`. */
function toOffset(position: Position, lineStarts: readonly number[]): number {
  return lineStarts[position.line]! + position.character;
}

/** The inverse of {@link toOffset}: find the line whose start is the
 * greatest one `<= offset`, then the remaining character within it. */
function toPosition(offset: number, lineStarts: readonly number[]): Position {
  let line = 0;
  for (let i = lineStarts.length - 1; i >= 0; i--) {
    if (lineStarts[i]! <= offset) {
      line = i;
      break;
    }
  }
  return { line, character: offset - lineStarts[line]! };
}

/** Every start offset `needle` occurs at in `haystack`, non-overlapping
 * (each match consumes `needle.length` before the next search begins —
 * the conventional "find all" semantics, matching what a user expects
 * "next occurrence" to step through). `""` never matches (an empty search
 * string has no meaningful "occurrence"). */
function allOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const result: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    result.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return result;
}

/**
 * The next occurrence of `needle` after `afterOffset`, wrapping to the
 * start of the buffer once the search runs off the end, skipping any
 * occurrence whose start is in `occupied` (this module's TSDoc's "skip
 * already-selected ranges") — `undefined` when every occurrence is already
 * occupied (or there are none at all), which is this command's documented
 * no-op ("further invocations no-op when everything is selected").
 */
function findNextMatch(
  haystack: string,
  needle: string,
  afterOffset: number,
  occupied: ReadonlySet<number>,
): number | undefined {
  const occurrences = allOccurrences(haystack, needle);
  const after = occurrences.filter((o) => o > afterOffset);
  const wrapped = occurrences.filter((o) => o <= afterOffset);
  for (const offset of [...after, ...wrapped]) {
    if (!occupied.has(offset)) return offset;
  }
  return undefined;
}

/** The grapheme-run word range containing (or immediately adjacent to)
 * `character` in `line`, or `undefined` when there is no word there (e.g.
 * the cursor sits in whitespace or punctuation with no word neighbor) — the
 * "word at cursor" this command expands an empty selection to. Reuses
 * `wordBoundary.ts`'s grapheme classification (Req 11.1's "reuse the
 * existing wordBoundary.ts") but, unlike that module's `wordBoundaryLeft`/
 * `wordBoundaryRight` (which find the NEXT boundary from a moving cursor),
 * this finds the full run of `"word"`-class graphemes touching a fixed
 * point — a different question movement doesn't need answered.
 */
function wordRangeAt(line: string, character: number): { start: number; end: number } | undefined {
  const graphemes = toGraphemes(line);
  if (graphemes.length === 0) return undefined;

  let index = graphemes.findIndex((g) => g.start <= character && character < g.end);
  if (index === -1 || graphemes[index]!.cls !== "word") {
    // Exactly at a boundary (including end of line), OR the grapheme under
    // the cursor is not a word (e.g. whitespace immediately to the right):
    // prefer the grapheme immediately to the LEFT, if it IS a word —
    // "cursor right after a word" should still select that word, matching
    // most editors' ctrl+d convention, even when the character to the
    // right happens to be a real (non-word) grapheme rather than "nothing
    // there" (`findIndex` returning -1). Only actually switches to it when
    // that left grapheme is a word — otherwise the checks below correctly
    // fall through to "no word here" (e.g. the cursor sits in the middle
    // of a run of whitespace with no word on either immediate side).
    const leftIndex = graphemes.findIndex((g) => g.end === character);
    if (leftIndex !== -1 && graphemes[leftIndex]!.cls === "word") {
      index = leftIndex;
    }
  }
  if (index === -1 || graphemes[index]!.cls !== "word") return undefined;

  let start = index;
  let end = index;
  while (start > 0 && graphemes[start - 1]!.cls === "word") start--;
  while (end < graphemes.length - 1 && graphemes[end + 1]!.cls === "word") end++;
  return { start: graphemes[start]!.start, end: graphemes[end]!.end };
}

/**
 * `editor.action.addSelectionToNextFindMatch` (Req 11.1): see this
 * module's TSDoc for the full contract. Returns `selections` UNCHANGED
 * (the same array reference's contents, a fresh copy) when there is
 * nothing to do — no word at the cursor, an empty search text, or every
 * occurrence already selected — so `index.ts` can treat "did nothing"
 * uniformly with its other commands' no-op convention.
 */
export function addSelectionToNextMatch(reader: LineReader, selections: readonly Selection[]): Selection[] {
  if (selections.length === 0) return [];
  const primary = selections[0]!;

  if (isCollapsed(primary)) {
    const line = reader.getLine(primary.active.line);
    const word = wordRangeAt(line, primary.active.character);
    if (!word) return [...selections];
    const start: Position = { line: primary.active.line, character: word.start };
    const end: Position = { line: primary.active.line, character: word.end };
    const newPrimary: Selection = { start, end, anchor: start, active: end };
    return [newPrimary, ...selections.slice(1)];
  }

  const { text, lineStarts } = readBuffer(reader);
  const startOffset = toOffset(primary.start, lineStarts);
  const endOffset = toOffset(primary.end, lineStarts);
  const needle = text.slice(startOffset, endOffset);
  if (needle.length === 0) return [...selections];

  const occupied = new Set(selections.map((s) => toOffset(s.start, lineStarts)));
  const matchStart = findNextMatch(text, needle, startOffset, occupied);
  if (matchStart === undefined) return [...selections];

  const matchEnd = matchStart + needle.length;
  const start = toPosition(matchStart, lineStarts);
  const end = toPosition(matchEnd, lineStarts);
  const newSelection: Selection = { start, end, anchor: start, active: end };
  return [newSelection, ...selections];
}
