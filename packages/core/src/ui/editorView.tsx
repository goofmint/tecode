/**
 * `EditorView` — the custom editor component decision #2 of
 * `requirements.md` calls for (Req 6.5, 6.6; design.md §8.3): a virtualized
 * text plane over a {@link CoreDocument}, with an editor-owned
 * gutter/selection/cursor overlay, rather than a wrapped `<textarea>`.
 *
 * **Four layers, back to front (design.md §8.3)** — realized here as three
 * pieces of DOM, not four, because a terminal cell is one atomic
 * (character, foreground, background) unit: a background-only "selection
 * layer" painted as a separate box *after* the text would simply overwrite
 * the character cells beneath it, erasing the glyphs a real "layer on top
 * of text" implies. Instead, each visible line is split into colored
 * *runs* — {@link buildLineRuns} — so the composition happens once, per
 * character range, not as three independently-painted planes:
 *
 * 1. **Gutter** — one `<text>` per visible row, fixed width from
 *    {@link gutterDigitWidth}, shown when `editor.lineNumbers` is truthy.
 * 2. **Text** — the line's characters, run through
 *    {@link styleToTextColors} (currently always `undefined` — no highlight
 *    service exists yet; Req 8/design.md §10's future extension point) for
 *    their base foreground.
 * 3. **Selection** — a run's background is overridden to
 *    `editor.selectionBackground`/`editor.inactiveSelectionBackground`
 *    (focused/unfocused, Req 4.6) wherever it falls inside a selection
 *    range.
 * 4. **Cursor** — a single-cell run at each selection's `active` position is
 *    overridden again (taking priority over the selection color) to a
 *    block cursor: `bg = editorCursor.foreground`, `fg = editor.background`
 *    (inverted, so the character underneath stays legible).
 *
 * **Find-match overlay** (Req 11.1, design.md §13) — a fifth layer, added
 * on top of the four above, driven by `EditorState.find` (`editorState.ts`)
 * rather than `selections`, and rendered ONLY while `find.isOpen` is true
 * (closing the widget hides highlighting without discarding the computed
 * `matches`): every range in `find.matches` gets `editor.
 * findMatchHighlightBackground`; the one at `find.activeMatchIndex` gets
 * the distinct `editor.findMatchBackground` instead — deliberately a
 * DIFFERENT color from `editor.selectionBackground` in either case, so a
 * search result never reads as a normal user selection even where the two
 * happen to coincide. Full priority order for one character cell, highest
 * first: **cursor > current find match > selection > other find matches >
 * base text** — a bracket-matching-style "am I the special one" cascade,
 * same shape `buildLineRuns` already used for cursor-over-selection.
 *
 * **Virtualization** (Req 13.1): only lines in `computeVisibleLineRange`'s
 * window (`viewport.ts`) ever become OpenTUI nodes — `EditorLineRow` is
 * created and destroyed as the window moves, never held for the whole
 * document.
 *
 * **Dirty-range re-render** (Req 13.1, design.md §7.1's "rendering sync"):
 * `EditorLineRow` is `memo`-wrapped, keyed by (and compared on) its line
 * index's {@link useLineTicks} revision, a per-line "does a selection/
 * cursor touch this line" summary key, and its own `spans` array's
 * REFERENCE (not a revision number — see below) — all three stay stable
 * across a render that does not affect a given line, so an edit to line N
 * does not re-invoke the row function for any other visible line, even
 * though `EditorView` itself re-renders on every document change.
 *
 * The `spans` comparison relies on `languages/highlightService.ts`'s
 * `HighlightService.getSpansForLine` TSDoc's reference-stability contract:
 * an untouched line's spans array is the exact same object across calls: a
 * changed line (including a cascading recolor reaching it via tree-sitter's
 * `changedRanges`, not just the edited line itself) always gets a fresh
 * one. An earlier revision of this component instead compared a single
 * whole-`EditorView` `highlightRevision` counter (`editorState.ts`'s
 * `useHighlightRevision`) against every row — coarser than necessary,
 * since `HighlightService.onDidChange` doesn't say which lines changed, so
 * EVERY visible row was forced to re-render on every keystroke regardless
 * of whether that row's own spans actually changed (Issue #65: measured on
 * a 10,000-line document, one keystroke re-executed all 20 visible rows).
 * `useHighlightRevision` is still called, purely to force `EditorView`
 * itself to re-render (and thus re-fetch each row's `getSpansForLine`
 * result) when the service reports a change with no other prop change —
 * see that hook's own TSDoc.
 *
 * **Scope note on `viewportHeight`**: this task measures the available rows
 * via an explicit, caller-supplied `viewportHeight` prop rather than
 * observing the rendered container's actual height at runtime (which would
 * need an OpenTUI resize-event listener wired to a `useState`) — the caller
 * (`shell.tsx`'s `EditorArea`, tests) passes a fixed value. Auto-measurement
 * from the live layout is left to a later task; nothing here would need to
 * change shape to add it (`viewportHeight` would just come from `useState`
 * instead of a prop default).
 */

