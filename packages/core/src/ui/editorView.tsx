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
 * **Virtualization** (Req 13.1): only lines in `computeVisibleLineRange`'s
 * window (`viewport.ts`) ever become OpenTUI nodes — `EditorLineRow` is
 * created and destroyed as the window moves, never held for the whole
 * document.
 *
 * **Dirty-range re-render** (Req 13.1, design.md §7.1's "rendering sync"):
 * `EditorLineRow` is `memo`-wrapped, keyed by (and compared on) its line
 * index's {@link useLineTicks} revision plus a per-line "does a
 * selection/cursor touch this line" summary key — both stay referentially
 * *stable* (as values, not object identities) across a render that does not
 * affect a given line, so an edit to line N does not re-invoke the row
 * function for any other visible line, even though `EditorView` itself
 * re-renders on every document change.
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
import type { Selection } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { ConfigService } from "../config/service";
import { cellWidthUpTo } from "./cellWidth";
import { useLineTicks, type EditorState } from "./editorState";
import type { FocusEmitter } from "./focus";
import { useFocusTracking } from "./focus";
import { computeVisibleLineRange, gutterDigitWidth, revealLine } from "./viewport";
import { styleToTextColors, toColorInput, useTheme } from "./theme";

/** Rows available to the text plane when no `viewportHeight` prop is given
 * (this module's TSDoc — a placeholder ahead of real layout measurement). */
const DEFAULT_VIEWPORT_HEIGHT = 20;

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
 * Merge the text/selection/cursor layers for one document line into a
 * sequence of colored runs (this module's TSDoc's "three pieces of DOM, not
 * four"). `lineText` is padded with one trailing space when a cursor sits
 * at end-of-line (`character === lineText.length`), so that a collapsed
 * cursor at the end of a line still has a cell to render its block into.
 */
function buildLineRuns(params: {
  lineText: string;
  lineIndex: number;
  selections: readonly Selection[];
  colors: EditorLineColors;
}): LineRun[] {
  const { lineText, lineIndex, selections, colors } = params;
  const cursorCols = selections
    .filter((s) => s.active.line === lineIndex)
    .map((s) => s.active.character);
  const needsPad = cursorCols.some((c) => c >= lineText.length);
  const text = needsPad ? `${lineText} ` : lineText;
  const length = text.length;

  // The extension point for the future highlight service (Req 8, design.md
  // §10): no spans exist yet, so this always resolves to `undefined` and
  // every run's base color is `colors.fg` — but every run is still routed
  // through `styleToTextColors` so wiring in real per-span styles later
  // touches only the call site, not this function's structure.
  const baseFg = styleToTextColors(undefined).fg ?? colors.fg;

  const boundaries = new Set<number>([0, length]);
  const selectionRanges: Array<{ start: number; end: number }> = [];
  for (const selection of selections) {
    if (isCollapsed(selection)) continue;
    if (lineIndex < selection.start.line || lineIndex > selection.end.line) continue;
    const start = clampCol(selection.start.line === lineIndex ? selection.start.character : 0, length);
    const end = clampCol(
      selection.end.line === lineIndex ? selection.end.character : length,
      length,
    );
    if (end <= start) continue;
    selectionRanges.push({ start, end });
    boundaries.add(start);
    boundaries.add(end);
  }
  const cursorCells: Array<{ start: number; end: number }> = [];
  for (const col of cursorCols) {
    const start = clampCol(col, length);
    const end = clampCol(start + 1, length);
    if (end <= start) continue;
    cursorCells.push({ start, end });
    boundaries.add(start);
    boundaries.add(end);
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const runs: LineRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start >= end) continue;
    const segment = text.slice(start, end);

    const isCursorCell = cursorCells.some((c) => c.start === start && c.end === end);
    const isSelected = selectionRanges.some((r) => start >= r.start && end <= r.end);

    if (isCursorCell) {
      runs.push({ text: segment, fg: colors.cursorFg, bg: colors.cursorBg });
    } else if (isSelected) {
      runs.push({ text: segment, fg: baseFg, bg: colors.selectionBg });
    } else {
      runs.push({ text: segment, fg: baseFg });
    }
  }
  return runs;
}

/** A stable-across-renders summary of which selections/cursors touch
 * `lineIndex`, used as an `EditorLineRow` memo key (this module's TSDoc):
 * equal strings for two renders mean this line's overlay is unchanged, even
 * though `selections` itself is a fresh array reference every render. */
function lineOverlayKey(lineIndex: number, selections: readonly Selection[]): string {
  const parts: string[] = [];
  for (const s of selections) {
    const touches =
      lineIndex >= Math.min(s.start.line, s.end.line, s.active.line) &&
      lineIndex <= Math.max(s.start.line, s.end.line, s.active.line);
    if (!touches) continue;
    parts.push(`${s.start.line}:${s.start.character}-${s.end.line}:${s.end.character}@${s.active.character}`);
  }
  return parts.join("|");
}

/** Props for the memoized {@link EditorLineRow}. */
interface EditorLineRowProps {
  lineIndex: number;
  text: string;
  selections: readonly Selection[];
  /** From {@link useLineTicks} — the sole "this line's text changed" memo
   * signal (this module's TSDoc). */
  tick: number;
  /** From {@link lineOverlayKey} — the sole "this line's selection/cursor
   * overlay changed" memo signal. */
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
    prev.tick === next.tick &&
    prev.overlayKey === next.overlayKey &&
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
  const contextFocusRef = useFocusTracking("editorTextFocus");
  const [isFocused, isFocusedRef] = useIsFocused();
  const textPlaneRef = useCallback(
    (node: FocusEmitter | null) => {
      contextFocusRef(node);
      isFocusedRef(node);
    },
    [contextFocusRef, isFocusedRef],
  );

  const lineCount = Math.max(1, document.lineCount);
  const primary = state.selections[0];
  const scrollTop = primary
    ? revealLine(primary.active.line, state.scrollTop, viewportHeight, lineCount)
    : Math.max(0, Math.min(state.scrollTop, lineCount - 1));
  const { startLine, endLine } = computeVisibleLineRange(scrollTop, viewportHeight, lineCount);

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
        tick={lineTicks.getLineTick(line)}
        overlayKey={lineOverlayKey(line, state.selections)}
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
 * import here. */
export function cursorCellColumn(lineText: string, character: number): number {
  return cellWidthUpTo(lineText, character);
}
