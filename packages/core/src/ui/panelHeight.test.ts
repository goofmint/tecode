import { describe, expect, test } from "bun:test";
import { clampPanelHeight, MIN_EDITOR_HEIGHT, MIN_PANEL_HEIGHT } from "./panelHeight";
import { STATUS_BAR_HEIGHT, TAB_BAR_HEIGHT } from "./shell";

describe("clampPanelHeight (Issue #118) — floor only", () => {
  test("a value already within range passes through unchanged", () => {
    expect(clampPanelHeight(20)).toBe(20);
  });

  test("a zero/negative height (a hand-edited state.json) floors to MIN_PANEL_HEIGHT", () => {
    expect(clampPanelHeight(0)).toBe(MIN_PANEL_HEIGHT);
    expect(clampPanelHeight(-5)).toBe(MIN_PANEL_HEIGHT);
  });

  test("a non-finite desired height (NaN/Infinity) degrades to MIN_PANEL_HEIGHT rather than propagating", () => {
    expect(clampPanelHeight(Number.NaN)).toBe(MIN_PANEL_HEIGHT);
    // Asserts the EXACT value, not merely `<= 100` — a mutated
    // `clampPanelHeight` that only capped Infinity via the terminal-height
    // ceiling (rather than degrading it to MIN_PANEL_HEIGHT first) would
    // still pass a `toBeLessThanOrEqual(100)` check.
    expect(clampPanelHeight(Number.POSITIVE_INFINITY, 100)).toBe(MIN_PANEL_HEIGHT);
  });

  test("a fractional height is truncated toward zero", () => {
    expect(clampPanelHeight(20.9)).toBe(20);
  });

  test("with no terminalHeight, an absurdly tall value is left uncapped (only the floor applies)", () => {
    expect(clampPanelHeight(500)).toBe(500);
  });
});

describe("clampPanelHeight (Issue #118) — with a terminalHeight ceiling", () => {
  test("a too-tall value is capped so the editor keeps usable room", () => {
    const result = clampPanelHeight(500, 50);
    expect(result).toBeLessThan(50);
    expect(result).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT);
  });

  test("a terminal too short to honor both floors still returns MIN_PANEL_HEIGHT, never less", () => {
    expect(clampPanelHeight(20, 8)).toBe(MIN_PANEL_HEIGHT);
    expect(clampPanelHeight(1, 6)).toBe(MIN_PANEL_HEIGHT);
  });

  test("a value already shorter than the terminal-aware cap is left unchanged", () => {
    expect(clampPanelHeight(10, 100)).toBe(10);
  });

  test("the terminal-aware cap reserves exactly TAB_BAR_HEIGHT + STATUS_BAR_HEIGHT + MIN_EDITOR_HEIGHT rows for chrome/editor", () => {
    // This module cannot import `shell.tsx`'s `TAB_BAR_HEIGHT`/
    // `STATUS_BAR_HEIGHT` directly (this module's own TSDoc: `shell.tsx`
    // already imports `clampPanelHeight` from here, so the reverse edge
    // would be circular) — this is the drift guard that duplication
    // promises, mirroring `sidebarWidth.test.ts`'s identical
    // `ACTIVITY_BAR_WIDTH`/`ACTIVITY_BAR_WIDTH_FOR_CAP` two-literal sync
    // assertion. If the internal, private duplicate ever drifted from the
    // real exports, this computed cap would stop landing exactly on 37.
    const terminalHeight = TAB_BAR_HEIGHT + STATUS_BAR_HEIGHT + MIN_EDITOR_HEIGHT + 37;
    expect(clampPanelHeight(500, terminalHeight)).toBe(37);
  });

  test("exact-cap: the reserved rows arithmetic matches the real shell.tsx constants", () => {
    // A second, independent check on the same reservation this module's
    // TSDoc documents — computed directly from the real `shell.tsx`
    // exports rather than the module's own private duplicates, so a drift
    // in EITHER duplicate (`TAB_BAR_HEIGHT_FOR_CAP` or
    // `STATUS_BAR_HEIGHT_FOR_CAP`) is caught, not just one.
    const terminalHeight = 100;
    const expectedCap = terminalHeight - TAB_BAR_HEIGHT - STATUS_BAR_HEIGHT - MIN_EDITOR_HEIGHT;
    expect(clampPanelHeight(500, terminalHeight)).toBe(expectedCap);
  });
});
