/**
 * Pure viewport math for the `EditorView` (Req 6.5, 6.6, 13.1; design.md
 * §8.3, §15): which document lines are visible for a given scroll offset
 * (virtualization — only these lines materialize as OpenTUI nodes), how a
 * `revealLine` scroll adjusts to keep a target line on screen, the gutter's
 * digit-count width, and (Issue #92) how many of those rows `EditorArea`'s
 * own chrome leaves available in the first place. No UI dependencies — every
 * function here is a plain, deterministic computation over numbers,
 * unit-testable without a renderer (this task's "keep pure functions pure"
 * house convention).
 */

/** The visible line window, as a half-open range `[startLine, endLine)`
 * (0-based document line indices) — matches JS's own slice convention, so
 * `for (let line = startLine; line < endLine; line++)` and
 * `array.slice(startLine, endLine)` both fall out naturally. */
export interface VisibleLineRange {
  /** First visible line (inclusive). */
  startLine: number;
  /** One past the last visible line (exclusive). */
  endLine: number;
}

/**
 * The window of document lines visible at `scrollTop` in a viewport
 * `viewportHeight` rows tall, over a document of `lineCount` lines
 * (design.md §8.3's "virtualized by scroll offset — only `viewportHeight`
 * lines exist as OpenTUI nodes").
 *
 * Handles the "partial last line" case: when the document has fewer lines
 * left below `scrollTop` than `viewportHeight` rows (i.e. the tail of a
 * short file, or a scroll position near the document's end), `endLine` is
 * clamped to `lineCount` rather than overrunning it — the returned range is
 * always a valid, in-bounds slice of `[0, lineCount)`, even when it ends up
 * shorter than `viewportHeight` lines. Degenerates to an empty range
 * (`{ startLine: 0, endLine: 0 }`) for a non-positive `lineCount` or
 * `viewportHeight`, rather than a negative-length or out-of-bounds range.
 */
export function computeVisibleLineRange(
  scrollTop: number,
  viewportHeight: number,
  lineCount: number,
): VisibleLineRange {
  if (lineCount <= 0 || viewportHeight <= 0) {
    return { startLine: 0, endLine: 0 };
  }
  const startLine = Math.max(0, Math.min(Math.trunc(scrollTop) || 0, lineCount - 1));
  const endLine = Math.min(startLine + Math.trunc(viewportHeight), lineCount);
  return { startLine, endLine };
}

/**
 * The new `scrollTop` that keeps `line` visible in a viewport
 * `viewportHeight` rows tall over a `lineCount`-line document (design.md
 * §8.3's "primary cursor drives `revealLine` scrolling"):
 *
 * - `line` above the current window (`line < scrollTop`): scroll up so
 *   `line` becomes the new top row.
 * - `line` below the current window (`line >= scrollTop + viewportHeight`):
 *   scroll down so `line` becomes the new bottom row.
 * - `line` already inside `[scrollTop, scrollTop + viewportHeight)`:
 *   `scrollTop` is returned unchanged (still clamped — see below) — no
 *   scroll jitter for a cursor move that stays on screen.
 *
 * Both `line` and the result are clamped to `[0, max(0, lineCount - 1)]`
 * first — an out-of-range target line (e.g. a stale cursor position after
 * a document shrank) reveals the nearest valid line instead of scrolling
 * past the document's end.
 */
export function revealLine(
  line: number,
  scrollTop: number,
  viewportHeight: number,
  lineCount: number,
): number {
  if (lineCount <= 0) return 0;
  const maxLine = lineCount - 1;
  const clampedLine = Math.max(0, Math.min(Math.trunc(line) || 0, maxLine));
  const clampedScrollTop = Math.max(0, Math.min(Math.trunc(scrollTop) || 0, maxLine));
  const height = Math.max(0, Math.trunc(viewportHeight) || 0);

  if (clampedLine < clampedScrollTop) {
    return clampedLine;
  }
  if (height > 0 && clampedLine >= clampedScrollTop + height) {
    return Math.max(0, Math.min(clampedLine - height + 1, maxLine));
  }
  return clampedScrollTop;
}

/**
 * How many decimal digits are needed to print the highest line number a
 * `lineCount`-line document displays (1-based line numbers, so a
 * `lineCount`-line document's highest number is `lineCount` itself) —
 * design.md §8.3's "gutter — line numbers ..., fixed width from `lineCount`
 * digits". Boundary examples: 9 lines → 1 digit, 10 lines → 2 digits, 99
 * lines → 2 digits, 100 lines → 3 digits. A non-positive `lineCount` (should
 * not occur — every document has at least one line) still reports 1 rather
 * than 0, so the gutter never collapses to zero width.
 */
export function gutterDigitWidth(lineCount: number): number {
  const n = Math.max(1, Math.trunc(lineCount) || 1);
  return String(n).length;
}

/**
 * The chrome `shell.tsx`'s `EditorArea` may draw ABOVE/AROUND its
 * `EditorView` text plane, as row counts (Issue #92, Req 6.5, 6.6, 13.1;
 * design.md §8.1-§8.3): every field is a row count already resolved to `0`
 * when that particular piece of chrome isn't rendered at all this render
 * (never a boolean) — the caller derives each one from the EXACT same
 * condition it uses to decide whether to render that region, so this can
 * never silently drift out of sync with what actually gets drawn. See
 * `shell.tsx`'s `EditorArea` for where each field's value comes from.
 */
export interface EditorAreaChrome {
  /** The tab bar (`components.tsx`'s `Tabs`, over `@opentui/core`'s
   * `<tab-select>`) — rendered when `tabs.length > 0`, `0` rows
   * otherwise. */
  tabBar: number;
  /** `FindWidget` (`findWidget.tsx`) — rendered when `find && isFindOpen
   * && findService`, `0` rows otherwise (Req 11.1). */
  findWidget: number;
  /** `Shell`'s bottom `Panel` — `Panel` is `EditorArea`'s SIBLING, not its
   * descendant (design.md §8.1's component tree), but both sit in the same
   * flex column above `StatusBar`, so `Panel`'s height still eats into the
   * space left for `EditorArea` (and therefore `EditorView`'s text plane)
   * to stretch into. `0` when `layout.panelVisible` is false. */
  panel: number;
  /** `StatusBar` — always rendered, so always reserved in practice, but
   * still supplied by the caller (not hardcoded here) for the same
   * "never drifts from what's actually drawn" discipline as every other
   * field. */
  statusBar: number;
}

/**
 * Rows left for `EditorView`'s text plane once `EditorArea`'s own chrome
 * is subtracted from the real terminal height (Issue #92 — "Only the
 * first 20 lines are displayed" regardless of how tall the terminal
 * actually is, because `EditorView`'s `viewportHeight` prop was never
 * threaded from a live measurement at all; see that component's
 * top-of-file "Scope note on `viewportHeight`" TSDoc for the fuller
 * history). Clamped to a minimum of `1`: a terminal too short (or too much
 * chrome) to fit even one full row of chrome-plus-text still gets a usable,
 * positive `viewportHeight` rather than `0`/negative, which
 * `computeVisibleLineRange` would otherwise turn into an empty (fully
 * blank) window.
 */
export function computeEditorViewportHeight(terminalHeight: number, chrome: EditorAreaChrome): number {
  const consumed = chrome.tabBar + chrome.findWidget + chrome.panel + chrome.statusBar;
  const available = Math.trunc(terminalHeight) - Math.trunc(consumed);
  return Math.max(1, available);
}
