/**
 * `viewport.ts` unit tests (Req 6.5, 6.6, 13.1; design.md §8.3): visible
 * line window math (including the partial-last-line case), `revealLine`'s
 * top/bottom-edge scroll adjustment, and gutter digit-count boundaries.
 */

import { describe, expect, test } from "bun:test";
import {
  computeEditorViewportHeight,
  computeVisibleLineRange,
  gutterDigitWidth,
  revealLine,
  type EditorAreaChrome,
} from "./viewport";

const NO_CHROME: EditorAreaChrome = { tabBar: 0, findWidget: 0, panel: 0, statusBar: 0 };

describe("computeVisibleLineRange (design.md §8.3's virtualized text layer)", () => {
  test("a full window in the middle of a long document", () => {
    expect(computeVisibleLineRange(10, 5, 100)).toEqual({ startLine: 10, endLine: 15 });
  });

  test("scrollTop 0 shows the first viewportHeight lines", () => {
    expect(computeVisibleLineRange(0, 20, 100)).toEqual({ startLine: 0, endLine: 20 });
  });

  test("partial last line: near the document's end, endLine clamps to lineCount", () => {
    expect(computeVisibleLineRange(95, 20, 100)).toEqual({ startLine: 95, endLine: 100 });
  });

  test("a document shorter than the viewport shows every line", () => {
    expect(computeVisibleLineRange(0, 50, 7)).toEqual({ startLine: 0, endLine: 7 });
  });

  test("scrollTop clamps into range rather than overrunning the document", () => {
    expect(computeVisibleLineRange(500, 10, 20)).toEqual({ startLine: 19, endLine: 20 });
  });

  test("negative scrollTop clamps to 0", () => {
    expect(computeVisibleLineRange(-5, 10, 20)).toEqual({ startLine: 0, endLine: 10 });
  });

  test("non-positive lineCount or viewportHeight yields an empty range", () => {
    expect(computeVisibleLineRange(0, 10, 0)).toEqual({ startLine: 0, endLine: 0 });
    expect(computeVisibleLineRange(0, 0, 10)).toEqual({ startLine: 0, endLine: 0 });
  });
});

describe("revealLine (design.md §8.3's primary-cursor-drives-scroll)", () => {
  test("target line already visible: scrollTop is unchanged", () => {
    expect(revealLine(12, 10, 10, 100)).toBe(10);
  });

  test("target line above the window: scrolls up so the line becomes the top row", () => {
    expect(revealLine(3, 10, 10, 100)).toBe(3);
  });

  test("target line below the window: scrolls down so the line becomes the bottom row", () => {
    // window is [10, 20); revealing line 25 in a 10-row viewport puts it on
    // the last row: scrollTop 16 -> window [16, 26).
    expect(revealLine(25, 10, 10, 100)).toBe(16);
  });

  test("target line exactly at the bottom edge (scrollTop + viewportHeight) scrolls by one", () => {
    // window [10, 20) — line 20 is just past the last visible row (19).
    expect(revealLine(20, 10, 10, 100)).toBe(11);
  });

  test("target line exactly at the top edge (scrollTop) is already visible", () => {
    expect(revealLine(10, 10, 10, 100)).toBe(10);
  });

  test("revealing line 0 always scrolls to the very top", () => {
    expect(revealLine(0, 50, 10, 100)).toBe(0);
  });

  test("revealing the last line in a document shorter than the viewport stays at 0", () => {
    expect(revealLine(6, 0, 20, 7)).toBe(0);
  });

  test("out-of-range target line clamps to the nearest valid line", () => {
    expect(revealLine(9999, 0, 10, 20)).toBe(10); // last line (19) becomes bottom row
    expect(revealLine(-9999, 5, 10, 20)).toBe(0);
  });

  test("non-positive lineCount reveals scrollTop 0", () => {
    expect(revealLine(5, 3, 10, 0)).toBe(0);
  });
});

describe("gutterDigitWidth (design.md §8.3's gutter width, 9/10/100 boundaries)", () => {
  const cases: Array<[lineCount: number, expectedDigits: number]> = [
    [1, 1],
    [9, 1],
    [10, 2],
    [99, 2],
    [100, 3],
    [999, 3],
    [1000, 4],
  ];

  for (const [lineCount, expectedDigits] of cases) {
    test(`${lineCount} lines -> ${expectedDigits} digit(s)`, () => {
      expect(gutterDigitWidth(lineCount)).toBe(expectedDigits);
    });
  }

  test("a non-positive lineCount still reports at least 1 digit", () => {
    expect(gutterDigitWidth(0)).toBe(1);
    expect(gutterDigitWidth(-5)).toBe(1);
  });
});

describe("computeEditorViewportHeight (Issue #92; design.md §8.1-§8.3)", () => {
  test("no chrome at all: every terminal row goes to the text plane", () => {
    expect(computeEditorViewportHeight(24, NO_CHROME)).toBe(24);
  });

  test("a tall terminal with typical chrome (tab bar + status bar) leaves well over 20 rows", () => {
    // The exact scenario Issue #92 reports: a terminal much taller than the
    // old hardcoded 20-row default, with just a tab bar (3) and status bar
    // (1) drawn — the fix's whole point is that this stops being clamped
    // to 20.
    const chrome: EditorAreaChrome = { tabBar: 3, findWidget: 0, panel: 0, statusBar: 1 };
    expect(computeEditorViewportHeight(50, chrome)).toBe(46);
    expect(computeEditorViewportHeight(50, chrome)).toBeGreaterThan(20);
  });

  test("every chrome region present at once subtracts all four", () => {
    const chrome: EditorAreaChrome = { tabBar: 3, findWidget: 1, panel: 10, statusBar: 1 };
    expect(computeEditorViewportHeight(40, chrome)).toBe(25);
  });

  test("no tabs, no find, no panel: only the always-on status bar is reserved", () => {
    const chrome: EditorAreaChrome = { ...NO_CHROME, statusBar: 1 };
    expect(computeEditorViewportHeight(30, chrome)).toBe(29);
  });

  test("clamp: chrome consuming the entire terminal still yields at least 1 row, never 0 or negative", () => {
    const chrome: EditorAreaChrome = { tabBar: 3, findWidget: 1, panel: 10, statusBar: 1 };
    // Exactly as much chrome as terminal height (15 == 3+1+10+1): a naive
    // `terminalHeight - consumed` would be 0.
    expect(computeEditorViewportHeight(15, chrome)).toBe(1);
    // Chrome taller than the terminal itself: a naive subtraction would go
    // negative, which `computeVisibleLineRange` would treat as "empty
    // range" (this module's own TSDoc) rather than a degenerate-but-usable
    // 1-row viewport.
    expect(computeEditorViewportHeight(5, chrome)).toBe(1);
    expect(computeEditorViewportHeight(0, chrome)).toBe(1);
    expect(computeEditorViewportHeight(-10, chrome)).toBe(1);
  });

  test("clamp at the very short terminals a real user's window could plausibly be", () => {
    const chrome: EditorAreaChrome = { tabBar: 3, findWidget: 0, panel: 0, statusBar: 1 };
    // A 4-row terminal with just tab bar + status bar chrome (4 rows) has
    // nothing left over — still clamps to 1, not 0.
    expect(computeEditorViewportHeight(4, chrome)).toBe(1);
    expect(computeEditorViewportHeight(3, chrome)).toBe(1);
  });

  test("non-integer terminal heights are truncated, not rounded or left fractional", () => {
    expect(computeEditorViewportHeight(24.9, NO_CHROME)).toBe(24);
  });
});