import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { RenderableEvents, type RGBA } from "@opentui/core";
import type { CaptureName, Range, Selection, Style } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { ConfigService } from "../config/service";
import type { HighlightService, HighlightSpan } from "../languages/highlightService";
import { cellWidthUpTo } from "./cellWidth";
import { useHighlightRevision, useLineTicks, type EditorState } from "./editorState";
import type { FocusableNode, FocusEmitter } from "./focus";
import { useFocusTracking } from "./focus";
import { resolveCaptureStyle } from "./themeLoader";
import { computeVisibleLineRange, gutterDigitWidth, revealLine } from "./viewport";
import { styleToTextColors, toColorInput, useTheme } from "./theme";

/** Rows available to the text plane when no `viewportHeight` prop is given
 * (this module's TSDoc — a placeholder ahead of real layout measurement). */
const DEFAULT_VIEWPORT_HEIGHT = 20;

/** A shared empty-array reference for a line with no `highlightService`
 * wired in at all — avoids allocating a fresh empty array per visible line
 * per render. Only used on that "no service" path: when a service IS wired
 * in, `getSpansForLine` returns its OWN shared empty-array constant for a
 * line with no captures (`highlightService.ts`'s TSDoc), which is a
 * DIFFERENT reference than this one but equally stable — either way, IS
 * part of {@link editorLineRowPropsEqual}'s comparison now (`prev.spans ===
 * next.spans`), not just an allocation saving. */
const EMPTY_SPANS: readonly HighlightSpan[] = [];

/** One line's worth of colored text, after {@link buildLineRuns} has merged
 * the base/selection/cursor layers for that line (this module's TSDoc). */
interface LineRun {
  text: string;
  fg: RGBA;
  bg?: RGBA;
}

/** Colors {@link buildLineRuns}/{@link EditorLineRow} need, pre-resolved
 * from the theme once per `EditorView` render (not per line — see
 * `EditorView`'s `useMemo`, which is what keeps this object
 * reference-stable across renders that don't change the theme or focus
 * state, letting `EditorLineRow`'s memo comparator treat it as one
 * comparable value). */
interface EditorLineColors {
  fg: RGBA;
  selectionBg: RGBA;
  cursorBg: RGBA;
  cursorFg: RGBA;
  lineNumberFg: RGBA;
  lineNumberActiveFg: RGBA;
  /** The CURRENT find match's background (Req 11.1) — distinct from
   * `selectionBg` (this module's TSDoc's "find-match overlay"). */
  findMatchBg: RGBA;
  /** Every OTHER find match's background (Req 11.1) — distinct from both
   * `selectionBg` and `findMatchBg`. */
  findMatchOtherBg: RGBA;
  /** The active theme's capture-name -> style map (Req 8.1, design.md §10)
   * — `buildLineRuns` resolves each highlight span's capture through
   * `themeLoader.ts`'s `resolveCaptureStyle` (longest-prefix fallback,
   * e.g. `"function.builtin"` -> `"function"`) against this. Bundled into
   * the same memoized `colors` object as every other theme-derived value
   * above (this module's TSDoc) rather than threaded as a separate prop,
   * so `EditorLineRow`'s memo comparator keeps comparing exactly one
   * theme-derived reference. */
  tokens: Partial<Record<CaptureName, Style>>;
}

function isCollapsed(selection: Selection): boolean {
  return (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  );
}

function clampCol(value: number, length: number): number {
  return Math.max(0, Math.min(value, length));
}

/** One line-clamped `[start, end)` column range — the shared shape {@link
 * buildLineRuns} clips selections/cursors/find matches into before sorting
 * them into boundaries. */
interface ColRange {
  start: number;
  end: number;
}

