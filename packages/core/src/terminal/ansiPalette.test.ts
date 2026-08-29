import { expect, test } from "bun:test";
import { ANSI_16_PALETTE, resolveAnsi16 } from "./ansiPalette";

test("has exactly 16 entries", () => {
  expect(ANSI_16_PALETTE).toHaveLength(16);
});

test("resolveAnsi16 returns the matching table entry for every valid index", () => {
  for (let i = 0; i < 16; i++) {
    expect(resolveAnsi16(i)).toEqual(ANSI_16_PALETTE[i]!);
  }
});

test("index 1 is red, index 9 is bright red — standard/bright pairing", () => {
  expect(resolveAnsi16(1)).toEqual({ r: 0xcd, g: 0x00, b: 0x00 });
  expect(resolveAnsi16(9)).toEqual({ r: 0xff, g: 0x00, b: 0x00 });
});

test("out-of-range indices fall back to black rather than throwing", () => {
  expect(resolveAnsi16(-1)).toEqual({ r: 0, g: 0, b: 0 });
  expect(resolveAnsi16(16)).toEqual({ r: 0, g: 0, b: 0 });
  expect(resolveAnsi16(999)).toEqual({ r: 0, g: 0, b: 0 });
});
