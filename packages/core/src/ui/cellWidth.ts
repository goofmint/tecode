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
 * Normalizes a caller-supplied `tabSize` to a positive integer before it
 * reaches {@link measureCells}'s `column % tabSize` math: `0` would divide
 * by zero (`NaN` columns), and negative/fractional/non-finite values would
 * produce columns that are not valid terminal cells. Fractions are
 * truncated; anything not at least 1 after truncation falls back to
 * {@link DEFAULT_TAB_SIZE} — a bad config value is a display-layer concern,
 * not worth crashing a render over (same policy as `cellWidthUpTo`'s
 * index clamping).
 */
function normalizeTabSize(tabSize: number): number {
  const truncated = Number.isFinite(tabSize) ? Math.trunc(tabSize) : 0;
  return truncated >= 1 ? truncated : DEFAULT_TAB_SIZE;
}

/**
 * The terminal-cell width of `text`, starting at display column 0, with
 * tabs advancing to the next `tabSize`-wide stop (this module's TSDoc's
 * "Tabs" section). Splits `text` into non-tab runs (each measured via
 * `stringWidth`, preserving grapheme-cluster/CJK/emoji handling exactly as
 * before) and standalone tab characters (each advancing the running column
 * to its stop) — `"\t"` is always its own grapheme cluster, so this split
 * never cuts through a combining mark or a multi-codepoint glyph.
 */
function measureCells(text: string, rawTabSize: number): number {
  const tabSize = normalizeTabSize(rawTabSize);
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

/**
 * A shared, stateless grapheme segmenter (Issue #104) — `measureCells`
 * above walks `text` with `for (const ch of text)`, which is code-POINT
 * iteration, fine for summing a whole string's width but too coarse for
 * {@link truncateToWidth}'s job of stopping mid-string: slicing on a
 * code-point boundary can cut a ZWJ emoji sequence in half or separate a
 * combining mark from its base, producing a dangling low surrogate or an
 * orphaned combining character at the cut point. `Intl.Segmenter`
 * (`granularity: "grapheme"`) walks whole grapheme clusters instead — the
 * same technique `packages/builtin/editor-core/wordBoundary.ts` uses for
 * cursor-safe word/character navigation (that module's own TSDoc names this
 * exact tradeoff: "the same … approach `@tecode/core`'s `ui/cellWidth.ts`
 * uses" for cell-width measurement — this function is that promise,
 * fulfilled; `wordBoundary.ts` duplicates the technique rather than
 * importing from here, since `editor-core` cannot depend on `@tecode/core`,
 * this repo's layering rule). A single instance is reused across calls
 * (Segmenter construction is the expensive part; segmenting is cheap),
 * matching `wordBoundary.ts`'s own `GRAPHEME_SEGMENTER` precedent.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncates `text` to fit within `maxWidth` terminal cells (Issue #104: a
 * file name wider than the explorer sidebar wrapped onto a second row
 * instead of being cut off with an ellipsis), returning `text` unchanged
 * when it already fits. Built on this module's own {@link cellWidth}
 * machinery (`measureCells`) rather than a second width implementation —
 * `Tree`'s per-row budget (`components.tsx`) and every test in
 * `cellWidth.test.ts` reason about width the same way for both whole-string
 * measurement and truncation.
 *
 * **Grapheme-safe cutting**: the fast "already fits" check measures the
 * whole string in one `measureCells` call (identical to {@link cellWidth}),
 * but the actual cut walks {@link GRAPHEME_SEGMENTER}'s clusters one at a
 * time, accumulating each cluster's width (tabs advance to their next stop,
 * exactly as `measureCells` does; every other cluster is measured via
 * `stringWidth`) until the NEXT cluster would overflow the budget left
 * after reserving room for `ellipsis`. This guarantees the cut always lands
 * on a cluster boundary — never inside a ZWJ sequence or between a
 * combining mark and its base.
 *
 * **Degenerate cases** (all exist to keep this function's one hard
 * postcondition true — `cellWidth(truncateToWidth(text, maxWidth)) <=
 * max(0, maxWidth)`, for every input, no exceptions):
 * - `maxWidth <= 0` (including `NaN`, which `Number.isFinite` rejects, and
 *   negative widths from a stale/miscomputed layout): returns `""` — there
 *   is no non-negative width `""` doesn't already satisfy, and any
 *   non-empty result would violate the postcondition outright.
 * - `maxWidth` too small to fit even `ellipsis` alone (`maxWidth` in cells
 *   is less than `cellWidth(ellipsis)`, e.g. `maxWidth: 0` for the default
 *   single-cell `"…"` — already covered above — but this branch is what
 *   actually protects a caller passing a WIDER multi-cell ellipsis):
 *   returns `""` rather than a partial ellipsis.
 * - `maxWidth` exactly `cellWidth(ellipsis)` (e.g. `1` for the default
 *   `"…"`), including a single 2-cell CJK character against `maxWidth: 1`:
 *   there is zero budget left for any of `text`'s own content once
 *   `ellipsis` is reserved, so the result is `ellipsis` alone — this is the
 *   chosen answer to "just the ellipsis, or nothing?": a bare ellipsis
 *   still communicates "truncated" (an empty string does not), and it is
 *   the natural zero-iterations output of the walk below rather than a
 *   special case.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = "…",
  tabSize: number = DEFAULT_TAB_SIZE,
): string {
  const safeMaxWidth = Number.isFinite(maxWidth) ? Math.trunc(maxWidth) : 0;
  if (safeMaxWidth <= 0) return "";
  if (measureCells(text, tabSize) <= safeMaxWidth) return text;

  const safeTabSize = normalizeTabSize(tabSize);
  const ellipsisWidth = measureCells(ellipsis, tabSize);
  const budget = safeMaxWidth - ellipsisWidth;
  if (budget < 0) return "";

  let column = 0;
  let kept = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const increment =
      segment === "\t" ? safeTabSize - (column % safeTabSize) : stringWidth(segment);
    if (column + increment > budget) break;
    column += increment;
    kept += segment;
  }
  return kept + ellipsis;
}
