import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import type { LineReader } from "./movement";
import { buildClipboardText, buildCutResult, buildPasteResult } from "./clipboard";
import { collapsedSelection } from "./selectionMerge";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  return collapsedSelection(pos(line, character));
}

function selectionOf(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: start, active: end };
}

function reversedSelectionOf(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: end, active: start };
}

function reader(lines: string[]): LineReader {
  return { getLine: (n) => lines[n] ?? "", lineCount: lines.length };
}

describe("buildClipboardText (Issue #91)", () => {
  test("empty selections array: \"\"", () => {
    expect(buildClipboardText(reader(["abc"]), [])).toBe("");
  });

  test("a single collapsed cursor: \"\" (nothing selected)", () => {
    expect(buildClipboardText(reader(["abc"]), [cursorAt(0, 1)])).toBe("");
  });

  test("a single non-collapsed selection: its own text", () => {
    const text = buildClipboardText(reader(["hello world"]), [selectionOf(0, 6, 0, 11)]);
    expect(text).toBe("world");
  });

  test("a selection spanning multiple lines includes the real newline(s) in between", () => {
    const text = buildClipboardText(reader(["abc", "def", "ghi"]), [selectionOf(0, 1, 2, 2)]);
    expect(text).toBe("bc\ndef\ngh");
  });

  test("multiple cursors: each selection's own text, joined by \\n, in selection order", () => {
    const text = buildClipboardText(reader(["foo bar", "baz qux"]), [
      selectionOf(0, 0, 0, 3),
      selectionOf(1, 4, 1, 7),
    ]);
    expect(text).toBe("foo\nqux");
  });

  test("direction (forward vs backward selection) does not change the copied text", () => {
    const forward = buildClipboardText(reader(["abcdef"]), [selectionOf(0, 1, 0, 4)]);
    const backward = buildClipboardText(reader(["abcdef"]), [reversedSelectionOf(0, 1, 0, 4)]);
    expect(forward).toBe("bcd");
    expect(backward).toBe("bcd");
  });
});

describe("buildCutResult (Issue #91)", () => {
  test("a collapsed cursor: no edit, unchanged position, empty clipboard text", () => {
    const result = buildCutResult(reader(["abc"]), [cursorAt(0, 1)]);
    expect(result.text).toBe("");
    expect(result.edits).toHaveLength(0);
    expect(result.selections).toEqual([cursorAt(0, 1)]);
  });

  test("a single non-collapsed selection: deletes the range, collapses the cursor to the start, copies the cut text", () => {
    const result = buildCutResult(reader(["hello world"]), [selectionOf(0, 6, 0, 11)]);
    expect(result.text).toBe("world");
    expect(result.edits).toEqual([{ range: { start: pos(0, 6), end: pos(0, 11) }, newText: "" }]);
    expect(result.selections).toEqual([cursorAt(0, 6)]);
  });

  test("multiple cursors: only non-collapsed selections produce edits; the batch is ONE edits array, both cursors' text is still copied", () => {
    const result = buildCutResult(reader(["aaa bbb ccc"]), [
      selectionOf(0, 0, 0, 3), // "aaa"
      cursorAt(0, 5), // collapsed — nothing to delete
      selectionOf(0, 8, 0, 11), // "ccc"
    ]);
    expect(result.text).toBe("aaa\n\nccc");
    expect(result.edits).toHaveLength(2); // only the two non-collapsed selections
  });

  test("a backward (reversed anchor/active) selection still cuts correctly and collapses to its start", () => {
    const result = buildCutResult(reader(["abcdef"]), [reversedSelectionOf(0, 1, 0, 4)]);
    expect(result.text).toBe("bcd");
    expect(result.selections).toEqual([cursorAt(0, 1)]);
  });
});

describe("buildPasteResult (Issue #91)", () => {
  test("a single collapsed cursor: inserts the pasted text, caret lands after it", () => {
    const result = buildPasteResult([cursorAt(0, 1)], "XY");
    expect(result.edits).toEqual([{ range: { start: pos(0, 1), end: pos(0, 1) }, newText: "XY" }]);
    expect(result.selections).toEqual([cursorAt(0, 3)]);
  });

  test("a non-collapsed selection is replaced wholesale, caret lands at the end of the pasted text", () => {
    const result = buildPasteResult([selectionOf(0, 1, 0, 4)], "Z");
    expect(result.edits).toEqual([{ range: { start: pos(0, 1), end: pos(0, 4) }, newText: "Z" }]);
    expect(result.selections).toEqual([cursorAt(0, 2)]);
  });

  test("a backward selection is still replaced correctly, not from the wrong end", () => {
    const result = buildPasteResult([reversedSelectionOf(0, 1, 0, 4)], "Z");
    expect(result.selections).toEqual([cursorAt(0, 2)]);
  });

  test("multi-line pasted text at a single cursor lands the caret on the pasted text's own last line", () => {
    // Regression coverage for the exact class of bug `positionTransform.ts`
    // (both `@tecode/core`'s and this package's own copy) had to get right
    // for a multi-line replacement whose edit does not start at column 0.
    const result = buildPasteResult([cursorAt(0, 1)], "line1\nline2\nline3");
    expect(result.selections).toEqual([cursorAt(2, 5)]); // "line3".length
  });

  test("two cursors on the same line: the second cursor's position accounts for the first's own paste", () => {
    const result = buildPasteResult([cursorAt(0, 2), cursorAt(0, 5)], "ab");
    expect(result.edits).toHaveLength(2);
    expect(result.selections).toEqual([cursorAt(0, 4), cursorAt(0, 9)]);
  });
});
