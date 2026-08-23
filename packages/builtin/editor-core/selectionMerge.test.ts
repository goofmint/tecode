import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import { collapsedSelection, mergeSelections } from "./selectionMerge";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  return collapsedSelection(pos(line, character));
}

function forwardSelection(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: start, active: end };
}

function backwardSelection(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: end, active: start };
}

describe("mergeSelections (Req 6.6, 11.1)", () => {
  test("a single selection passes through unchanged", () => {
    const sel = cursorAt(0, 3);
    expect(mergeSelections([sel])) .toEqual([sel]);
  });

  test("non-overlapping selections are sorted but otherwise untouched", () => {
    const a = cursorAt(2, 0);
    const b = cursorAt(0, 0);
    const c = cursorAt(1, 0);
    expect(mergeSelections([a, b, c])).toEqual([b, c, a]);
  });

  test("two collapsed cursors on the same point merge into one", () => {
    const merged = mergeSelections([cursorAt(1, 4), cursorAt(1, 4)]);
    expect(merged).toEqual([cursorAt(1, 4)]);
  });

  test("overlapping ranges merge into their union", () => {
    const a = forwardSelection(0, 0, 0, 5);
    const b = forwardSelection(0, 3, 0, 8);
    expect(mergeSelections([a, b])).toEqual([forwardSelection(0, 0, 0, 8)]);
  });

  test("adjacent (touching) ranges merge into one", () => {
    const a = forwardSelection(0, 0, 0, 3);
    const b = forwardSelection(0, 3, 0, 6);
    expect(mergeSelections([a, b])).toEqual([forwardSelection(0, 0, 0, 6)]);
  });

  test("ranges with a gap between them do NOT merge", () => {
    const a = forwardSelection(0, 0, 0, 3);
    const b = forwardSelection(0, 4, 0, 6);
    expect(mergeSelections([a, b])).toEqual([a, b]);
  });

  test("merging two forward selections keeps the forward direction", () => {
    const a = forwardSelection(0, 0, 0, 5);
    const b = forwardSelection(0, 3, 0, 8);
    const [merged] = mergeSelections([a, b]);
    expect(merged!.anchor).toEqual(merged!.start);
    expect(merged!.active).toEqual(merged!.end);
  });

  test("merging two backward selections keeps the backward direction", () => {
    const a = backwardSelection(0, 0, 0, 5);
    const b = backwardSelection(0, 3, 0, 8);
    const [merged] = mergeSelections([a, b]);
    expect(merged!.anchor).toEqual(merged!.end);
    expect(merged!.active).toEqual(merged!.start);
  });

  test("a chain of three overlapping selections all merge into one", () => {
    const a = forwardSelection(0, 0, 0, 3);
    const b = forwardSelection(0, 2, 0, 5);
    const c = forwardSelection(0, 4, 0, 7);
    expect(mergeSelections([c, a, b])).toEqual([forwardSelection(0, 0, 0, 7)]);
  });

  test("an empty input returns an empty array", () => {
    expect(mergeSelections([])).toEqual([]);
  });
});
