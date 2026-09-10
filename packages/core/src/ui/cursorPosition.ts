/**
 * Pure math for the editor's HARDWARE terminal cursor position (Issue #123
 * — "the IME's unconfirmed/preedit string renders at the bottom of the
 * terminal instead of at the caret"). `editorView.tsx` has always drawn its
 * own caret purely as a background-inverted text run (this module's TSDoc
 * calls it "layer 4") — the terminal's REAL cursor (the one a terminal
 * emulator positions an IME's preedit string against) was never moved at
 * all, so the emulator drew the preedit wherever its own hardware cursor
 * last happened to be, almost always the bottom of the screen. OpenTUI's
 * `CliRenderer` exposes `setCursorPosition(x, y, visible)` for exactly
 * this; `editorView.tsx` calls it after every render that could move the
 * caret. This module holds only the coordinate arithmetic — no OpenTUI
 * import, no React — so it can be unit-tested without a renderer, matching
 * this package's `viewport.ts`/`cellWidth.ts` "keep pure functions pure"
 * convention.
 *
 * **0-based vs 1-based**: verified against this repo's vendored
 * `@opentui/core@0.1.107` compiled output (`node_modules/.bun/
 * @opentui+core@.../@opentui/core/index-mw2x3082.js`,
 * `EditBufferRenderable.renderCursor` — the ONLY other call site in this
 * dependency that both reads a `Renderable`'s `screenX`/`screenY` AND calls
 * `setCursorPosition`, i.e. the one place already answering this exact
 * question for OpenTUI's own native multi-line text-input widget):
 *
 * ```js
 * const cursorX = screenX + visualCursor.visualCol + 1;
 * const cursorY = screenY + visualCursor.visualRow + 1;
 * this._ctx.setCursorPosition(cursorX, cursorY, true);
 * ```
 *
 * `screenX`/`screenY` (`Renderable.screenX`/`screenY`, `Renderable.d.ts`)
 * and `visualCol`/`visualRow` are all 0-based (a `Renderable` positioned at
 * the terminal's top-left corner reports `screenX === 0`; `buffer.
 * drawEditorView(view, screenX, screenY)`, the very next line up in that
 * same file, draws starting AT that 0-based cell). `setCursorPosition`
 * itself is therefore fed 1-based coordinates — matching the classic ANSI
 * "Cursor Position" escape sequence (`CSI row;col H`), which is 1-based —
 * even though every OTHER coordinate this renderer deals with (draw
 * offsets, hit-grid lookups, `screenX`/`screenY` themselves) is 0-based.
 * {@link computeHardwareCursorPosition} below reproduces that same `+ 1`
 * so `editorView.tsx`'s caret lands on the identical terminal cell its own
 * DRAWN caret run already occupies, not one cell off from it.
 */

import { cellWidthUpTo } from "./cellWidth";

/**
 * The prefix-sum cell column of `position.character` within `lineText`
 * (design.md §8.3's "wide characters ... measured with cell-width
 * utilities so cursor columns map to terminal cells correctly"). Moved here
 * from `editorView.tsx` (unchanged behavior — still just forwards to
 * {@link cellWidthUpTo}) so {@link computeHardwareCursorPosition} below can
 * reuse it without `editorView.tsx` importing FROM this module while this
 * module imports back INTO `editorView.tsx` (a cycle) — `editorView.tsx`
 * now re-exports this same binding instead of defining it, so every
 * existing import of `cursorCellColumn` (`ui/index.ts`, `core/index.ts`)
 * keeps resolving to the exact same function, just relocated.
 */
export function cursorCellColumn(lineText: string, character: number, tabSize?: number): number {
  return cellWidthUpTo(lineText, character, tabSize);
}

/** Inputs {@link computeHardwareCursorPosition} needs to place the terminal's
 * real cursor at the caret's current screen cell. */
