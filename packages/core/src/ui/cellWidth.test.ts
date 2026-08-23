/**
 * `cellWidth`/`cellWidthUpTo` tests (Req 6.6, 13.1; design.md §8.3): ASCII,
 * CJK (fullwidth, 2 cells), emoji (2 cells for a single-codepoint emoji, and
 * still exactly 2 for a multi-codepoint ZWJ sequence — the whole cluster is
 * one glyph, not one hit per constituent codepoint), and the prefix-sum used
 * to map a cursor's `Position.character` to a terminal column.
 */

import { describe, expect, test } from "bun:test";
import { cellWidth, cellWidthUpTo } from "./cellWidth";

describe("cellWidth (Req 6.6)", () => {
  test("ASCII: one cell per character", () => {
    expect(cellWidth("hello")).toBe(5);
    expect(cellWidth("")).toBe(0);
  });

  test("CJK: fullwidth characters count as 2 cells each", () => {
    expect(cellWidth("古")).toBe(2);
    expect(cellWidth("日本語")).toBe(6);
    expect(cellWidth("a日b")).toBe(4); // 1 + 2 + 1
  });

  test("emoji: a single-codepoint emoji counts as 2 cells", () => {
    expect(cellWidth("😀")).toBe(2);
    expect(cellWidth("a😀b")).toBe(4); // 1 + 2 + 1
  });

  test("ZWJ sequence: one grapheme cluster (family emoji) still counts as one 2-cell glyph", () => {
    // "👨‍👩‍👧" = MAN, ZWJ, WOMAN, ZWJ, GIRL — 5 code points / one glyph.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(cellWidth(family)).toBe(2);
    expect(cellWidth(`x${family}y`)).toBe(4); // 1 + 2 + 1
  });

  test("combining marks contribute no width of their own", () => {
    // "e" + COMBINING ACUTE ACCENT — one visual character, one cell.
    const combining = "é";
    expect(cellWidth(combining)).toBe(1);
  });
});

describe("cellWidthUpTo (design.md §8.3's cursor-column mapping)", () => {
  test("ASCII: prefix sum equals the character index", () => {
    expect(cellWidthUpTo("hello", 0)).toBe(0);
    expect(cellWidthUpTo("hello", 3)).toBe(3);
    expect(cellWidthUpTo("hello", 5)).toBe(5);
  });

  test("cursor after a CJK character lands two cells further right", () => {
    const line = "a古b"; // indices: a=0, 古=1, b=2 (one UTF-16 code unit each)
    expect(cellWidthUpTo(line, 0)).toBe(0); // before "a"
    expect(cellWidthUpTo(line, 1)).toBe(1); // after "a", before "古"
    expect(cellWidthUpTo(line, 2)).toBe(3); // after "古" (1 + 2), before "b"
    expect(cellWidthUpTo(line, 3)).toBe(4); // after "b"
  });

  test("cursor after an emoji lands two cells further right", () => {
    const line = "a😀b"; // "😀" is a surrogate pair: 2 UTF-16 code units
    expect(cellWidthUpTo(line, 1)).toBe(1); // after "a"
    expect(cellWidthUpTo(line, 3)).toBe(3); // after the surrogate pair (1 + 2)
    expect(cellWidthUpTo(line, 4)).toBe(4); // after "b"
  });

  test("cursor after a ZWJ family emoji lands two cells further right", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const line = `x${family}y`;
    expect(cellWidthUpTo(line, 1)).toBe(1); // after "x"
    expect(cellWidthUpTo(line, 1 + family.length)).toBe(3); // after the whole cluster (1 + 2)
    expect(cellWidthUpTo(line, line.length)).toBe(4); // after "y"
  });

  test("out-of-range charIndex clamps instead of throwing", () => {
    expect(cellWidthUpTo("abc", -5)).toBe(0);
    expect(cellWidthUpTo("abc", 100)).toBe(3);
    expect(cellWidthUpTo("abc", Number.NaN)).toBe(0);
  });
});
