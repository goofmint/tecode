/**
 * Tests for `./lineMatch.ts` (Issue #147) — pure functions, no fakes
 * needed at all (mirrors `../shared/fuzzyMatch.test.ts`'s style).
 */

import { describe, expect, test } from "bun:test";
import { findLineMatches, looksBinary } from "./lineMatch";

describe("findLineMatches (Issue #147)", () => {
  test("an empty query matches nothing", () => {
    expect(findLineMatches("hello\nworld", "")).toEqual([]);
  });

  test("reports zero-based line/character positions and the whole matched line", () => {
    expect(findLineMatches("alpha\nbeta gamma\n", "gamma")).toEqual([
      { line: 1, startCharacter: 5, endCharacter: 10, lineText: "beta gamma" },
    ]);
  });

  test("returns every non-overlapping match within one line", () => {
    expect(findLineMatches("aaaa", "aa").map((m) => m.startCharacter)).toEqual([0, 2]);
  });

  test("is case-insensitive by default and case-sensitive on request", () => {
    expect(findLineMatches("Hello", "hello")).toHaveLength(1);
    expect(findLineMatches("Hello", "hello", { caseSensitive: true })).toEqual([]);
    expect(findLineMatches("Hello", "Hello", { caseSensitive: true })).toHaveLength(1);
  });

  test("strips a CRLF's carriage return from the reported line text", () => {
    expect(findLineMatches("a\r\nb\r\n", "a")).toEqual([
      { line: 0, startCharacter: 0, endCharacter: 1, lineText: "a" },
    ]);
  });

  test("maxMatches stops the scan early", () => {
    const matches = findLineMatches("x\nx\nx\nx", "x", { maxMatches: 2 });
    expect(matches.map((m) => m.line)).toEqual([0, 1]);
  });

  test("never throws on odd input", () => {
    expect(() => findLineMatches("", "q")).not.toThrow();
    expect(findLineMatches("", "q")).toEqual([]);
  });
});

describe("looksBinary (Issue #147)", () => {
  test("plain UTF-8 text is not binary", () => {
    expect(looksBinary(new TextEncoder().encode("const a = 1;\n日本語\n"))).toBe(false);
  });

  test("a NUL byte marks the content binary", () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x4e]))).toBe(true);
  });

  test("empty content is not binary", () => {
    expect(looksBinary(new Uint8Array())).toBe(false);
  });
});
