import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import {
  applyMovement,
  charToVisualColumn,
  moveCharLeft,
  moveCharRight,
  moveDocumentEnd,
  moveDocumentStart,
  moveLineDown,
  moveLineEnd,
  moveLineHome,
  moveLineUp,
  moveWordLeft,
  moveWordRight,
  visualColumnToChar,
  type LineReader,
} from "./movement";
import { collapsedSelection } from "./selectionMerge";

function pos(line: number, character: number): Position {
  return { line, character };
}

function reader(lines: string[]): LineReader {
  return { getLine: (n) => lines[n] ?? "", lineCount: lines.length };
}

describe("moveCharLeft / moveCharRight (Req 11.1, grapheme-aware)", () => {
  const lines = ["ab", "cd"];

  test("moves one grapheme within a line", () => {
    expect(moveCharRight(reader(lines), pos(0, 0))).toEqual(pos(0, 1));
    expect(moveCharLeft(reader(lines), pos(0, 1))).toEqual(pos(0, 0));
  });

  test("crosses to the next/previous line at a line boundary", () => {
    expect(moveCharRight(reader(lines), pos(0, 2))).toEqual(pos(1, 0));
    expect(moveCharLeft(reader(lines), pos(1, 0))).toEqual(pos(0, 2));
  });

  test("stays put at the document start/end", () => {
    expect(moveCharLeft(reader(lines), pos(0, 0))).toEqual(pos(0, 0));
    expect(moveCharRight(reader(lines), pos(1, 2))).toEqual(pos(1, 2));
  });

  test("steps over a surrogate-pair grapheme as one unit", () => {
    const r = reader(["a😀b"]);
    expect(moveCharRight(r, pos(0, 1))).toEqual(pos(0, 3));
    expect(moveCharLeft(r, pos(0, 3))).toEqual(pos(0, 1));
  });
});

describe("moveWordLeft / moveWordRight (Req 11.1)", () => {
  const lines = ["foo bar", "baz"];

  test("moves within a line via wordBoundary", () => {
    expect(moveWordRight(reader(lines), pos(0, 0))).toEqual(pos(0, 4));
    expect(moveWordLeft(reader(lines), pos(0, 4))).toEqual(pos(0, 0));
  });

  test("crosses to the next line when already at end of line", () => {
    expect(moveWordRight(reader(lines), pos(0, 7))).toEqual(pos(1, 0));
  });

  test("crosses to the end of the previous line when already at column 0", () => {
    expect(moveWordLeft(reader(lines), pos(1, 0))).toEqual(pos(0, 7));
  });

  test("stays put at the document start/end", () => {
    expect(moveWordLeft(reader(lines), pos(0, 0))).toEqual(pos(0, 0));
    expect(moveWordRight(reader(lines), pos(1, 3))).toEqual(pos(1, 3));
  });
});

describe("moveLineHome / moveLineEnd (Req 11.1, smart home)", () => {
  test("first press goes to the first non-whitespace character", () => {
    expect(moveLineHome(reader(["  abc"]), pos(0, 4))).toEqual(pos(0, 2));
  });

  test("pressing home again from the indent goes to column 0", () => {
    expect(moveLineHome(reader(["  abc"]), pos(0, 2))).toEqual(pos(0, 0));
  });

  test("a line with no indentation: home always goes to column 0", () => {
    expect(moveLineHome(reader(["abc"]), pos(0, 2))).toEqual(pos(0, 0));
  });

  test("end goes to the line's length", () => {
    expect(moveLineEnd(reader(["abc"]), pos(0, 0))).toEqual(pos(0, 3));
  });
});

