import { describe, expect, test } from "bun:test";
import { clampSidebarWidth, MIN_EDITOR_WIDTH, MIN_SIDEBAR_WIDTH } from "./sidebarWidth";
import { ACTIVITY_BAR_WIDTH } from "./shell";

describe("clampSidebarWidth (Issue #105)", () => {
  test("a value already within range passes through unchanged", () => {
    expect(clampSidebarWidth(30)).toBe(30);
  });

  test("a zero/negative width (a hand-edited state.json) floors to MIN_SIDEBAR_WIDTH", () => {
    expect(clampSidebarWidth(0)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(-5)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("a non-finite desired width (NaN/Infinity) degrades to MIN_SIDEBAR_WIDTH rather than propagating", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(MIN_SIDEBAR_WIDTH);
    // Asserts the EXACT value, not merely `<= 200` — a mutated
    // `clampSidebarWidth` that only capped Infinity via the terminal-width
    // ceiling (rather than degrading it to MIN_SIDEBAR_WIDTH first) would
    // still pass a `toBeLessThanOrEqual(200)` check.
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 200)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("a fractional width is truncated toward zero", () => {
    expect(clampSidebarWidth(30.9)).toBe(30);
  });

  test("with no terminalWidth, an absurdly wide value is left uncapped (only the floor applies)", () => {
    expect(clampSidebarWidth(500)).toBe(500);
  });

  test("with a terminalWidth, a too-wide value is capped so the editor keeps usable room", () => {
    const result = clampSidebarWidth(500, 100);
    expect(result).toBeLessThan(100);
    expect(result).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
  });

  test("a terminal too narrow to honor both floors still returns MIN_SIDEBAR_WIDTH, never less", () => {
    expect(clampSidebarWidth(30, 20)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(1, 10)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("a value already narrower than the terminal-aware cap is left unchanged", () => {
    expect(clampSidebarWidth(20, 200)).toBe(20);
  });

  test("the terminal-aware cap reserves exactly ACTIVITY_BAR_WIDTH + MIN_EDITOR_WIDTH columns for chrome/editor", () => {
    // This module cannot import `shell.tsx`'s `ACTIVITY_BAR_WIDTH` directly
    // (this module's own TSDoc: `shell.tsx` already imports
    // `clampSidebarWidth` from here, so the reverse edge would be
    // circular) — this is the drift guard that duplication promises,
    // mirroring `coreDefaults.test.ts`'s identical
    // `DEFAULT_SIDEBAR_WIDTH`/`DEFAULT_LAYOUT_STATE.sidebarWidth`
    // two-literal sync assertion. If the internal, private duplicate ever
    // drifted from the
    // real export, this computed cap would stop landing exactly on 42.
    const terminalWidth = ACTIVITY_BAR_WIDTH + MIN_EDITOR_WIDTH + 42;
    expect(clampSidebarWidth(500, terminalWidth)).toBe(42);
  });
});
