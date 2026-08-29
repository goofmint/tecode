/**
 * The standard xterm(1) default 16-color ANSI palette (Issue #98,
 * `vtEmulator.ts`'s TSDoc): resolves a `@xterm/headless` cell's palette
 * index 0-15 to an RGB triple for the panel to draw.
 *
 * **Why a standalone table, not `ui/colorQuantize.ts`'s palette**: that
 * module's `buildXterm256Palette()` deliberately excludes indices 0-15
 * (its own TSDoc: "the terminal's own configurable ANSI colors ... vary
 * per terminal theme, so there is no fixed color to quantize toward") —
 * the emulator has the exact same problem in reverse (it needs SOME RGB to
 * render those 16 indices with, even though no fixed value is truly
 * correct for every terminal theme) and picks the same well-known
 * approximation `xterm(1)` itself ships as its own built-in default
 * theme, rather than inventing a third set of values.
 */

import type { RGB } from "@tecode/api";

/**
 * Indices 0-7 (the "standard" set, `CSI 3(0-7) m`/`CSI 4(0-7) m`) followed
 * by 8-15 (the "bright" set, `CSI 9(0-7) m`/`CSI 10(0-7) m`) — xterm's own
 * documented default values for both, in order: black, red, green,
 * yellow, blue, magenta, cyan, white, then the same eight again brightened.
 */
export const ANSI_16_PALETTE: readonly RGB[] = [
  { r: 0x00, g: 0x00, b: 0x00 }, // 0 black
  { r: 0xcd, g: 0x00, b: 0x00 }, // 1 red
  { r: 0x00, g: 0xcd, b: 0x00 }, // 2 green
  { r: 0xcd, g: 0xcd, b: 0x00 }, // 3 yellow
  { r: 0x00, g: 0x00, b: 0xee }, // 4 blue
  { r: 0xcd, g: 0x00, b: 0xcd }, // 5 magenta
  { r: 0x00, g: 0xcd, b: 0xcd }, // 6 cyan
  { r: 0xe5, g: 0xe5, b: 0xe5 }, // 7 white
  { r: 0x7f, g: 0x7f, b: 0x7f }, // 8 bright black
  { r: 0xff, g: 0x00, b: 0x00 }, // 9 bright red
  { r: 0x00, g: 0xff, b: 0x00 }, // 10 bright green
  { r: 0xff, g: 0xff, b: 0x00 }, // 11 bright yellow
  { r: 0x5c, g: 0x5c, b: 0xff }, // 12 bright blue
  { r: 0xff, g: 0x00, b: 0xff }, // 13 bright magenta
  { r: 0x00, g: 0xff, b: 0xff }, // 14 bright cyan
  { r: 0xff, g: 0xff, b: 0xff }, // 15 bright white
];

/** Fallback color for a palette index this module cannot resolve (out of
 * range) — pure black, the same "never crash, degrade to something
 * harmless" choice `colorQuantize.ts`'s callers make elsewhere. */
const FALLBACK: RGB = { r: 0, g: 0, b: 0 };

/**
 * Resolve ANSI palette index 0-15 to its {@link ANSI_16_PALETTE} RGB.
 * Indices 16-255 are the xterm-256 cube/gray ramp, NOT this table's
 * concern — a caller resolving a full 0-255 palette index dispatches to
 * `ui/colorQuantize.ts`'s `buildXterm256Palette()` for those instead
 * (`vtEmulator.ts`'s own resolver does exactly this). Out-of-range input
 * (defensive only — a real cell never reports one) returns
 * {@link FALLBACK} rather than throwing.
 */
export function resolveAnsi16(index: number): RGB {
  return ANSI_16_PALETTE[index] ?? FALLBACK;
}
