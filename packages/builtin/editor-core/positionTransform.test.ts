import { describe, expect, test } from "bun:test";
import type { Position, TextEdit } from "@tecode/api";
import { comparePositions, dropOverlapping, transformPosition } from "./positionTransform";

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

describe("transformPosition — tracking range.end (this module's TSDoc)", () => {
  test("a position entirely before the edit is unaffected", () => {
    expect(transformPosition(pos(0, 2), [edit(0, 5, 0, 5, "x")])).toEqual(pos(0, 2));
  });

  test("collapsed insert: the caret lands after the inserted text", () => {
    // range.start === range.end === the insertion point (a typed
    // character, or `tecode.editor`'s tab/newline commands with a
    // collapsed cursor).
    expect(transformPosition(pos(0, 5), [edit(0, 5, 0, 5, "x")])).toEqual(pos(0, 6));
  });

  test("insert replacing a FORWARD selection: the caret lands after the inserted text", () => {
    // Selection [2, 5) forward (active === range.end); tracking
    // range.end === 5 must land after "xyz".
    expect(transformPosition(pos(0, 5), [edit(0, 2, 0, 5, "xyz")])).toEqual(pos(0, 5));
  });

  test("insert replacing a BACKWARD selection: the caret still lands after the inserted text", () => {
    // A backward selection's `active` is `range.start` (2), not
    // `range.end` (5) — this module's whole reason to track `range.end`
    // instead of `active` (core's router can safely use `active` because
    // it never builds this shape; editing.ts's callers must not use
    // `selection.active` here, and this test is the regression guard).
    expect(transformPosition(pos(0, 5), [edit(0, 2, 0, 5, "xyz")])).toEqual(pos(0, 5));
  });

  test("single-grapheme backspace: the caret lands where the deleted text used to end", () => {
    // range [4, 5) removed, newText "" — tracked point is range.end (5).
    expect(transformPosition(pos(0, 5), [edit(0, 4, 0, 5, "")])).toEqual(pos(0, 4));
  });

  test("single-grapheme forward-delete: the caret does not move", () => {
    // range [5, 6) removed, newText "" — tracked point is range.end (6),
    // which reduces to range.start (5): the deletion happens to the RIGHT
    // of the caret, so the caret itself does not move.
    expect(transformPosition(pos(0, 6), [edit(0, 5, 0, 6, "")])).toEqual(pos(0, 5));
  });

  test("line-join forward-delete (delete at end of line): the caret does not move", () => {
    expect(transformPosition(pos(1, 0), [edit(0, 7, 1, 0, "")])).toEqual(pos(0, 7));
  });

  test("deleting a non-collapsed selection: the caret lands at the selection's start", () => {
    expect(transformPosition(pos(0, 8), [edit(0, 3, 0, 8, "")])).toEqual(pos(0, 3));
  });

  test("newline insert: the caret lands at the start of the new line, past any auto-indent", () => {
    expect(transformPosition(pos(1, 4), [edit(1, 4, 1, 4, "\n  ")])).toEqual(pos(2, 2));
  });

  test("an unrelated cursor further down the same line shifts by the insert's length", () => {
    expect(transformPosition(pos(0, 10), [edit(0, 2, 0, 2, "ab")])).toEqual(pos(0, 12));
  });

  test("an unrelated cursor on a later line is unaffected by a same-line insert", () => {
    expect(transformPosition(pos(1, 3), [edit(0, 2, 0, 2, "ab")])).toEqual(pos(1, 3));
  });

  test("an unrelated cursor below a multi-line insert shifts down by the added line count", () => {
    expect(transformPosition(pos(2, 0), [edit(1, 0, 1, 0, "a\nb\n")])).toEqual(pos(4, 0));
  });

  describe("multiple same-line multi-line edits (Finding 1 regression — negative character bug)", () => {
    // "abcdefgh", cursors (0,2) and (0,5), Enter at both -> two collapsed
    // "\n" inserts. Cursor1's own edit is the containing/tracked edit at
    // (0,2); cursor2's tracked point (0,5) must run through BOTH edits.
    const plainEdits = [edit(0, 2, 0, 2, "\n"), edit(0, 5, 0, 5, "\n")];

    test("second cursor lands at (2, 0), not (2, -2)", () => {
      expect(transformPosition(pos(0, 5), plainEdits)).toEqual(pos(2, 0));
    });

    test("input order does not change the result", () => {
      const reversed = [...plainEdits].reverse();
      expect(transformPosition(pos(0, 5), reversed)).toEqual(pos(2, 0));
    });

    // "  abcdef", cursors (0,4) and (0,6), Enter with auto-indent "  " at
    // both -> two "\n  " inserts. Cursor2's tracked point (0,6) must land
    // past the SECOND inserted indent, at (2, 2), not (2, 0).
    const indentedEdits = [edit(0, 4, 0, 4, "\n  "), edit(0, 6, 0, 6, "\n  ")];

    test("second cursor with auto-indent lands at (2, 2), not (2, 0)", () => {
      expect(transformPosition(pos(0, 6), indentedEdits)).toEqual(pos(2, 2));
    });

    test("input order does not change the indented result", () => {
      const reversed = [...indentedEdits].reverse();
      expect(transformPosition(pos(0, 6), reversed)).toEqual(pos(2, 2));
    });
  });
});

describe("dropOverlapping (this module's TSDoc)", () => {
  test("non-overlapping edits are all kept, in their original order irrespective of input order", () => {
    const a = edit(0, 0, 0, 1, "a");
    const b = edit(0, 5, 0, 6, "b");
    expect(dropOverlapping([b, a])).toEqual([a, b]);
  });

  test("an overlapping later edit is dropped; the earlier one wins", () => {
    const earlier = edit(0, 0, 0, 5, "");
    const later = edit(0, 3, 0, 8, "");
    expect(dropOverlapping([earlier, later])).toEqual([earlier]);
    expect(dropOverlapping([later, earlier])).toEqual([earlier]);
  });

  test("edits that only touch (end === next start) are both kept", () => {
    const a = edit(0, 0, 0, 3, "");
    const b = edit(0, 3, 0, 6, "");
    expect(dropOverlapping([a, b])).toEqual([a, b]);
  });
});
