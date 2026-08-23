import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import { addSelectionToNextMatch, type LineReader } from "./multiCursor";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  const p = pos(line, character);
  return { start: p, end: p, anchor: p, active: p };
}

function range(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: start, active: end };
}

function readerOf(lines: string[]): LineReader {
  return { getLine: (n) => lines[n]!, lineCount: lines.length };
}

describe("addSelectionToNextMatch (ctrl+d, Req 11.1)", () => {
  test("an empty primary selection expands to the word at the cursor", () => {
    const reader = readerOf(["foo bar baz"]);
    const result = addSelectionToNextMatch(reader, [cursorAt(0, 5)]); // inside "bar"
    expect(result).toEqual([range(0, 4, 0, 7)]);
  });

  test("no word at the cursor (whitespace) is a documented no-op", () => {
    const reader = readerOf(["foo   bar"]);
    const selections = [cursorAt(0, 4)];
    expect(addSelectionToNextMatch(reader, selections)).toEqual(selections);
  });

  test("cursor immediately after a word, with whitespace to its right, still selects that word", () => {
    const reader = readerOf(["foo bar"]);
    const selections = [cursorAt(0, 3)]; // right after "foo", before the space
    expect(addSelectionToNextMatch(reader, selections)).toEqual([range(0, 0, 0, 3)]);
  });

  test("cursor in whitespace not adjacent to any word is still a no-op", () => {
    const reader = readerOf(["foo   bar"]);
    const selections = [cursorAt(0, 4)]; // middle of the 3-space run, no word on either side
    expect(addSelectionToNextMatch(reader, selections)).toEqual(selections);
  });

  test("full sequence: word select -> next match -> wraparound -> all-matches no-op", () => {
    const reader = readerOf(["foo bar foo baz foo"]);
    let selections = [cursorAt(0, 9)]; // inside the middle "foo" (offsets 8-11)

    selections = addSelectionToNextMatch(reader, selections);
    expect(selections).toEqual([range(0, 8, 0, 11)]);

    selections = addSelectionToNextMatch(reader, selections);
    expect(selections[0]).toEqual(range(0, 16, 0, 19));
    expect(selections).toHaveLength(2);

    selections = addSelectionToNextMatch(reader, selections); // wraps to the first occurrence
    expect(selections[0]).toEqual(range(0, 0, 0, 3));
    expect(selections).toHaveLength(3);

    const beforeNoOp = selections;
    selections = addSelectionToNextMatch(reader, selections); // every occurrence already selected
    expect(selections).toEqual(beforeNoOp);
  });

  test("skips an occurrence that is already selected mid-buffer", () => {
    // Two matches selected out of order (not the primary-driven sequence);
    // the next call must still skip both and land on the remaining one.
    const reader = readerOf(["x x x"]);
    const selections = [range(0, 4, 0, 5), range(0, 0, 0, 1)];
    const result = addSelectionToNextMatch(reader, selections);
    expect(result[0]).toEqual(range(0, 2, 0, 3));
    expect(result).toHaveLength(3);
  });

  test("primary at the last unselected occurrence: no more matches is a no-op", () => {
    const reader = readerOf(["x x"]);
    const selections = [range(0, 2, 0, 3), range(0, 0, 0, 1)];
    expect(addSelectionToNextMatch(reader, selections)).toEqual(selections);
  });
});