/** Clip `range` (in document line/character coordinates) to the columns it
 * covers on `lineIndex` within a line of `length` characters, or `undefined`
 * if `range` doesn't touch `lineIndex` at all, or clips down to nothing
 * (this module's shared helper for selection AND find-match ranges — both
 * are `{ start: Position; end: Position }` shapes). */
function clipRangeToLine(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  lineIndex: number,
  length: number,
): ColRange | undefined {
  if (lineIndex < range.start.line || lineIndex > range.end.line) return undefined;
  const start = clampCol(range.start.line === lineIndex ? range.start.character : 0, length);
  const end = clampCol(range.end.line === lineIndex ? range.end.character : length, length);
  if (end <= start) return undefined;
  return { start, end };
}

/** One highlight span, clipped to a line's `[0, length)` — same shape as
 * {@link ColRange} plus the capture name it resolves a style from. */
interface HighlightRange extends ColRange {
  capture: string;
}

/**
 * Merge the text/selection/cursor/find-match/highlight layers for one
 * document line into a sequence of colored runs (this module's TSDoc's
 * "three pieces of DOM, not four" plus the find-match overlay and the
 * highlight-span foreground, Req 8, design.md §10). `lineText` is padded
 * with one trailing space when a cursor sits at end-of-line (`character ===
 * lineText.length`), so that a collapsed cursor at the end of a line still
 * has a cell to render its block into.
 */
function buildLineRuns(params: {
  lineText: string;
  lineIndex: number;
  selections: readonly Selection[];
  colors: EditorLineColors;
  /** Every current find match (Req 11.1), in document order — empty when
   * find is closed or has no matches (this module's TSDoc's "find-match
   * overlay"). */
  findMatches?: readonly Range[];
  /** Index into `findMatches` of the CURRENT match, or `-1`/out-of-range
   * for "no active match" (renders every entry as an "other" match). */
  activeFindMatchIndex?: number;
  /** This line's syntax-highlight spans (Req 8.1, design.md §10,
   * `languages/highlightService.ts`'s `HighlightService.getSpansForLine`)
   * — empty when no highlight service is wired in, the document's language
   * is `"plaintext"`, or the line has no captures. */
  spans?: readonly HighlightSpan[];
}): LineRun[] {
  const {
    lineText,
    lineIndex,
    selections,
    colors,
    findMatches = [],
    activeFindMatchIndex = -1,
    spans = [],
  } = params;
  const cursorCols = selections
    .filter((s) => s.active.line === lineIndex)
    .map((s) => s.active.character);
  const needsPad = cursorCols.some((c) => c >= lineText.length);
  const text = needsPad ? `${lineText} ` : lineText;
  const length = text.length;

  const boundaries = new Set<number>([0, length]);
  const selectionRanges: ColRange[] = [];
  for (const selection of selections) {
    if (isCollapsed(selection)) continue;
    const clipped = clipRangeToLine(selection, lineIndex, length);
    if (!clipped) continue;
    selectionRanges.push(clipped);
    boundaries.add(clipped.start);
    boundaries.add(clipped.end);
  }
  const cursorCells: ColRange[] = [];
  for (const col of cursorCols) {
    const start = clampCol(col, length);
    const end = clampCol(start + 1, length);
    if (end <= start) continue;
    cursorCells.push({ start, end });
    boundaries.add(start);
    boundaries.add(end);
  }
  // Find-match overlay (this module's TSDoc): split into "the active one"
  // vs "every other one" up front so the render loop below is a flat
  // priority check, not a per-segment index lookup.
  const activeMatchRanges: ColRange[] = [];
  const otherMatchRanges: ColRange[] = [];
  findMatches.forEach((match, index) => {
    const clipped = clipRangeToLine(match, lineIndex, length);
    if (!clipped) return;
    (index === activeFindMatchIndex ? activeMatchRanges : otherMatchRanges).push(clipped);
    boundaries.add(clipped.start);
    boundaries.add(clipped.end);
  });
  // Highlight spans (Req 8, design.md §10): clipped/clamped the same way
  // every other overlay range is, and their boundaries fold into the same
  // sorted segment list so a span's edge never gets merged into a
  // differently-styled neighbor.
  const highlightRanges: HighlightRange[] = [];
  for (const span of spans) {
    const start = clampCol(span.startCol, length);
    const end = clampCol(span.endCol, length);
    if (end <= start) continue;
    highlightRanges.push({ start, end, capture: span.capture });
    boundaries.add(start);
    boundaries.add(end);
  }

  /** This segment's base (highlight-resolved) foreground — Req 8's
   * "highlight foreground sits at the base-text tier" (this module's
   * TSDoc): every non-cursor run below (active match, selection, other
   * match, AND plain base text) uses this SAME per-segment value, so
   * syntax colors show through a selection/find overlay's background,
   * exactly like `colors.fg` already did before highlighting existed. The
   * FIRST highlight range covering `[start, end)` wins (real `.scm`
   * queries rarely produce overlapping captures for the same token; ties
   * break in query/capture order, matching `getSpansForLine`'s own
   * ordering). */
  function resolveSegmentFg(start: number, end: number): RGBA {
    const covering = highlightRanges.find((r) => start >= r.start && end <= r.end);
    if (!covering) return colors.fg;
    const style = resolveCaptureStyle(colors.tokens, covering.capture as CaptureName);
    return styleToTextColors(style).fg ?? colors.fg;
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const runs: LineRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start >= end) continue;
    const segment = text.slice(start, end);

    const isCursorCell = cursorCells.some((c) => c.start === start && c.end === end);
    const isActiveMatch = activeMatchRanges.some((r) => start >= r.start && end <= r.end);
    const isSelected = selectionRanges.some((r) => start >= r.start && end <= r.end);
    const isOtherMatch = otherMatchRanges.some((r) => start >= r.start && end <= r.end);

    // Priority, highest first (this module's TSDoc): cursor > current find
    // match > selection > other find matches > base text. Highlight
    // foreground sits at the base-text tier (`resolveSegmentFg`'s TSDoc) —
    // every tier below cursor uses it, with only the background changing.
    if (isCursorCell) {
      runs.push({ text: segment, fg: colors.cursorFg, bg: colors.cursorBg });
    } else if (isActiveMatch) {
      runs.push({ text: segment, fg: resolveSegmentFg(start, end), bg: colors.findMatchBg });
    } else if (isSelected) {
      runs.push({ text: segment, fg: resolveSegmentFg(start, end), bg: colors.selectionBg });
    } else if (isOtherMatch) {
      runs.push({ text: segment, fg: resolveSegmentFg(start, end), bg: colors.findMatchOtherBg });
    } else {
      runs.push({ text: segment, fg: resolveSegmentFg(start, end) });
    }
  }
  return runs;
}

