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
 *
 * **Tabs**: `string-width` has no concept of a tab stop — it measures `"\t"`
 * as 0 cells, which would put a cursor after a tab zero columns further
 * right than it actually renders. Both functions below special-case `"\t"`
 * themselves: a tab run is pulled out of the string being measured and
 * advances the running column to the next multiple of `tabSize` (`column +=
 * tabSize - (column % tabSize)`, so a tab always advances at least one
 * cell); every other character keeps going through `string-width` exactly
 * as before, unaffected by the presence of tabs elsewhere in the string.
 */

import stringWidth from "string-width";

/** `editor.tabSize`'s own default (`config/coreDefaults.ts`'s
 * `CORE_CONFIGURATION`) — used here only as this module's fallback for
 * callers that don't (yet) thread the live config value through; nothing
 * in this file reads `ConfigService` itself (Req 6.6's cell-width math is
 * config-agnostic by design, same as the rest of this module). */
const DEFAULT_TAB_SIZE = 4;

/**
 * The terminal-cell width of `text`, starting at display column 0, with
 * tabs advancing to the next `tabSize`-wide stop (this module's TSDoc's
 * "Tabs" section). Splits `text` into non-tab runs (each measured via
 * `stringWidth`, preserving grapheme-cluster/CJK/emoji handling exactly as
 * before) and standalone tab characters (each advancing the running column
 * to its stop) — `"\t"` is always its own grapheme cluster, so this split
 * never cuts through a combining mark or a multi-codepoint glyph.
 */
function measureCells(text: string, tabSize: number): number {
  let column = 0;
  let run = "";
  for (const ch of text) {
    if (ch === "\t") {
      column += stringWidth(run);
      run = "";
      column += tabSize - (column % tabSize);
    } else {
      run += ch;
    }
  }
  return column + stringWidth(run);
}

/**
 * The display width, in terminal cells, of `text` (Req 6.6). Ambiguous-width
 * Unicode characters count as narrow (this package's default) — the
 * common case outside CJK-locale terminals; there is no per-terminal
 * detection for this in the MVP (design.md doesn't call for one).
 *
 * `tabSize` defaults to `editor.tabSize`'s own default (4); pass the live
 * config value when one is available so a line's rendered width matches
 * the user's configured tab width.
 */
export function cellWidth(text: string, tabSize: number = DEFAULT_TAB_SIZE): number {
  return measureCells(text, tabSize);
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
 *
 * `tabSize` defaults the same way {@link cellWidth} does, and for the same
 * reason: a tab before `charIndex` must advance the same number of cells
 * here as it does when the whole line is measured, or a cursor placed after
 * a tab would land in the wrong terminal column.
 */
export function cellWidthUpTo(
  text: string,
  charIndex: number,
  tabSize: number = DEFAULT_TAB_SIZE,
): number {
  const clampedIndex = Math.max(0, Math.min(Math.trunc(charIndex) || 0, text.length));
  return measureCells(text.slice(0, clampedIndex), tabSize);
}
