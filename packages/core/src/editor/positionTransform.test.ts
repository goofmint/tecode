import { describe, expect, test } from "bun:test";
import type { Position, TextEdit } from "@tecode/api";
import { comparePositions, transformPosition } from "./positionTransform";

function pos(line: number, character: number): Position {
  return { line, character };
}

function edit(startLine: number, startChar: number, endLine: number, endChar: number, newText: string): TextEdit {
  return { range: { start: pos(startLine, startChar), end: pos(endLine, endChar) }, newText };
}

describe("comparePositions", () => {
  test("orders by line first, then character", () => {
    expect(comparePositions(pos(0, 5), pos(1, 0))).toBeLessThan(0);
    expect(comparePositions(pos(2, 3), pos(2, 3))).toBe(0);
    expect(comparePositions(pos(2, 4), pos(2, 3))).toBeGreaterThan(0);
  });
});

describe("transformPosition (Task 2.2, editor/positionTransform.ts)", () => {
  test("a position entirely before the edit is unaffected", () => {
    const result = transformPosition(pos(0, 2), [edit(0, 5, 0, 5, "x")]);
    expect(result).toEqual(pos(0, 2));
  });

  test("an insert at a position advances it by the inserted length (own-cursor case)", () => {
    // Collapsed insert: range.start === range.end === the cursor's own
    // position — the shape editor/inputRouter.ts builds for a typed
    // character.
    const result = transformPosition(pos(0, 5), [edit(0, 5, 0, 5, "x")]);
    expect(result).toEqual(pos(0, 6));
  });

  test("an insert earlier on the same line shifts a later position's character", () => {
    const result = transformPosition(pos(0, 10), [edit(0, 2, 0, 2, "ab")]);
    expect(result).toEqual(pos(0, 12));
  });

  test("an insert on an earlier line does not affect a position on a later line", () => {
    const result = transformPosition(pos(3, 4), [edit(0, 2, 0, 2, "hello")]);
    expect(result).toEqual(pos(3, 4));
  });

  test("a single-character backspace moves the deleting cursor's own position back one", () => {
    // Backspace at (0,5): range [ (0,4), (0,5) ), newText "" — the
    // cursor's own new position is (0,4).
    const result = transformPosition(pos(0, 5), [edit(0, 4, 0, 5, "")]);
    expect(result).toEqual(pos(0, 4));
  });

  test("a line-join backspace moves the cursor onto the end of the previous line", () => {
    // Backspace at (2,0) with a 6-char previous line: range [ (1,6), (2,0) ).
    const result = transformPosition(pos(2, 0), [edit(1, 6, 2, 0, "")]);
    expect(result).toEqual(pos(1, 6));
  });

  test("a forward-delete does not move the deleting cursor's own position", () => {
    // Delete at (0,3): range [ (0,3), (0,4) ) — active === range.start.
    const result = transformPosition(pos(0, 3), [edit(0, 3, 0, 4, "")]);
    expect(result).toEqual(pos(0, 3));
  });

  test("a position strictly inside a deleted range clamps to the range's start", () => {
    const result = transformPosition(pos(0, 6), [edit(0, 4, 0, 10, "")]);
    expect(result).toEqual(pos(0, 4));
  });

  test("a multi-line deletion (line join) shifts a position on a much later line up", () => {
    // Two lines merged into one (net line delta -1); a position 5 lines
    // below the edit shifts up by exactly that delta.
    const result = transformPosition(pos(7, 2), [edit(1, 3, 2, 0, "")]);
    expect(result).toEqual(pos(6, 2));
  });

  test("multiple edits on the same original line accumulate additively, regardless of order", () => {
    // Two independent single-character inserts earlier on the same line
    // (as two different cursors typing simultaneously would produce),
    // both strictly before the target position.
    const edits = [edit(0, 2, 0, 2, "a"), edit(0, 5, 0, 5, "b")];
    const forward = transformPosition(pos(0, 8), edits);
    const reversed = transformPosition(pos(0, 8), [...edits].reverse());
    expect(forward).toEqual(pos(0, 10));
    expect(reversed).toEqual(forward);
  });

  test("an edit exactly at the target position (range.start === position) leaves it unaffected", () => {
    // Forward-delete's own cursor case, reconfirmed as a boundary check:
    // position equal to range.start (not >) is bucket 3, not bucket 2.
    const result = transformPosition(pos(0, 4), [edit(0, 4, 0, 6, "")]);
    expect(result).toEqual(pos(0, 4));
  });

  test("no edits at all is the identity", () => {
    expect(transformPosition(pos(3, 3), [])).toEqual(pos(3, 3));
  });

  test("a clamped position still shifts by a preceding edit, regardless of edit order", () => {
    // Position (0,6) sits strictly inside the replacement (0,4)-(0,10), so
    // it clamps to that edit's start (0,4) — which the insert of "x" at
    // (0,2) then shifts right by one, landing at (0,5). The clamp anchors
    // FIRST, so the preceding edit's delta must survive in both batch
    // orders (regression: the old bucket-2 branch overwrote the shift when
    // the containing edit came second, yielding (0,4)/(0,5) depending on
    // order).
    const edits = [edit(0, 2, 0, 2, "x"), edit(0, 4, 0, 10, "")];
    const forward = transformPosition(pos(0, 6), edits);
    const reversed = transformPosition(pos(0, 6), [...edits].reverse());
    expect(forward).toEqual(pos(0, 5));
    expect(reversed).toEqual(forward);
  });
});
