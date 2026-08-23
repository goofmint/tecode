/**
 * xterm-256 color quantization (Req 7.4, design.md §9): "on 256-color
 * terminals every resolved RGB is quantized once at theme build time
 * (nearest xterm-256 cube/gray entry), so render paths never branch."
 *
 * This module builds the fixed, well-known xterm-256 palette entries 16
 * through 255 (the 6×6×6 color cube plus the 24-step gray ramp — indices
 * 0-15, the terminal's own configurable ANSI colors, are deliberately
 * excluded: their actual RGB values vary per terminal theme, so there is no
 * fixed color to quantize *toward*) and finds, for any truecolor RGB, the
 * nearest of those 240 fixed entries by squared Euclidean distance.
 *
 * **"Quantize once, render paths never branch"**: {@link quantizeTheme}
 * walks a whole {@link ResolvedTheme} (every `colors` entry, every
 * `tokens` style's `foreground`/`background`) and replaces each RGB with
 * its nearest xterm-256 equivalent — called once, at theme *build* time
 * (`themeRegistry.ts`), for a terminal detected at less than truecolor
 * depth (Req 7.4). Every renderer downstream (`ui/theme.tsx`'s
 * `toColorInput`, `EditorView`'s syntax spans, ...) then just reads
 * `theme.colors[key]`/`style.foreground` and hands it to OpenTUI — there is
 * no `if (colorDepth === "256")` anywhere in a render path.
 */

import type { CaptureName, ResolvedTheme, RGB, Style, UiColorKey } from "@tecode/api";

/** The six evenly-spaced channel levels the xterm-256 cube (indices 16-231)
 * uses for each of its R/G/B axes — the same fixed values every terminal
 * emulator's 256-color palette agrees on. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/**
 * Build the fixed 240-entry xterm-256 palette this module quantizes
 * against: the 6×6×6 color cube (216 entries, xterm indices 16-231, in
 * standard `16 + 36r + 6g + b` order) followed by the 24-step gray ramp
 * (xterm indices 232-255, `gray = 8 + 10*(i-232)`). Indices 0-15 (the
 * terminal's own configurable ANSI colors) are intentionally excluded —
 * see this module's TSDoc. Pure and side-effect free; safe to call
 * repeatedly (`quantizeToXterm256` calls it once per invocation rather than
 * caching a module-level array, keeping this module free of mutable
 * shared state — the array is cheap to rebuild and never large enough for
 * that to matter at theme-build-time call frequency).
 */
export function buildXterm256Palette(): RGB[] {
  const palette: RGB[] = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        palette.push({ r: CUBE_LEVELS[r]!, g: CUBE_LEVELS[g]!, b: CUBE_LEVELS[b]! });
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const gray = 8 + 10 * i;
    palette.push({ r: gray, g: gray, b: gray });
  }
  return palette;
}

/** Squared Euclidean distance between two RGB colors — squared (not the
 * true Euclidean distance) because only relative ordering matters for
 * nearest-neighbor search, and skipping the `Math.sqrt` call keeps this on
 * the hot path of quantizing every color in a theme without any loss of
 * correctness. */
function squaredDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Quantize one truecolor RGB to its nearest xterm-256 palette entry (Req
 * 7.4): a linear nearest-neighbor search over the full 240-entry palette
 * (this module's TSDoc) by squared Euclidean distance. Returns a *new* RGB
 * object (the matched palette entry's own values) — never mutates `rgb`.
 */
export function quantizeToXterm256(rgb: RGB): RGB {
  const palette = buildXterm256Palette();
  let best = palette[0]!;
  let bestDistance = squaredDistance(rgb, best);
  for (let i = 1; i < palette.length; i++) {
    const candidate = palette[i]!;
    const distance = squaredDistance(rgb, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Copy out: `best` is a reference into `palette`, which is rebuilt fresh
  // on every call and thus not shared — but returning it directly would
  // still let a caller's mutation corrupt this function's own local array
  // for the remainder of this call (harmless today, but copying is the
  // same "never hand out a mutable shared reference" discipline
  // `api/stubs.ts`'s `createBaseTheme` documents for its own RGB constants).
  return { r: best.r, g: best.g, b: best.b };
}

/** Quantize one {@link Style}'s `foreground`/`background`, leaving every
 * other field (`bold`/`italic`/`underline`) untouched. */
function quantizeStyle(style: Style): Style {
  return {
    ...style,
    foreground: style.foreground ? quantizeToXterm256(style.foreground) : undefined,
    background: style.background ? quantizeToXterm256(style.background) : undefined,
  };
}

/**
 * Quantize an entire {@link ResolvedTheme} to xterm-256 (Req 7.4): every
 * {@link UiColorKey}'s RGB in `colors`, and every {@link CaptureName}
 * style's `foreground`/`background` in `tokens`. Returns a new theme object
 * (deep enough to never share a color reference with `theme`) — the input
 * is never mutated, matching `createBaseTheme`'s "freeze, never hand out a
 * shared mutable reference" discipline.
 */
export function quantizeTheme(theme: ResolvedTheme): ResolvedTheme {
  const colors = Object.fromEntries(
    (Object.entries(theme.colors) as [UiColorKey, RGB][]).map(([key, rgb]) => [
      key,
      quantizeToXterm256(rgb),
    ]),
  ) as Record<UiColorKey, RGB>;

  const tokens = Object.fromEntries(
    (Object.entries(theme.tokens) as [CaptureName, Style][]).map(([capture, style]) => [
      capture,
      quantizeStyle(style),
    ]),
  ) as Partial<Record<CaptureName, Style>>;

  return { colors, tokens };
}