export interface HardwareCursorPositionInput {
  /** The text plane's own top-left terminal column (`Renderable.screenX`,
   * 0-based) — `editorView.tsx`'s `PositionedNode` ref reads this off the
   * `<box>` that wraps every visible line's gutter-cell-plus-text-runs
   * (this module's TSDoc's "screenX/screenY" paragraph). */
  screenX: number;
  /** The text plane's own top-left terminal row (`Renderable.screenY`,
   * 0-based). */
  screenY: number;
  /** Columns the line-number gutter reserves to the LEFT of column 0 of the
   * text itself (`viewport.ts`'s `gutterDigitWidth`-derived width; `0` when
   * `editor.lineNumbers` is off) — `EditorLineRow`'s own gutter `<text>`
   * already occupies exactly this many columns before its text `<box>`
   * begins, so the caret's terminal column must skip past them too. */
  gutterWidth: number;
  /** 0-based document line the caret sits on (`Selection.active.line`). */
  cursorLine: number;
  /** The FIRST currently-rendered document line — `EditorView`'s own
   * EFFECTIVE, `revealLine`-resolved `scrollTop` local for this render, not
   * necessarily `EditorState.scrollTop` itself (`viewport.ts`'s
   * `revealLine` may adjust it this render to keep a reveal target, e.g.
   * find's active match, on screen — see `editorView.tsx`'s own `scrollTop`
   * local and its TSDoc). */
  scrollTop: number;
  /** One PAST the last currently-rendered document line
   * (`viewport.ts`'s `computeVisibleLineRange`'s own `endLine`) — together
   * with `scrollTop` this is the exact `[scrollTop, endLine)` row window
   * `EditorView` actually materialized as OpenTUI nodes this render,
   * INCLUDING the "fewer lines left than `viewportHeight`" tail-of-document
   * clamp `computeVisibleLineRange` already applies. Needed because the
   * caret is not always the line `revealLine` targeted this render (Req
   * 11.1: while find is open, the ACTIVE MATCH drives `revealLine`
   * instead — the primary cursor, which is what a hardware IME caret must
   * track, can legitimately sit off-screen at that point). */
  endLine: number;
  /** The caret's own document line's full text — {@link cursorCellColumn}
   * needs it to convert `character` into a cell column (wide CJK/emoji
   * characters and tab stops both change how many cells precede a given
   * UTF-16 offset). */
  lineText: string;
  /** 0-based UTF-16 code-unit offset into `lineText` the caret sits at
   * (`Position.character`, Req 5.1's LSP-compatible offsets). */
  character: number;
  /** `editor.tabSize` — forwarded as-is to {@link cursorCellColumn}, whose
   * own default parameter (`cellWidth.ts`'s `DEFAULT_TAB_SIZE`) applies
   * when this is omitted, exactly like every other `tabSize?` parameter in
   * this package. */
  tabSize?: number;
}

/** {@link computeHardwareCursorPosition}'s result. */
export interface HardwareCursorPosition {
  /** 1-based terminal column for `CliRenderer.setCursorPosition` (this
   * module's TSDoc's "0-based vs 1-based"). Meaningless (not clamped to any
   * particular range) when {@link visible} is `false` — a caller should
   * never pass it to `setCursorPosition` with `visible: true` in that
   * case. */
  x: number;
  /** 1-based terminal row for `CliRenderer.setCursorPosition`. Same
   * "meaningless when invisible" caveat as {@link x}. */
  y: number;
  /** `false` when `cursorLine` falls outside the `[scrollTop, endLine)`
   * window this render actually drew (this interface's TSDoc's `endLine`
   * field) — the caret's document line is scrolled off screen, so there is
   * no on-screen cell to place a hardware cursor at. */
  visible: boolean;
}

/**
 * Where the terminal's real hardware cursor belongs for a caret at
 * `input.cursorLine`/`input.character`, given the text plane's current
 * on-screen position and scroll window (Issue #123). Column math reuses
 * {@link cursorCellColumn} (itself `cellWidth.ts`'s `cellWidthUpTo`) so a
 * hardware cursor placed after a full-width CJK character or a tab lands on
 * the SAME cell `buildLineRuns`' drawn caret run already occupies — see
 * this module's top-of-file TSDoc for the `+ 1` (1-based `setCursorPosition`
 * coordinates over 0-based `screenX`/`screenY`/cell-column math).
 */
export function computeHardwareCursorPosition(
  input: HardwareCursorPositionInput,
): HardwareCursorPosition {
  const { screenX, screenY, gutterWidth, cursorLine, scrollTop, endLine, lineText, character, tabSize } =
    input;
  const visible = cursorLine >= scrollTop && cursorLine < endLine;
  const column = cursorCellColumn(lineText, character, tabSize);
  return {
    x: screenX + gutterWidth + column + 1,
    y: screenY + (cursorLine - scrollTop) + 1,
    visible,
  };
}