/** A stable-across-renders summary of which selections/cursors/find matches
 * touch `lineIndex`, used as an `EditorLineRow` memo key (this module's
 * TSDoc): equal strings for two renders mean this line's overlay is
 * unchanged, even though `selections`/`findMatches` are fresh array
 * references every render. Find matches are folded into the SAME key as
 * selections (Req 11.1) — one line's memo signal, not two separately
 * compared props — so a match appearing/disappearing/becoming-active on a
 * line re-renders exactly that line, same as a selection change would. */
function lineOverlayKey(
  lineIndex: number,
  selections: readonly Selection[],
  findMatches: readonly Range[],
  activeFindMatchIndex: number,
): string {
  const parts: string[] = [];
  for (const s of selections) {
    const touches =
      lineIndex >= Math.min(s.start.line, s.end.line, s.active.line) &&
      lineIndex <= Math.max(s.start.line, s.end.line, s.active.line);
    if (!touches) continue;
    parts.push(`${s.start.line}:${s.start.character}-${s.end.line}:${s.end.character}@${s.active.character}`);
  }
  findMatches.forEach((m, index) => {
    if (lineIndex < m.start.line || lineIndex > m.end.line) return;
    const marker = index === activeFindMatchIndex ? "*" : "";
    parts.push(`f${marker}:${m.start.line}:${m.start.character}-${m.end.line}:${m.end.character}`);
  });
  return parts.join("|");
}

