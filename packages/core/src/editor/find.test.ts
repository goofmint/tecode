/**
 * `computeMatches`/`buildReplaceEdit`/`buildReplaceAllEdits` tests (Req
 * 11.1, `find.ts`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import type { Range } from "@tecode/api";
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

  describe("case-insensitive matching preserves UTF-16 offsets (CodeRabbit PR #59 Finding 2)", () => {
    // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE ("İ") lowercases to a
    // TWO-UTF-16-unit string ("i" + a combining dot above,
    // `"İ".toLowerCase() === "i̇"`) — a naive `lineText.toLowerCase()`
    // shifts every index after it by one, corrupting the `Range`s this
    // module reports. `computeMatches` must find "x" at its ORIGINAL index
    // 1, not the shifted index 2 a whole-string `toLowerCase()` would
    // produce.
    test("finds \"x\" at its original position 1 in \"İx\", not the toLowerCase()-shifted position 2", () => {
      expect("İx".toLowerCase()).toBe("i̇x"); // Sanity-check the premise.
      const matches = computeMatches(readerOf(["İx"]), "x", false);
      expect(matches).toEqual([{ start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }]);
    });

    test("a query longer than one character around the offset-shifting character still lands correctly", () => {
      const matches = computeMatches(readerOf(["aİxyz"]), "xyz", false);
      expect(matches).toEqual([{ start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }]);
    });

    test("non-BMP letters case-fold: \"\\u{10428}\" (Deseret small) matches \"\\u{10400}\" (Deseret capital) over its full 0..2 surrogate-pair range", () => {
      // Both forms are one code point / TWO UTF-16 units, so their fold is
      // same-length and DOES apply (this fold iterates code points, not
      // units — per-unit iteration would split the surrogate pair and
      // never match; CodeRabbit finding on PR #59 round 2).
      expect("\u{10400}".toLowerCase()).toBe("\u{10428}"); // Sanity-check the premise.
      const matches = computeMatches(readerOf(["\u{10400}"]), "\u{10428}", false);
      expect(matches).toEqual([{ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }]);
      // And the reported range replaces exactly the matched pair.
      const [match] = matches;
      const edit = buildReplaceEdit(match!, "X");
      expect(edit).toEqual({ range: match!, newText: "X" });
    });

    test("replaceCurrent-style usage: the reported range replaces exactly the matched text, not a shifted span", () => {
      const lineText = "İx";
      const matches = computeMatches(readerOf([lineText]), "x", false);
      const edit = buildReplaceEdit(matches[0] as Range, "Y");
      // Applying the edit at the reported range must land on "x", not "İ" or
      // a boundary between the two.
      const before = lineText.slice(0, edit.range.start.character);
      const replaced = lineText.slice(edit.range.start.character, edit.range.end.character);
      const after = lineText.slice(edit.range.end.character);
      expect(replaced).toBe("x");
      expect(before + edit.newText + after).toBe("İY");
    });

    test("the query itself folds through the same length-preserving rule (a literal İ still matches a literal İ)", () => {
      const matches = computeMatches(readerOf(["prefix İ suffix"]), "İ", false);
      expect(matches).toEqual([{ start: { line: 0, character: 7 }, end: { line: 0, character: 8 } }]);
    });

    test("ordinary ASCII case-insensitivity is unaffected by the length-preserving fold", () => {
      const matches = computeMatches(readerOf(["Foo FOO foo"]), "foo", false);
      expect(matches).toEqual([
        { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
        { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
      ]);
    });
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
