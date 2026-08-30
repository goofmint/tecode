/**
 * `cellWidth`/`cellWidthUpTo` tests (Req 6.6, 13.1; design.md §8.3): ASCII,
 * CJK (fullwidth, 2 cells), emoji (2 cells for a single-codepoint emoji, and
 * still exactly 2 for a multi-codepoint ZWJ sequence — the whole cluster is
 * one glyph, not one hit per constituent codepoint), and the prefix-sum used
 * to map a cursor's `Position.character` to a terminal column.
 */

import { describe, expect, test } from "bun:test";
import { cellWidth, cellWidthUpTo, truncateToWidth } from "./cellWidth";

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

describe("tabs (Req 6.6: string-width measures \"\\t\" as 0 cells on its own)", () => {
  test("a line starting with a tab advances to the next tab stop, not 0 cells", () => {
    // Default tabSize (4): the tab alone occupies columns 0-3.
    expect(cellWidth("\tx")).toBe(5); // 4 (tab) + 1 ("x")
    expect(cellWidthUpTo("\tx", 1)).toBe(4); // up to (not including) "x"
    expect(cellWidthUpTo("\tx", 2)).toBe(5); // through "x"
  });

  test("a tab embedded mid-text advances from the current column, not from 0", () => {
    // "a" (1 cell) then a tab from column 1 -> next stop at column 4.
    expect(cellWidthUpTo("a\tx", 2)).toBe(4); // up to (not including) "x"
    expect(cellWidth("a\tx")).toBe(5); // 4 + 1 ("x")

    // "abc" (3 cells) then a tab from column 3 -> next stop at column 4
    // (a tab always advances at least one cell, even one column short of a
    // stop already on a boundary).
    expect(cellWidthUpTo("abc\tx", 4)).toBe(4); // up to (not including) "x"
    expect(cellWidth("abc\tx")).toBe(5);
  });

  test("a tab exactly on a stop still advances a full tabSize", () => {
    // "abcd" (4 cells, already at column 4) then a tab -> next stop at 8.
    expect(cellWidthUpTo("abcd\tx", 5)).toBe(8); // up to (not including) "x"
  });

  test("a custom tabSize changes where the tab stop lands", () => {
    expect(cellWidthUpTo("\tx", 1, 2)).toBe(2);
    expect(cellWidthUpTo("a\tx", 2, 8)).toBe(8);
    expect(cellWidth("\tx", 2)).toBe(3); // 2 (tab) + 1 ("x")
  });

  test("multiple tabs each advance to their own next stop", () => {
    // "\t\t" -> columns 0-3 (first tab), 4-7 (second tab): 8 cells total.
    expect(cellWidth("\t\t")).toBe(8);
  });

  test("an invalid tabSize falls back to the default instead of producing NaN columns", () => {
    // 0 would divide by zero in the tab-stop math (0 % 0 -> NaN).
    expect(cellWidth("\t", 0)).toBe(4);
    expect(cellWidth("\tx", -2)).toBe(5);
    expect(cellWidthUpTo("\tx", 1, Number.NaN)).toBe(4);
    expect(cellWidth("\t", Number.POSITIVE_INFINITY)).toBe(4);
  });

  test("a fractional tabSize is truncated to its integer part", () => {
    expect(cellWidth("\t", 2.9)).toBe(2);
    // Truncating below 1 (e.g. 0.5 -> 0) is invalid and falls back to 4.
    expect(cellWidth("\t", 0.5)).toBe(4);
  });
});

describe("truncateToWidth (Issue #104: Tree row wrapping)", () => {
  test("ASCII text that already fits is returned unchanged", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  test("exactly at width: returned unchanged, no ellipsis", () => {
    expect(truncateToWidth("hello", 5)).toBe("hello");
  });

  test("under width (shorter than maxWidth): returned unchanged", () => {
    expect(truncateToWidth("hi", 5)).toBe("hi");
  });

  test("over width: cuts and appends the ellipsis, leaving room for it", () => {
    // budget = 3 - 1 (ellipsis) = 2 content cells kept.
    expect(truncateToWidth("hello", 3)).toBe("he…");
  });

  test("ASCII: one cell short of fitting still truncates (off-by-one)", () => {
    expect(truncateToWidth("hello", 4)).toBe("hel…");
  });

  test("CJK: fullwidth characters are cut on a character boundary, never split", () => {
    // "日本語" is 6 cells (2 each). maxWidth 5 -> budget 4 -> keeps "日本" (4).
    expect(truncateToWidth("日本語", 5)).toBe("日本…");
  });

  test("a single CJK character (2 cells) against maxWidth 1: only the ellipsis fits", () => {
    // budget = 1 - 1 = 0 -> zero content cells kept, bare ellipsis returned.
    expect(truncateToWidth("古", 1)).toBe("…");
  });

  test("a ZWJ emoji sequence is kept or dropped whole, never split mid-cluster", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one grapheme cluster, 2 cells.
    // "x" + family + "y" is 1 + 2 + 1 = 4 cells.
    const text = `x${family}y`;
    // budget 2 (maxWidth 3, ellipsis 1) fits "x" (1) but not the 2-cell
    // family cluster (1 + 2 = 3 > 2) -> stops after "x", never emits half
    // of the ZWJ sequence.
    const result = truncateToWidth(text, 3);
    expect(result).toBe("x…");
    expect(result).not.toContain("\u{1F468}");
  });

  test("a ZWJ emoji sequence that DOES fit is kept whole", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const text = `${family}yy`; // 2 + 1 + 1 = 4 cells.
    // budget 2 (maxWidth 3, ellipsis 1) fits the whole 2-cell family
    // cluster exactly, but not the "y" after it (2 + 1 = 3 > 2).
    expect(truncateToWidth(text, 3)).toBe(`${family}…`);
  });

  test("degenerate: maxWidth 0 returns an empty string", () => {
    expect(truncateToWidth("hello", 0)).toBe("");
    expect(truncateToWidth("", 0)).toBe("");
  });

  test("degenerate: negative maxWidth returns an empty string", () => {
    expect(truncateToWidth("hello", -1)).toBe("");
    expect(truncateToWidth("hello", -100)).toBe("");
  });

  test("degenerate: NaN maxWidth returns an empty string rather than crashing", () => {
    expect(truncateToWidth("hello", Number.NaN)).toBe("");
  });

  test("degenerate: maxWidth exactly the ellipsis's own width returns just the ellipsis", () => {
    expect(truncateToWidth("hello", 1)).toBe("…");
    expect(truncateToWidth("hello", 1, "...")).toBe(""); // "..." is 3 cells > maxWidth 1.
  });

  test("a caller-supplied multi-cell ellipsis that doesn't fit at all yields no partial ellipsis", () => {
    expect(truncateToWidth("hello world", 2, "...")).toBe("");
  });

  test("empty text at any positive width returns empty text unchanged", () => {
    expect(truncateToWidth("", 5)).toBe("");
  });

  test("postcondition: the result's display width never exceeds max(0, maxWidth), for every input", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const samples = ["", "a", "hello", "日本語テキスト", `x${family}y${family}z`, "\tindented\tlabel"];
    for (const text of samples) {
      const upperBound = cellWidth(text) + 3;
      for (let maxWidth = -2; maxWidth <= upperBound; maxWidth++) {
        const result = truncateToWidth(text, maxWidth);
        expect(cellWidth(result)).toBeLessThanOrEqual(Math.max(0, maxWidth));
      }
    }
  });
});