/** Props for the memoized {@link EditorLineRow}. */
interface EditorLineRowProps {
  lineIndex: number;
  /** Compared directly (not just via `tick`) in {@link editorLineRowPropsEqual}:
   * `useLineTicks`' shifting can't represent a row it never observed (its
   * TSDoc), so `tick` alone can under-report a content change for a line
   * shifted into view by an edit above it. Comparing `text` too is the
   * backstop that keeps such a row from rendering stale content. */
  text: string;
  selections: readonly Selection[];
  /** Every current find match (Req 11.1) — passed through to
   * {@link buildLineRuns} for the render body; {@link overlayKey} (not this
   * array's identity) is what the memo comparator actually relies on. */
  findMatches: readonly Range[];
  /** Index into `findMatches` of the CURRENT match, `-1` for none. */
  activeFindMatchIndex: number;
  /** This line's syntax-highlight spans (Req 8.1, design.md §10) — passed
   * through to {@link buildLineRuns} for the render body, AND this array's
   * own REFERENCE is what the memo comparator relies on (unlike
   * `findMatches`/`overlayKey` above, which compare a separate summary key
   * instead of the array itself): `languages/highlightService.ts`'s
   * `HighlightService.getSpansForLine` TSDoc's reference-stability contract
   * guarantees a fresh array only when this line's spans actually changed,
   * so `prev.spans === next.spans` is both precise and correct — see this
   * module's top-of-file "Dirty-range re-render" TSDoc. */
  spans: readonly HighlightSpan[];
  /** From {@link useLineTicks} — the primary "this line's text changed" memo
   * signal for observed rows (this module's TSDoc); see `text` above for why
   * it isn't sufficient alone. */
  tick: number;
  /** From {@link lineOverlayKey} — the sole "this line's selection/cursor/
   * find-match overlay changed" memo signal. */
  overlayKey: string;
  gutterWidth: number;
  showLineNumbers: boolean;
  isActiveLine: boolean;
  colors: EditorLineColors;
  /** Test-only instrumentation: called once per actual invocation of this
   * row's render body (never on a memo-skipped re-render) — the dirty-range
   * re-render tests use this to prove an edit re-executes only the lines it
   * touched. Never set outside a test (mirrors `DocumentManagerFs`'s/
   * `ConfigServiceFs`'s documented, deliberately minimal test seams). */
  onDebugRender?: (line: number) => void;
}

function editorLineRowPropsEqual(prev: EditorLineRowProps, next: EditorLineRowProps): boolean {
  return (
    prev.lineIndex === next.lineIndex &&
    prev.text === next.text &&
    prev.tick === next.tick &&
    prev.overlayKey === next.overlayKey &&
    prev.spans === next.spans &&
    prev.gutterWidth === next.gutterWidth &&
    prev.showLineNumbers === next.showLineNumbers &&
    prev.isActiveLine === next.isActiveLine &&
    prev.colors === next.colors
  );
}

/** One visible document line: gutter cell + merged text/selection/cursor
 * runs (this module's TSDoc). Memoized (see {@link editorLineRowPropsEqual})
 * so an edit's dirty range only re-executes the rows it actually touched
 * (Req 13.1). */
const EditorLineRow = memo(function EditorLineRow(props: EditorLineRowProps): ReactNode {
  props.onDebugRender?.(props.lineIndex);
  const runs = buildLineRuns({
    lineText: props.text,
    lineIndex: props.lineIndex,
    selections: props.selections,
    colors: props.colors,
    findMatches: props.findMatches,
    activeFindMatchIndex: props.activeFindMatchIndex,
    spans: props.spans,
  });
  const lineNumberText =
    String(props.lineIndex + 1).padStart(Math.max(0, props.gutterWidth - 1), " ") + " ";

  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      {props.showLineNumbers ? (
        <text
          style={{ width: props.gutterWidth }}
          fg={props.isActiveLine ? props.colors.lineNumberActiveFg : props.colors.lineNumberFg}
        >
          {lineNumberText}
        </text>
      ) : null}
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {runs.map((run, index) => (
          // Index as key is safe here: `runs` is rebuilt from scratch on
          // every actual (non-memo-skipped) invocation of this row, so
          // there is no cross-render identity for a given run to preserve.
          <text key={index} fg={run.fg} bg={run.bg}>
            {run.text}
          </text>
        ))}
      </box>
    </box>
  );
}, editorLineRowPropsEqual);

/** A small local "am I focused" tracker, separate from
 * {@link useFocusTracking} (which only reports into the context service, per
 * its own TSDoc) — `EditorView` additionally needs the boolean itself, to
 * pick `editor.selectionBackground` vs `editor.inactiveSelectionBackground`
 * (Req 4.6, design.md §8.3). Mirrors `focus.tsx`'s own
 * attach/detach-by-reference bookkeeping. */
