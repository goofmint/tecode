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
 * **Scope note on `viewportHeight`** (Issue #92 — "Only the first 20 lines
 * are displayed" regardless of terminal size): this component itself still
 * takes the available rows as an explicit, caller-supplied `viewportHeight`
 * prop rather than observing its own rendered container's height at
 * runtime — `EditorView` has no OpenTUI resize-event listener of its own,
 * and does not need one. The auto-measurement lives one level up instead:
 * `shell.tsx`'s `EditorArea` reads the LIVE terminal height
 * (`useLiveTerminalHeight`, wrapping `@opentui/react`'s resize event) and
 * subtracts exactly the chrome it itself renders (tab bar, find widget,
 * `Shell`'s sibling `Panel`, `StatusBar` —
 * `viewport.ts`'s `computeEditorViewportHeight`), then passes the result
 * down as this prop — so a real terminal resize reactively resizes the
 * text plane's virtualization window, even though `EditorView` never reads
 * the terminal itself. Every other caller (every test in this file,
 * `editorView.snapshot.test.tsx`) keeps passing a fixed value exactly as
 * before — `viewportHeight` still just is a number this component trusts,
 * whatever supplies it. Omitting the prop entirely (no live terminal
 * available, e.g. a caller/test outside a real `CliRenderer`) falls back
 * to `DEFAULT_VIEWPORT_HEIGHT` below, unchanged.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { RenderableEvents, type RGBA } from "@opentui/core";
import type { CaptureName, Range, Selection, Style } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { ConfigService } from "../config/service";
import type { HighlightService, HighlightSpan } from "../languages/highlightService";
import { CONTROL_CHAR_PLACEHOLDER, isUnsafeRenderChar } from "./cellWidth";
import { computeHardwareCursorPosition } from "./cursorPosition";
import { useHighlightRevision, useLineTicks, type EditorState } from "./editorState";
import type { FocusableNode, FocusEmitter } from "./focus";
import { useFocusContextService, useFocusTracking } from "./focus";
import { resolveCaptureStyle } from "./themeLoader";
import { computeVisibleLineRange, gutterDigitWidth, revealLine } from "./viewport";
import { styleToTextColors, toColorInput, useTheme } from "./theme";

/** Rows available to the text plane when no `viewportHeight` prop is given
 * (this module's TSDoc — a placeholder ahead of real layout measurement). */
const DEFAULT_VIEWPORT_HEIGHT = 20;

/**
 * Whether `EditorView` makes the terminal's HARDWARE cursor
 * (`CliRenderer.setCursorPosition`, Issue #123) actually visible, and —
 * governed by the exact same constant — whether {@link buildLineRuns}
 * still draws its OWN caret as an inverted-background text run (this
 * module's top-of-file TSDoc's layer 4). One flag drives BOTH: flipping it
 * to `true` makes the real terminal cursor visible (third argument to
 * `setCursorPosition`, in the sync effect below) AND suppresses the drawn
 * run in the SAME render (`buildLineRuns`'s `isCursorCell` branch below) —
 * never two independently-drifting toggles that could show both at once or
 * neither.
 *
 * Defaults to `false`: the hardware cursor is kept invisible and only its
 * POSITION is synced (Issue #123's actual fix — an IME reads a terminal's
 * reported cursor position to place its preedit string regardless of
 * whether that cursor is drawn visibly), while the existing drawn caret
 * keeps rendering exactly as it did before this issue — no visual
 * regression for a terminal/IME combination this codebase has not verified
 * against real hardware.
 *
 * **Why this is `true` (Issue #136)**: Issue #123 shipped this as `false`
 * — position the real cursor but leave it hidden, keeping the drawn run as
 * the visible caret — on the hope that a terminal's IME would honor an
 * invisible cursor's reported position. Real-machine testing said
 * otherwise: the preedit string still landed at the bottom of the
 * terminal. The TUI tools that get this right (Vim, Claude Code) all keep
 * a genuinely visible hardware cursor, and that is what an IME actually
 * follows. So the real cursor is drawn, and the inverted-background run
 * that used to stand in for it is suppressed — but only while the editor
 * is focused, since the hardware cursor is hidden whenever focus is
 * elsewhere and something still has to show where the caret sits (see
 * `EditorLineColors.drawCaret`).
 */
const HARDWARE_CURSOR_VISIBLE = true;

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
  /** Whether {@link buildLineRuns} should paint the caret cell itself
   * (Issue #136). `false` while the real terminal cursor is both visible
   * AND owned by this editor — two caret indicators on one cell reads as a
   * rendering bug. `true` whenever the hardware cursor is not showing the
   * caret: the editor is unfocused (the sync effect hides the real cursor
   * so the focused region can own it), or `HARDWARE_CURSOR_VISIBLE` is
   * off. Without this, an unfocused editor would show no caret at all —
   * the position it would return to on refocus would simply be invisible. */
  drawCaret: boolean;
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

/**
 * Replace every {@link isUnsafeRenderChar} character in `text` with
 * `cellWidth.ts`'s {@link CONTROL_CHAR_PLACEHOLDER} (Issue #137 — "opening a
 * binary file corrupts subsequent rendering"): a detected binary file
 * already aborts its own open (`buffer/documentManager.ts`'s
 * `openDocumentUncached`), but this is the second, independent layer of
 * defense for whatever control byte or `�` slips past that check —
 * e.g. a text file with a stray control character, or one with invalid (but
 * not NUL) byte sequences that decoded to `�`. Applied to EVERY line
 * `buildLineRuns` renders, not only ones a caller suspects.
 *
 * **Display-only**: this never touches `LineBuffer`'s stored text or what
 * `save()` writes to disk — only the string that ends up inside `<text>`
 * here. `document.getLine`, read separately by this file's hardware-cursor
 * sync effect below, keeps returning the untouched original.
 *
 * **Length-preserving by construction** — one character in, one character
 * out, always — which is why {@link buildLineRuns} calls this BEFORE
 * computing `needsPad`/`length`/every column below: every `Selection`/
 * find-match offset it receives is a UTF-16 code-unit index into the
 * ORIGINAL `lineText` (`Position.character`, Req 5.1), and those offsets
 * must land on the exact same code units in the sanitized string for the
 * cursor/selection/highlight math further down to stay correct.
 * `cellWidth.ts`'s `measureCells` treats the same {@link isUnsafeRenderChar}
 * characters as this exact placeholder's width (that module's own TSDoc) so
 * the hardware-cursor sync — computed from the RAW, un-sanitized
 * `document.getLine` text via `cursorPosition.ts` — still agrees with what
 * this sanitized rendering actually draws.
 */
function sanitizeControlChars(text: string): string {
  let result = "";
  let changed = false;
  for (const ch of text) {
    if (isUnsafeRenderChar(ch)) {
      result += CONTROL_CHAR_PLACEHOLDER;
      changed = true;
    } else {
      result += ch;
    }
  }
  return changed ? result : text;
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
    lineText: rawLineText,
    lineIndex,
    selections,
    colors,
    findMatches = [],
    activeFindMatchIndex = -1,
    spans = [],
  } = params;
  // Issue #137: sanitize BEFORE any of the column math below — see
  // `sanitizeControlChars`'s own TSDoc for why this has to happen first
  // (every offset below indexes into whichever string is used here, and
  // sanitizing is length-preserving so those offsets stay valid either way).
  const lineText = sanitizeControlChars(rawLineText);
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
  // The PRIMARY caret's column on this line, if it is on this line at all
  // (CodeRabbit, PR #143). The hardware cursor can only ever be in one
  // place, and `cursorPosition.ts` points it at `selections[0]` — so that
  // is the only caret `colors.drawCaret === false` may suppress. Every
  // OTHER caret in a multi-cursor selection has nothing showing it but the
  // drawn run, and would simply vanish while the editor is focused.
  const primaryCursorCol =
    selections[0] && selections[0].active.line === lineIndex ? selections[0].active.character : undefined;
  const cursorCells: ColRange[] = [];
  let primaryCursorCell: ColRange | undefined;
  for (const col of cursorCols) {
    const start = clampCol(col, length);
    const end = clampCol(start + 1, length);
    if (end <= start) continue;
    const cell = { start, end };
    cursorCells.push(cell);
    if (primaryCursorCol !== undefined && col === primaryCursorCol && !primaryCursorCell) {
      primaryCursorCell = cell;
    }
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
    const isPrimaryCursorCell =
      primaryCursorCell !== undefined && primaryCursorCell.start === start && primaryCursorCell.end === end;
    const isActiveMatch = activeMatchRanges.some((r) => start >= r.start && end <= r.end);
    const isSelected = selectionRanges.some((r) => start >= r.start && end <= r.end);
    const isOtherMatch = otherMatchRanges.some((r) => start >= r.start && end <= r.end);

    // Priority, highest first (this module's TSDoc): cursor > current find
    // match > selection > other find matches > base text. Highlight
    // foreground sits at the base-text tier (`resolveSegmentFg`'s TSDoc) —
    // every tier below cursor uses it, with only the background changing.
    // `colors.drawCaret` (Issue #136, that field's own TSDoc): this drawn,
    // inverted-background run stands in for a caret only when the real
    // terminal cursor is not already showing one — an unfocused editor, or
    // `HARDWARE_CURSOR_VISIBLE` off. While the editor IS focused the real
    // cursor owns the caret (that is what an IME follows), so this branch
    // is skipped and the cell falls through to whatever lower-priority
    // tier it would otherwise render as.
    //
    // ...but only for the PRIMARY caret (CodeRabbit, PR #143): there is
    // exactly one hardware cursor, pointed at `selections[0]`, so a
    // multi-cursor edit's other carets keep their drawn runs or they would
    // have nothing showing them at all.
    if (isCursorCell && (colors.drawCaret || !isPrimaryCursorCell)) {
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

/** The narrow slice of an OpenTUI `Renderable` the hardware-cursor sync
 * effect below needs (Issue #123) — `Renderable.screenX`/`screenY`
 * (`Renderable.d.ts`), the absolute terminal cell the text plane's own
 * `<box>` currently renders at. Deliberately as minimal a structural
 * interface as {@link FocusEmitter}/{@link FocusableNode} (`focus.tsx`) are
 * for the same node — this module never needs to call anything else on it,
 * so it never asks the type system for anything else. */
interface PositionedNode {
  screenX: number;
  screenY: number;
}

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
   * module's TSDoc's "Scope note on `viewportHeight`" for why this
   * component takes it as a prop rather than measuring its own container:
   * `shell.tsx`'s `EditorArea` is what actually derives it from the live
   * terminal size (Issue #92). Defaults to {@link DEFAULT_VIEWPORT_HEIGHT}
   * when omitted. */
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
  // The text plane's own OpenTUI node, read for its `screenX`/`screenY`
  // (Issue #123's hardware-cursor sync effect below) — a plain ref, not
  // React state, since a screen-position CHANGE never needs to trigger a
  // re-render by itself (the effect re-reads it directly after every
  // render that could have moved it; see that effect's own dependency
  // list).
  const positionedNodeRef = useRef<PositionedNode | null>(null);
  // The real OpenTUI node this ref attaches to satisfies `FocusableNode`
  // AND `PositionedNode` at once (both are narrow structural VIEWS of the
  // same underlying `Renderable`, `focus.tsx`'s own convention) — declaring
  // the callback's parameter as their intersection lets this one ref
  // callback feed both `positionedNodeRef` below and every existing
  // `FocusableNode`-typed consumer (`contextFocusRef`/`isFocusedRef`/
  // `onTextPlaneNode`) without a cast.
  const textPlaneRef = useCallback(
    (node: (FocusableNode & PositionedNode) | null) => {
      contextFocusRef(node);
      isFocusedRef(node);
      positionedNodeRef.current = node;
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

  // Hardware terminal cursor sync (Issue #123 — "the IME's unconfirmed
  // string renders at the bottom of the terminal instead of at the
  // caret"): `renderer.setCursorPosition` is OpenTUI's own primitive for
  // moving the REAL terminal cursor an IME positions its preedit string
  // against — this codebase never called it at all before this issue, so
  // the emulator always drew preedit wherever its cursor last happened to
  // sit, almost always the bottom of the screen. `useRenderer()` mirrors
  // `modalOverlay.tsx`'s own direct (unguarded) use of the same hook: both
  // components are only ever mounted under a live `CliRenderer` (`Shell`'s
  // composition root in production, `testRender` in every test that
  // actually renders `EditorView` — see `cursorPosition.ts`'s TSDoc for how
  // that was verified), so there is no "no renderer mounted" case to guard
  // against here, unlike `shell.tsx`'s `EditorArea`/`Panel`, which even a
  // bare unit test can construct outside any renderer at all.
  const renderer = useRenderer();
  // `useTerminalDimensions()` (`@opentui/react`, same import as
  // `modalOverlay.tsx`) reactively tracks the live terminal's own
  // column/row count — included below purely as a dependency-array signal:
  // a resize can move the text plane's `screenX`/`screenY` (a sidebar
  // reflowing, `EditorArea`'s own chrome changing height) without any of
  // this render's OTHER cursor-position inputs changing, and the sync
  // effect must re-read `positionedNodeRef.current`'s freshly-relaid
  // `screenX`/`screenY` when that happens.
  // Subscribed for the RE-RENDER, not for the value (CodeRabbit, PR #132):
  // the sync effect below reads `screenX`/`screenY` live and has no
  // dependency array, so it just needs *a* render to happen after a resize
  // relays the text plane. Nothing here reads the returned dimensions.
  useTerminalDimensions();
  // Phase 2 (Issue #123): read through the SAME shared `ContextService`
  // `terminalFocus`/`explorerFocus`/every other region's focus state
  // already lives in (`focus.tsx`'s `useFocusContextService`) — not this
  // component's own local `isFocused` (though the two always agree, since
  // both derive from the identical `FOCUSED`/`BLURRED` events on the exact
  // same node) — so this effect reads cursor OWNERSHIP the same way
  // `shell.tsx`'s `EditorArea` do-not-steal guard already does, rather than
  // introducing a second, editor-view-local notion of "do I have focus"
  // that could drift from it.
  const focusContext = useFocusContextService();
  useLayoutEffect(() => {
    // `setCursorPosition` is a real `CliRenderer` method (`renderer.d.ts`)
    // in every environment this component actually runs in (this effect's
    // own top comment) — still guarded defensively, per this task's own
    // instruction, against a future/foreign `renderer` implementation that
    // omits it rather than assuming the method is always present.
    if (typeof renderer.setCursorPosition !== "function") return;

    const editorTextFocus = focusContext?.get<boolean>("editorTextFocus") ?? false;
    if (!editorTextFocus) {
      // Cursor ownership belongs to whatever DOES have focus right now
      // (the terminal panel's own pty, the explorer, a modal input, ...) —
      // hide ours so an editor-owned hardware cursor never lingers on
      // screen once this component's text plane loses focus (Phase 2's
      // "干渉を起こさないことだけを保証する" — this component makes no
      // attempt to manage any OTHER region's cursor, only to get out of
      // the way of it).
      renderer.setCursorPosition(1, 1, false);
      return;
    }

    const node = positionedNodeRef.current;
    if (!node || !primary) {
      renderer.setCursorPosition(1, 1, false);
      return;
    }

    const cursorLine = primary.active.line;
    // `document.getLine` THROWS a `RangeError` for an out-of-bounds line
    // (`lineBuffer.ts`'s own `getLine`) — unlike the render body above,
    // which only ever calls it for a `line` `computeVisibleLineRange`
    // already clamped into `[0, lineCount)`, `primary.active.line` is
    // whatever `EditorState.selections` currently holds, with no such
    // guarantee re-checked here. A stale selection racing a shrinking
    // document (Req 5.4's undo/redo, a large delete) must not crash this
    // effect — this seam is guarded the same "never throw past here" way
    // `editor/inputRouter.ts`'s own `routeKeyEvent`/`insertText` are.
    if (cursorLine < 0 || cursorLine >= document.lineCount) {
      // 1-based origin (`cursorPosition.ts`'s TSDoc) — 0 is clamped up to 1
      // by the renderer anyway, so say what is actually meant.
      renderer.setCursorPosition(1, 1, false);
      return;
    }
    const position = computeHardwareCursorPosition({
      screenX: node.screenX,
      screenY: node.screenY,
      gutterWidth,
      cursorLine,
      scrollTop,
      endLine,
      lineText: document.getLine(cursorLine),
      character: primary.active.character,
      tabSize: props.config?.get<number>("editor.tabSize"),
    });
    // `HARDWARE_CURSOR_VISIBLE` (this module's own top-of-file TSDoc) is
    // the single flag governing whether the real cursor is actually drawn;
    // `position.visible` (this render's OWN "is the caret's line even on
    // screen" fact, `cursorPosition.ts`'s TSDoc) independently forces it
    // invisible when the caret is scrolled off screen, regardless of that
    // flag's value — there is no on-screen cell to show a cursor at in
    // that case either way.
    renderer.setCursorPosition(position.x, position.y, HARDWARE_CURSOR_VISIBLE && position.visible);
    // NO dependency array, deliberately (CodeRabbit, PR #132): every input
    // above is read live — `positionedNodeRef.current`'s `screenX`/
    // `screenY`, and `document.getLine(cursorLine)` — and both can change
    // without any value a dependency list could name changing with them.
    // A same-UTF-16-length replacement re-renders through
    // `useLineTicks(document)` while `primary.active.line`/`.character`
    // stay put, yet the caret's CELL column moves whenever the replaced
    // text differs in width (an ASCII run becoming CJK, `cellWidthUpTo`'s
    // whole reason for existing). A sidebar resize moves `screenX` with
    // the terminal's own dimensions unchanged. Listing those would mean
    // re-deriving, as dependencies, the very quantities this effect exists
    // to compute. Running on every render is cheap — one `getLine`, one
    // width scan, one `setCursorPosition` — and cannot go stale.
  });

  // Unmount cleanup (CodeRabbit, PR #132): the sync effect above has no
  // cleanup function of its own, so it only ever runs again on a RE-RENDER
  // — if `EditorView` is unmounted while its text plane is still focused
  // (a tab closing without a prior blur, mirroring `focus.tsx`'s own
  // "detaching a still-focused node" gap), no further render happens to
  // pick up the loss of focus and re-hide the cursor. `useFocusTracking`'s
  // own detach handling (`focus.tsx`) only resets the `editorTextFocus`
  // CONTEXT KEY on unmount, not the renderer's actual cursor position —
  // those are two separate pieces of state. Left alone, the LAST position
  // this effect wrote stays on the renderer forever: `HARDWARE_CURSOR_
  // VISIBLE` being `false` keeps it invisible, but an IME that reads a
  // terminal's reported cursor position regardless of visibility (this
  // module's own `HARDWARE_CURSOR_VISIBLE` TSDoc) could still place its
  // preedit string at this now-destroyed editor's stale caret instead of
  // wherever focus actually lands next. Resetting to the renderer's origin,
  // invisible, matches the sync effect's own "not focused"/"no primary
  // selection" branches above.
  useLayoutEffect(
    () => () => {
      if (typeof renderer.setCursorPosition === "function") {
        // (1, 1), not (0, 0): `setCursorPosition` takes 1-based, CUP-style
        // coordinates (`cursorPosition.ts`'s own TSDoc, verified against
        // `EditBufferRenderable.renderCursor`'s `+ 1`), so 1 IS the origin
        // here — passing 0 just gets clamped back up to 1 by the renderer.
        renderer.setCursorPosition(1, 1, false);
      }
    },
    [renderer],
  );

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
      drawCaret: !HARDWARE_CURSOR_VISIBLE || !isFocused,
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

/** Re-exported for backward compatibility: every existing import of
 * `cursorCellColumn` (`ui/index.ts`, `core/index.ts`, the future
 * key-routing task 2.2 this function was originally added for) keeps
 * resolving through `editorView.tsx` exactly as before. The implementation
 * itself now lives in `cursorPosition.ts` — see that module's own TSDoc for
 * why (Issue #123: {@link computeHardwareCursorPosition} needs to reuse it,
 * and defining it there instead of importing it back from here avoids a
 * module cycle). */
export { cursorCellColumn } from "./cursorPosition";
