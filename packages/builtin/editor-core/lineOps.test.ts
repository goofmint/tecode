import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import {
  affectedLineRange,
  buildDeleteLineResult,
  buildDuplicateLineResult,
  buildMoveLinesDownResult,
  buildMoveLinesUpResult,
  groupSelectionLines,
} from "./lineOps";
import type { LineReader } from "./movement";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  const p = pos(line, character);
  return { start: p, end: p, anchor: p, active: p };
}

function readerOf(lines: string[]): LineReader {
  return { getLine: (n) => lines[n]!, lineCount: lines.length };
}

describe("affectedLineRange", () => {
  test("a collapsed cursor's own line", () => {
    expect(affectedLineRange(cursorAt(3, 5))).toEqual([3, 3]);
  });

  test("a selection ending exactly at column 0 of a later line excludes it", () => {
    const selection: Selection = { start: pos(1, 2), end: pos(3, 0), anchor: pos(1, 2), active: pos(3, 0) };
    expect(affectedLineRange(selection)).toEqual([1, 2]);
  });

  test("a selection ending mid-line includes it", () => {
    const selection: Selection = { start: pos(1, 2), end: pos(3, 4), anchor: pos(1, 2), active: pos(3, 4) };
    expect(affectedLineRange(selection)).toEqual([1, 3]);
  });
});

describe("groupSelectionLines", () => {
  test("two cursors on distinct, non-adjacent lines stay separate groups", () => {
    expect(groupSelectionLines([cursorAt(0, 0), cursorAt(2, 0)])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  test("two cursors on adjacent lines merge into one group", () => {
    expect(groupSelectionLines([cursorAt(3, 0), cursorAt(4, 0)])).toEqual([[3, 4]]);
  });

  test("two cursors on the same line dedupe into one single-line group", () => {
    expect(groupSelectionLines([cursorAt(2, 0), cursorAt(2, 5)])).toEqual([[2, 2]]);
  });
});

describe("buildDuplicateLineResult (Req 11.1)", () => {
  test("duplicates a single line, cursor follows the duplicate", () => {
    const reader = readerOf(["aaa", "bbb"]);
    const { edit, selections } = buildDuplicateLineResult(reader, [cursorAt(0, 2)]);
    expect(edit?.newText).toBe("aaa\naaa\nbbb");
    expect(selections).toEqual([cursorAt(1, 2)]);
  });

  test("is correct with two cursors on distinct lines", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildDuplicateLineResult(reader, [cursorAt(0, 1), cursorAt(2, 2)]);
    expect(edit?.newText).toBe("aaa\naaa\nbbb\nccc\nccc");
    expect(selections).toEqual([cursorAt(1, 1), cursorAt(4, 2)]);
  });

  test("two cursors on adjacent lines duplicate as one block", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildDuplicateLineResult(reader, [cursorAt(0, 0), cursorAt(1, 0)]);
    expect(edit?.newText).toBe("aaa\nbbb\naaa\nbbb\nccc");
    expect(selections).toEqual([cursorAt(2, 0), cursorAt(3, 0)]);
  });
});

describe("buildMoveLinesUpResult / buildMoveLinesDownResult (Req 11.1)", () => {
  test("moves a single line up, swapping with its neighbor", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildMoveLinesUpResult(reader, [cursorAt(1, 1)]);
    expect(edit?.newText).toBe("bbb\naaa\nccc");
    expect(selections).toEqual([cursorAt(0, 1)]);
  });

  test("is a no-op at the top of the buffer", () => {
    const reader = readerOf(["aaa", "bbb"]);
    const result = buildMoveLinesUpResult(reader, [cursorAt(0, 0)]);
    expect(result.edit).toBeUndefined();
  });

  test("moves a single line down, swapping with its neighbor", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildMoveLinesDownResult(reader, [cursorAt(1, 1)]);
    expect(edit?.newText).toBe("aaa\nccc\nbbb");
    expect(selections).toEqual([cursorAt(2, 1)]);
  });

  test("is a no-op at the bottom of the buffer", () => {
    const reader = readerOf(["aaa", "bbb"]);
    const result = buildMoveLinesDownResult(reader, [cursorAt(1, 0)]);
    expect(result.edit).toBeUndefined();
  });

  test("one movable and one immovable cursor: only the movable one moves", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildMoveLinesUpResult(reader, [cursorAt(0, 0), cursorAt(2, 0)]);
    // Line 0 can't move further up; line 2 swaps with line 1.
    expect(edit?.newText).toBe("aaa\nccc\nbbb");
    expect(selections).toEqual([cursorAt(0, 0), cursorAt(1, 0)]);
  });
});

describe("buildDeleteLineResult (Req 11.1)", () => {
  test("deletes a middle line, cursor lands at column 0 of what took its place", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildDeleteLineResult(reader, [cursorAt(1, 2)]);
    expect(edit?.newText).toBe("aaa\nccc");
    expect(selections).toEqual([cursorAt(1, 0)]);
  });

  test("handles the trailing-newline edge: deleting the last line", () => {
    const reader = readerOf(["aaa", "bbb", "ccc"]);
    const { edit, selections } = buildDeleteLineResult(reader, [cursorAt(2, 3)]);
    expect(edit?.newText).toBe("aaa\nbbb");
    expect(selections).toEqual([cursorAt(1, 0)]);
  });

  test("deleting the only line leaves a single empty line", () => {
    const reader = readerOf(["only"]);
    const { edit, selections } = buildDeleteLineResult(reader, [cursorAt(0, 2)]);
    expect(edit?.newText).toBe("");
    expect(selections).toEqual([cursorAt(0, 0)]);
  });

  test("is correct with two cursors on distinct lines", () => {
    const reader = readerOf(["aaa", "bbb", "ccc", "ddd"]);
    const { edit, selections } = buildDeleteLineResult(reader, [cursorAt(0, 0), cursorAt(2, 0)]);
    expect(edit?.newText).toBe("bbb\nddd");
    expect(selections).toEqual([cursorAt(0, 0), cursorAt(1, 0)]);
  });
});
