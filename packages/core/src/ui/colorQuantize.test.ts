/**
 * Tests for {@link buildXterm256Palette}/{@link quantizeToXterm256}/
 * {@link quantizeTheme} (Req 7.4, design.md §9).
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedTheme } from "@tecode/api";
import { buildXterm256Palette, quantizeTheme, quantizeToXterm256 } from "./colorQuantize";

describe("buildXterm256Palette (Req 7.4)", () => {
  test("has exactly 240 entries: the 6x6x6 cube (216) plus the 24-step gray ramp", () => {
    expect(buildXterm256Palette()).toHaveLength(216 + 24);
  });

  test("cube corners match known xterm-256 indices 16 (black) and 231 (white)", () => {
    const palette = buildXterm256Palette();
    // Index 16 = cube (0,0,0) -> level[0] = 0 on every channel.
    expect(palette[0]).toEqual({ r: 0, g: 0, b: 0 });
    // Index 231 = cube (5,5,5) -> level[5] = 255 on every channel; the cube
    // occupies palette positions 0-215 (offset from xterm index 16).
    expect(palette[215]).toEqual({ r: 255, g: 255, b: 255 });
  });

  test("pure primaries land at their known xterm-256 cube indices", () => {
    const palette = buildXterm256Palette();
    // xterm index 196 = 16 + 36*5 + 6*0 + 0 -> cube (5,0,0) -> pure red.
    expect(palette[196 - 16]).toEqual({ r: 255, g: 0, b: 0 });
    // xterm index 46 = 16 + 36*0 + 6*5 + 0 -> cube (0,5,0) -> pure green.
    expect(palette[46 - 16]).toEqual({ r: 0, g: 255, b: 0 });
    // xterm index 21 = 16 + 36*0 + 6*0 + 5 -> cube (0,0,5) -> pure blue.
    expect(palette[21 - 16]).toEqual({ r: 0, g: 0, b: 255 });
  });

  test("gray ramp starts at gray 8 (index 232) and ends at gray 238 (index 255)", () => {
    const palette = buildXterm256Palette();
    expect(palette[216]).toEqual({ r: 8, g: 8, b: 8 }); // xterm index 232
    expect(palette[239]).toEqual({ r: 238, g: 238, b: 238 }); // xterm index 255
  });
});

describe("quantizeToXterm256 (Req 7.4)", () => {
  test("an exact cube-corner color maps to itself", () => {
    expect(quantizeToXterm256({ r: 0, g: 0, b: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(quantizeToXterm256({ r: 255, g: 255, b: 255 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(quantizeToXterm256({ r: 255, g: 0, b: 0 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  test("an exact gray-ramp value maps to itself (gray 128 = 8 + 10*12)", () => {
    expect(quantizeToXterm256({ r: 128, g: 128, b: 128 })).toEqual({ r: 128, g: 128, b: 128 });
  });

  test("a near-black off-cube color snaps to the black cube corner, not the nearest gray-ramp entry", () => {
    // (1,1,1) is distance 3 from cube (0,0,0) but distance 3*49=147 from
    // gray-ramp (8,8,8) — the cube corner must win.
    expect(quantizeToXterm256({ r: 1, g: 1, b: 1 })).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("does not mutate its input", () => {
    const input = { r: 10, g: 20, b: 30 };
    const copy = { ...input };
    quantizeToXterm256(input);
    expect(input).toEqual(copy);
  });
});

describe("quantizeTheme (Req 7.4)", () => {
  function makeTheme(): ResolvedTheme {
    return {
      colors: {
        "editor.background": { r: 1, g: 1, b: 1 },
        "editor.foreground": { r: 254, g: 254, b: 254 },
      } as ResolvedTheme["colors"],
      tokens: {
        keyword: { foreground: { r: 1, g: 1, b: 1 }, bold: true },
        string: { background: { r: 254, g: 254, b: 254 } },
        comment: {},
      },
    };
  }

  test("quantizes every colors entry", () => {
    const result = quantizeTheme(makeTheme());
    expect(result.colors["editor.background"]).toEqual({ r: 0, g: 0, b: 0 });
    expect(result.colors["editor.foreground"]).toEqual({ r: 255, g: 255, b: 255 });
  });

  test("quantizes token foreground/background, preserving other style fields", () => {
    const result = quantizeTheme(makeTheme());
    expect(result.tokens["keyword"]).toEqual({ foreground: { r: 0, g: 0, b: 0 }, bold: true });
    expect(result.tokens["string"]).toEqual({ background: { r: 255, g: 255, b: 255 } });
    expect(result.tokens["comment"]).toEqual({});
  });

  test("does not mutate the input theme", () => {
    const theme = makeTheme();
    const before = JSON.parse(JSON.stringify(theme));
    quantizeTheme(theme);
    expect(theme).toEqual(before);
  });
});
