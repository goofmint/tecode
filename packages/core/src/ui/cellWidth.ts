/**
 * Terminal cell-width measurement (Req 6.6, 13.1; design.md §8.3: "wide
 * characters (CJK, emoji) are measured with ... cell-width utilities so
 * cursor columns map to terminal cells correctly").
 *
 * Delegates to `string-width` (grapheme-aware — it walks `text` with
 * `Intl.Segmenter`, one Unicode grapheme cluster at a time, and sizes each
 * cluster via `get-east-asian-width`), so:
 * - CJK/fullwidth characters count as 2 cells, not 1 code unit;
 * - a multi-code-point emoji (including ZWJ-joined sequences like
 *   `"👨‍👩‍👧"`, which is several UTF-16 code units but one grapheme
 *   cluster/one glyph) counts as a single 2-cell glyph, not one 2-cell hit
 *   per constituent code point;
 * - combining marks and zero-width joiners contribute 0 cells of their own,
 *   already folded into the base character's grapheme cluster.
 *
 * `string-width@7.2.0` was previously only a transitive dependency (pulled
 * in via `@opentui/core`) — it is now declared directly in
 * `packages/core/package.json` since this module imports it by name.
 */

import stringWidth from "string-width";

/**
 * The display width, in terminal cells, of `text` (Req 6.6). Ambiguous-width
 * Unicode characters count as narrow (this package's default) — the
 * common case outside CJK-locale terminals; there is no per-terminal
 * detection for this in the MVP (design.md doesn't call for one).
 */
export function cellWidth(text: string): number {
  return stringWidth(text);
}

/**
 * The display width, in terminal cells, of `text` up to (but not including)
 * the UTF-16 code-unit offset `charIndex` — the prefix-sum {@link
 * cellWidth} needs to map a `Position.character` (Req 5.1's LSP-compatible
 * UTF-16 offsets) to the terminal column its cursor/selection edge renders
 * at (design.md §8.3's cursor-column mapping, `viewport.ts`'s gutter/column
 * math).
 *
 * `charIndex` is clamped to `[0, text.length]` rather than throwing on an
 * out-of-range value — matches `LineBuffer`'s `offsetAt`/`positionAt`
 * clamping policy (`buffer/lineBuffer.ts`), since a stale cursor position
 * racing a concurrent edit is a display-layer concern, not a programmer
 * error worth crashing a render over.
 */
export function cellWidthUpTo(text: string, charIndex: number): number {
  const clampedIndex = Math.max(0, Math.min(Math.trunc(charIndex) || 0, text.length));
  return stringWidth(text.slice(0, clampedIndex));
}