function useIsFocused(): [boolean, (node: FocusEmitter | null) => void] {
  const [isFocused, setIsFocused] = useState(false);
  const attached = useRef<{ node: FocusEmitter; onFocused: () => void; onBlurred: () => void } | null>(
    null,
  );
  const ref = useCallback((node: FocusEmitter | null) => {
    if (attached.current) {
      const { node: previous, onFocused, onBlurred } = attached.current;
      previous.off(RenderableEvents.FOCUSED, onFocused);
      previous.off(RenderableEvents.BLURRED, onBlurred);
      attached.current = null;
    }
    if (node) {
      const onFocused = () => setIsFocused(true);
      const onBlurred = () => setIsFocused(false);
      node.on(RenderableEvents.FOCUSED, onFocused);
      node.on(RenderableEvents.BLURRED, onBlurred);
      attached.current = { node, onFocused, onBlurred };
    } else {
      setIsFocused(false);
    }
  }, []);
  return [isFocused, ref];
}

/** Props for {@link EditorView}. */
export interface EditorViewProps {
  /** The document this view renders (Req 6.5, 6.6). */
  document: CoreDocument;
  /** This tab's editor state (design.md §8.3) — `state.selections[0]` is
   * the primary cursor that drives reveal scrolling. */
  state: EditorState;
  /** Rows available to the text plane (Req 13.1's virtualization). See this
   * module's TSDoc for why this is a prop rather than a live measurement.
   * Defaults to {@link DEFAULT_VIEWPORT_HEIGHT}. */
  viewportHeight?: number;
  /** Reads `editor.lineNumbers` (Req 9.5, design.md §8.3's gutter). Omitted
   * in isolated tests, where line numbers default to shown (`true`) — the
   * same default `config/coreDefaults.ts` registers. */
  config?: ConfigService;
  /** Test-only instrumentation — see {@link EditorLineRowProps.onDebugRender}. */
  onDebugLineRender?: (line: number) => void;
  /**
   * The syntax-highlighting pipeline (Req 8.1, design.md §10,
   * `languages/highlightService.ts`) — threaded through the composition
   * root the same way `findService` is (`shell.tsx`'s `EditorAreaProps.
   * findService` TSDoc). Optional and absent-safe: omitted entirely (every
   * existing caller/test), every visible line simply gets `spans: []`
   * (this component's row loop) — unhighlighted text, current behavior
   * unchanged.
   */
  highlightService?: Pick<HighlightService, "getSpansForLine" | "onDidChange">;
  /**
   * Reports the text plane's underlying OpenTUI node (or `null` on
   * detach/unmount) alongside this component's own internal focus-tracking
   * ref callbacks (Req 11.1) — `shell.tsx`'s `EditorArea` captures it so
   * that closing the find widget can call `.focus()` on it directly and
   * return focus to the buffer (`findWidget.tsx`'s TSDoc explains why THIS
   * component, not the widget itself, owns that edge-triggered call).
   */
  onTextPlaneNode?: (node: FocusableNode | null) => void;
}

/**
 * The editor view (Req 6.5, 6.6; design.md §8.3): renders the visible
 * window of `document`'s lines with a line-number gutter and a
 * selection/cursor overlay, virtualized so only on-screen lines materialize
 * as OpenTUI nodes. See this module's top-of-file TSDoc for the full layer
 * breakdown and the dirty-range re-render mechanism.
 */
