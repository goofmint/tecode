import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import { buildToggleLineCommentResult } from "./comments";
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

/** Apply `edits` to a plain `string[]` — enough to check a toggle's actual
 * text output without a real `Document`. */
function applyToLines(lines: string[], edits: { range: { start: Position; end: Position }; newText: string }[]): string[] {
  const result = [...lines];
  const sorted = [...edits].sort((a, b) => b.range.start.character - a.range.start.character);
  for (const edit of sorted) {
    const line = result[edit.range.start.line]!;
    result[edit.range.start.line] =
      line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
  }
  return result;
}

describe("buildToggleLineCommentResult (Req 11.1)", () => {
  test("comments an uncommented line", () => {
    const reader = readerOf(["const a = 1;"]);
    const { edits } = buildToggleLineCommentResult(reader, [cursorAt(0, 0)], "//");
    expect(applyToLines(["const a = 1;"], edits)).toEqual(["// const a = 1;"]);
  });

  test("uncomments an already-commented line", () => {
    const reader = readerOf(["// const a = 1;"]);
    const { edits } = buildToggleLineCommentResult(reader, [cursorAt(0, 0)], "//");
    expect(applyToLines(["// const a = 1;"], edits)).toEqual(["const a = 1;"]);
  });

  test("uncommenting tolerates a marker with no following space", () => {
    const reader = readerOf(["//const a = 1;"]);
    const { edits } = buildToggleLineCommentResult(reader, [cursorAt(0, 0)], "//");
    expect(applyToLines(["//const a = 1;"], edits)).toEqual(["const a = 1;"]);
  });

  test("comments preserving leading indentation", () => {
    const reader = readerOf(["    indented();"]);
    const { edits } = buildToggleLineCommentResult(reader, [cursorAt(0, 4)], "//");
    expect(applyToLines(["    indented();"], edits)).toEqual(["    // indented();"]);
  });

  test("a mixed selection (some commented, some not) comments everything", () => {
    const lines = ["// already", "not yet"];
    const reader = readerOf(lines);
    const selection: Selection = { start: pos(0, 0), end: pos(1, 7), anchor: pos(0, 0), active: pos(1, 7) };
    const { edits } = buildToggleLineCommentResult(reader, [selection], "//");
    // Only the uncommented line gets an edit; the already-commented one is
    // left untouched.
    expect(applyToLines(lines, edits)).toEqual(["// already", "// not yet"]);
  });

  test("toggling twice round-trips to the original text exactly", () => {
    const original = ["const a = 1;", "const b = 2;"];
    const reader1 = readerOf(original);
    const selection: Selection = { start: pos(0, 0), end: pos(1, 12), anchor: pos(0, 0), active: pos(1, 12) };
    const { edits: commentEdits } = buildToggleLineCommentResult(reader1, [selection], "//");
    const commented = applyToLines(original, commentEdits);

    const reader2 = readerOf(commented);
    const { edits: uncommentEdits } = buildToggleLineCommentResult(reader2, [selection], "//");
    const roundTripped = applyToLines(commented, uncommentEdits);

    expect(roundTripped).toEqual(original);
  });

  test("no-op with no target lines' content changed when every selection collapses to the same line twice", () => {
    const reader = readerOf(["abc"]);
    const { edits } = buildToggleLineCommentResult(reader, [cursorAt(0, 0), cursorAt(0, 2)], "//");
    // Two cursors on the same line still produce exactly one edit for it.
    expect(edits).toHaveLength(1);
  });
});
