/**
 * `computeMatches`/`buildReplaceEdit`/`buildReplaceAllEdits` tests (Req
 * 11.1, `find.ts`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import { buildReplaceAllEdits, buildReplaceEdit, computeMatches, type LineReader } from "./find";

function readerOf(lines: string[]): LineReader {
  return { getLine: (n) => lines[n] ?? "", lineCount: lines.length };
}

describe("computeMatches (Req 11.1)", () => {
  test("an empty query yields no matches", () => {
    expect(computeMatches(readerOf(["foo foo foo"]), "", false)).toEqual([]);
  });

  test("finds every occurrence on one line", () => {
    const matches = computeMatches(readerOf(["foo bar foo baz foo"]), "foo", false);
    expect(matches).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
      { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
    ]);
  });

  test("finds occurrences across multiple lines, in document order", () => {
    const matches = computeMatches(readerOf(["foo", "bar", "foo foo"]), "foo", false);
    expect(matches).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
      { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    ]);
  });

  test("case-insensitive by default", () => {
    const matches = computeMatches(readerOf(["Foo FOO foo"]), "foo", false);
    expect(matches.length).toBe(3);
  });

  test("case-sensitive skips differently-cased occurrences", () => {
    const matches = computeMatches(readerOf(["Foo FOO foo"]), "foo", true);
    expect(matches).toEqual([{ start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }]);
  });

  test("non-overlapping: a self-overlapping needle only matches end-to-end", () => {
    // "aa" against "aaaa" -> [0,2) and [2,4), never the overlapping [1,3).
    const matches = computeMatches(readerOf(["aaaa"]), "aa", false);
    expect(matches).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
      { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
    ]);
  });

  test("a query containing a line break never matches anything (line-by-line scope)", () => {
    const matches = computeMatches(readerOf(["foo", "bar"]), "foo\nbar", false);
    expect(matches).toEqual([]);
  });

  test("no matches on an empty document", () => {
    expect(computeMatches(readerOf([""]), "foo", false)).toEqual([]);
  });
});

describe("buildReplaceEdit / buildReplaceAllEdits (Req 11.1)", () => {
  test("buildReplaceEdit produces a TextEdit over exactly the match's range", () => {
    const match = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    expect(buildReplaceEdit(match, "xyz")).toEqual({ range: match, newText: "xyz" });
  });

  test("buildReplaceAllEdits maps every match to its own edit, same order", () => {
    const matches = [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    ];
    expect(buildReplaceAllEdits(matches, "X")).toEqual([
      { range: matches[0], newText: "X" },
      { range: matches[1], newText: "X" },
    ]);
  });

  test("buildReplaceAllEdits on an empty match list is an empty edit batch", () => {
    expect(buildReplaceAllEdits([], "X")).toEqual([]);
  });
});