export function EditorView(props: EditorViewProps): ReactNode {
  const { document, state } = props;
  const viewportHeight = props.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const showLineNumbers = props.config?.get<boolean>("editor.lineNumbers") ?? true;

  const theme = useTheme();
  const lineTicks = useLineTicks(document);
  const highlightService = props.highlightService;
  // Return value intentionally unused — this hook's only job here is
  // forcing a re-render when the service fires (see its own TSDoc); each
  // row's `spans` reference, not a shared revision number, is what
  // actually drives the per-row memo comparison below.
  useHighlightRevision(highlightService);
  const contextFocusRef = useFocusTracking("editorTextFocus");
  const [isFocused, isFocusedRef] = useIsFocused();
  const onTextPlaneNode = props.onTextPlaneNode;
  const textPlaneRef = useCallback(
    (node: FocusableNode | null) => {
      contextFocusRef(node);
      isFocusedRef(node);
      onTextPlaneNode?.(node);
    },
    [contextFocusRef, isFocusedRef, onTextPlaneNode],
  );

  const lineCount = Math.max(1, document.lineCount);
  const primary = state.selections[0];
  // Find's active match takes over reveal-target duty from the primary
  // cursor while the widget is open (Req 11.1, this module's TSDoc's
  // "find-match overlay"/`findService.ts`'s "Reveal-on-navigate" — that
  // service only ever updates `find.activeMatchIndex`, relying on THIS
  // per-render derivation to do the actual `revealLine` viewport math, same
  // as it already does for the primary cursor).
  const activeFindMatch =
    state.find?.isOpen && state.find.activeMatchIndex >= 0
      ? state.find.matches[state.find.activeMatchIndex]
      : undefined;
  const revealTargetLine = activeFindMatch ? activeFindMatch.start.line : primary?.active.line;
  const scrollTop =
    revealTargetLine !== undefined
      ? revealLine(revealTargetLine, state.scrollTop, viewportHeight, lineCount)
      : Math.max(0, Math.min(state.scrollTop, lineCount - 1));
  const { startLine, endLine } = computeVisibleLineRange(scrollTop, viewportHeight, lineCount);
  const findMatches = state.find?.isOpen ? state.find.matches : [];
  const activeFindMatchIndex = state.find?.isOpen ? state.find.activeMatchIndex : -1;

  const digitWidth = gutterDigitWidth(lineCount);
  const gutterWidth = showLineNumbers ? digitWidth + 1 : 0;

  // Resolved once per render (not per line), and only actually a *new*
  // object when the theme or focus state changes — `EditorLineRow`'s memo
  // comparator relies on this reference staying stable across renders that
  // don't affect it (this module's TSDoc).
  const colors = useMemo<EditorLineColors>(
    () => ({
      fg: toColorInput(theme.colors["editor.foreground"]),
      selectionBg: toColorInput(
        isFocused
          ? theme.colors["editor.selectionBackground"]
          : theme.colors["editor.inactiveSelectionBackground"],
      ),
      cursorBg: toColorInput(theme.colors["editorCursor.foreground"]),
      cursorFg: toColorInput(theme.colors["editor.background"]),
      lineNumberFg: toColorInput(theme.colors["editorLineNumber.foreground"]),
      lineNumberActiveFg: toColorInput(theme.colors["editorLineNumber.activeForeground"]),
      findMatchBg: toColorInput(theme.colors["editor.findMatchBackground"]),
      findMatchOtherBg: toColorInput(theme.colors["editor.findMatchHighlightBackground"]),
      tokens: theme.tokens,
    }),
    [theme, isFocused],
  );

  const rows: ReactNode[] = [];
  for (let line = startLine; line < endLine; line++) {
    rows.push(
      <EditorLineRow
        key={line}
        lineIndex={line}
        text={document.getLine(line)}
        selections={state.selections}
        findMatches={findMatches}
        activeFindMatchIndex={activeFindMatchIndex}
        spans={highlightService?.getSpansForLine(document.uri, line) ?? EMPTY_SPANS}
        tick={lineTicks.getLineTick(line)}
        overlayKey={lineOverlayKey(line, state.selections, findMatches, activeFindMatchIndex)}
        gutterWidth={gutterWidth}
        showLineNumbers={showLineNumbers}
        isActiveLine={primary ? primary.active.line === line : false}
        colors={colors}
        onDebugRender={props.onDebugLineRender}
      />,
    );
  }

  return (
    <box
      ref={textPlaneRef}
      focusable
      style={{ flexDirection: "column", flexGrow: 1, overflow: "hidden" }}
    >
      {rows}
    </box>
  );
}

/** The prefix-sum cell column of `position.character` within `lineText`
 * (design.md §8.3's "wide characters ... measured with cell-width
 * utilities so cursor columns map to terminal cells correctly") — exported
 * for the future key-routing task (2.2) to compute where a click or a
 * cursor move actually lands, without duplicating {@link cellWidthUpTo}'s
 * import here. `tabSize` is forwarded as-is (see `cellWidth.ts`'s TSDoc on
 * why a tab's cell width isn't a fixed constant); it defaults the same way
 * `cellWidthUpTo` does. */
export function cursorCellColumn(lineText: string, character: number, tabSize?: number): number {
  return cellWidthUpTo(lineText, character, tabSize);
}
