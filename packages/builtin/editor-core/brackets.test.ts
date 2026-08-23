import { describe, expect, test } from "bun:test";
import type { BracketPair, Position, Selection } from "@tecode/api";
import { buildBracketEditBatch } from "./brackets";
import type { LineReader } from "./movement";

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

const PAIRS: BracketPair[] = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
  { open: '"', close: '"' },
  { open: "'", close: "'" },
];

describe("buildBracketEditBatch — insert (Req 11.1)", () => {
  test("an open bracket at a collapsed cursor inserts the pair, caret between", () => {
    const reader = readerOf([""]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 0)], "(", PAIRS);
    expect(edits).toEqual([{ range: { start: pos(0, 0), end: pos(0, 0) }, newText: "()" }]);
    expect(selections).toEqual([cursorAt(0, 1)]);
  });

  test("a plain character with no registered pairs is a bare insert", () => {
    const reader = readerOf([""]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 0)], "(", []);
    expect(edits).toEqual([{ range: { start: pos(0, 0), end: pos(0, 0) }, newText: "(" }]);
    expect(selections).toEqual([cursorAt(0, 1)]);
  });

  test("a stray closer with nothing to type-over inserts plainly", () => {
    const reader = readerOf(["abc"]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 1)], ")", PAIRS);
    expect(edits).toEqual([{ range: { start: pos(0, 1), end: pos(0, 1) }, newText: ")" }]);
    expect(selections).toEqual([cursorAt(0, 2)]);
  });
});

describe("buildBracketEditBatch — type-over (Req 11.1)", () => {
  test("typing the closer right before an existing one advances without an edit", () => {
    const reader = readerOf(["()"]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 1)], ")", PAIRS);
    expect(edits).toEqual([]);
    expect(selections).toEqual([cursorAt(0, 2)]);
  });

  test("a quote typed right before an existing quote skips over it", () => {
    const reader = readerOf(['""']);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 1)], '"', PAIRS);
    expect(edits).toEqual([]);
    expect(selections).toEqual([cursorAt(0, 2)]);
  });

  test("a quote NOT immediately before another one inserts a new pair", () => {
    const reader = readerOf(["a"]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 0)], '"', PAIRS);
    expect(edits).toEqual([{ range: { start: pos(0, 0), end: pos(0, 0) }, newText: '""' }]);
    expect(selections).toEqual([cursorAt(0, 1)]);
  });
});

describe("buildBracketEditBatch — selection-wrap (Req 11.1)", () => {
  test("an open bracket over a non-empty selection wraps it, keeping it selected", () => {
    const reader = readerOf(["abc"]);
    const selection = range(0, 0, 0, 3);
    const { edits, selections } = buildBracketEditBatch(reader, [selection], "(", PAIRS);
    expect(edits).toEqual([
      { range: { start: pos(0, 0), end: pos(0, 0) }, newText: "(" },
      { range: { start: pos(0, 3), end: pos(0, 3) }, newText: ")" },
    ]);
    expect(selections).toEqual([range(0, 1, 0, 4)]);
  });

  test("a non-open character over a selection replaces it, collapsing to the end", () => {
    const reader = readerOf(["abc"]);
    const selection = range(0, 0, 0, 3);
    const { edits, selections } = buildBracketEditBatch(reader, [selection], ")", PAIRS);
    expect(edits).toEqual([{ range: { start: pos(0, 0), end: pos(0, 3) }, newText: ")" }]);
    expect(selections).toEqual([cursorAt(0, 1)]);
  });
});

describe("buildBracketEditBatch — multi-cursor (Req 6.6, 11.1)", () => {
  test("two cursors on distinct lines both get their own pair", () => {
    const reader = readerOf(["", ""]);
    const { edits, selections } = buildBracketEditBatch(reader, [cursorAt(0, 0), cursorAt(1, 0)], "[", PAIRS);
    expect(edits).toHaveLength(2);
    expect(selections).toEqual([cursorAt(0, 1), cursorAt(1, 1)]);
  });

  // "abcd", cursors at characters 1 and 3, typing "(". Hand-computed
  // expectation: applying both pair-inserts to "abcd" yields "a()bc()d"
  // (inserting at character 1 first: "a()bcd", then inserting at the
  // SECOND cursor's ORIGINAL character 3, i.e. two characters further
  // right than in the freshly-shifted buffer, landing right before the
  // trailing "d": "a()bc()d"). The first cursor's own pair is untouched by
  // the second cursor's insert (which lands entirely to its right), so it
  // still lands at character 2, between its own parens. The second
  // cursor's own insertion point shifts right by the first cursor's
  // 2-character insertion (from 3 to 5), and its own pair then places its
  // caret one further character in, between ITS OWN parens, at 6.
  test("two same-line cursors each land inside their OWN pair, not shifted into the other's", () => {
    const reader = readerOf(["abcd"]);
    const { edits, selections } = buildBracketEditBatch(
      reader,
      [cursorAt(0, 1), cursorAt(0, 3)],
      "(",
      PAIRS,
    );
    expect(edits).toEqual([
      { range: { start: pos(0, 1), end: pos(0, 1) }, newText: "()" },
      { range: { start: pos(0, 3), end: pos(0, 3) }, newText: "()" },
    ]);
    expect(selections).toEqual([cursorAt(0, 2), cursorAt(0, 6)]);
  });

  // Same idea, but with the cursors in the opposite array order (second
  // cursor to the LEFT of the first) — the fix must not depend on
  // `selections` already being sorted by position.
  test("two same-line cursors out of position order each still land inside their own pair", () => {
    const reader = readerOf(["abcd"]);
    const { edits, selections } = buildBracketEditBatch(
      reader,
      [cursorAt(0, 3), cursorAt(0, 1)],
      "(",
      PAIRS,
    );
    expect(edits).toEqual([
      { range: { start: pos(0, 1), end: pos(0, 1) }, newText: "()" },
      { range: { start: pos(0, 3), end: pos(0, 3) }, newText: "()" },
    ]);
    expect(selections).toEqual([cursorAt(0, 6), cursorAt(0, 2)]);
  });

  // Two same-line selection-wraps: "abcd" with "b" (chars 1-2) and "d"
  // (chars 3-4) both selected, typing "(". Hand-computed: applying both
  // wraps to "abcd" yields "a(b)c(d)" (open+close around "b" at 1/2, then
  // open+close around "d" at 3/4, each shifted by however much text landed
  // to its left). The first wrap is untouched by the second (which is
  // entirely to its right): its selection lands at characters 2-3 (between
  // its own parens). The second wrap shifts right by the first wrap's two
  // inserted characters, landing at characters 6-7.
  test("two same-line selection-wraps each keep their OWN wrapped text selected", () => {
    const reader = readerOf(["abcd"]);
    const { edits, selections } = buildBracketEditBatch(
      reader,
      [range(0, 1, 0, 2), range(0, 3, 0, 4)],
      "(",
      PAIRS,
    );
    expect(edits).toEqual([
      { range: { start: pos(0, 1), end: pos(0, 1) }, newText: "(" },
      { range: { start: pos(0, 2), end: pos(0, 2) }, newText: ")" },
      { range: { start: pos(0, 3), end: pos(0, 3) }, newText: "(" },
      { range: { start: pos(0, 4), end: pos(0, 4) }, newText: ")" },
    ]);
    expect(selections).toEqual([range(0, 2, 0, 3), range(0, 6, 0, 7)]);
  });
});