describe("charToVisualColumn / visualColumnToChar (Req 11.1, tab-stop algorithm)", () => {
  test("plain characters count one column each", () => {
    expect(charToVisualColumn("abcd", 3, 4)).toBe(3);
  });

  test("a tab advances to the next tabSize-wide stop", () => {
    expect(charToVisualColumn("\tx", 1, 4)).toBe(4);
    expect(charToVisualColumn("a\tx", 2, 4)).toBe(4);
    expect(charToVisualColumn("ab\tx", 3, 4)).toBe(4);
  });

  test("visualColumnToChar is the inverse of charToVisualColumn for exact stops", () => {
    const line = "\tabc";
    const column = charToVisualColumn(line, 3, 4); // through "\tab"
    expect(visualColumnToChar(line, column, 4)).toBe(3);
  });

  test("visualColumnToChar clamps to the line length past the end", () => {
    expect(visualColumnToChar("ab", 99, 4)).toBe(2);
  });
});

describe("moveLineUp / moveLineDown (Req 11.1, preserves visual column across tabs)", () => {
  test("preserves a plain character column across two same-shape lines", () => {
    const r = reader(["abcdef", "ghijkl"]);
    expect(moveLineDown(r, pos(0, 3), 4)).toEqual(pos(1, 3));
    expect(moveLineUp(r, pos(1, 3), 4)).toEqual(pos(0, 3));
  });

  test("maps visual column through a tab on the target line", () => {
    // Line 0: caret at column 4 (visual column 4, "abcd|ef"). Line 1 starts
    // with a tab (visual columns 0-3), so visual column 4 on line 1 lands
    // right after the tab, at character 1.
    const r = reader(["abcdef", "\txyz"]);
    expect(moveLineDown(r, pos(0, 4), 4)).toEqual(pos(1, 1));
  });

  test("clamped at the first/last line: position is unchanged", () => {
    const r = reader(["abc", "def"]);
    expect(moveLineUp(r, pos(0, 1), 4)).toEqual(pos(0, 1));
    expect(moveLineDown(r, pos(1, 1), 4)).toEqual(pos(1, 1));
  });

  test("a shorter target line clamps the column to its own length", () => {
    const r = reader(["abcdef", "ab"]);
    expect(moveLineDown(r, pos(0, 5), 4)).toEqual(pos(1, 2));
  });
});

describe("moveDocumentStart / moveDocumentEnd (Req 11.1)", () => {
  test("document start is always (0, 0)", () => {
    expect(moveDocumentStart()).toEqual(pos(0, 0));
  });

  test("document end is the end of the last line", () => {
    expect(moveDocumentEnd(reader(["abc", "de"]))).toEqual(pos(1, 2));
  });
});

describe("applyMovement (Req 6.6, 11.1 — multi-cursor + merge)", () => {
  function cursorAt(line: number, character: number): Selection {
    return collapsedSelection(pos(line, character));
  }

  test("collapsed move: every cursor moves independently to a new collapsed position", () => {
    const selections = [cursorAt(0, 0), cursorAt(1, 0)];
    const result = applyMovement(selections, false, (p) => ({ line: p.line, character: p.character + 1 }));
    expect(result).toEqual([cursorAt(0, 1), cursorAt(1, 1)]);
  });

  test("extending move: anchor stays fixed, active moves", () => {
    const selections = [cursorAt(0, 2)];
    const result = applyMovement(selections, true, (p) => ({ line: p.line, character: p.character + 3 }));
    expect(result).toEqual([{ start: pos(0, 2), end: pos(0, 5), anchor: pos(0, 2), active: pos(0, 5) }]);
  });

  test("extending move backward keeps start/end in document order with a backward direction", () => {
    const selections = [cursorAt(0, 5)];
    const result = applyMovement(selections, true, (p) => ({ line: p.line, character: p.character - 3 }));
    expect(result).toEqual([{ start: pos(0, 2), end: pos(0, 5), anchor: pos(0, 5), active: pos(0, 2) }]);
  });

  test("two cursors that land on the same point after moving merge into one", () => {
    const selections = [cursorAt(0, 0), cursorAt(0, 2)];
    const result = applyMovement(selections, false, () => pos(0, 5));
    expect(result).toEqual([cursorAt(0, 5)]);
  });
});
