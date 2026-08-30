/**
 * Pure sidebar-width clamping (Issue #105; Req 6.4, design.md §8.2's
 * "persist layout state (sidebar width, visibility) across sessions"): the
 * one clamp every entry point that can change `LayoutState.sidebarWidth`
 * shares — a hand-edited `state.json` (`layoutState.ts`'s
 * `coerceLayoutState`), the live render site (`shell.tsx`'s `Shell`), the
 * `workbench.sidebarWidth` setting (`sidebarWidthConfigSync.ts`), the two
 * `workbench.action.increase/decreaseSidebarWidth` commands
 * (`sidebarWidthCommands.ts`), and a mouse drag on the sidebar's own right
 * border (`shell.tsx`'s `Sidebar`). No UI dependencies: a plain,
 * deterministic computation over numbers, unit-testable without a renderer
 * (matches `viewport.ts`'s `computeEditorViewportHeight`, this module's own
 * shape).
 *
 * **Two independent floors/ceilings, not one**:
 *  - {@link MIN_SIDEBAR_WIDTH} is an ABSOLUTE floor, applied even when no
 *    terminal width is known at all (`coerceLayoutState` reads `state.json`
 *    before any live terminal exists) — comfortably above `shell.tsx`'s
 *    `ActivityBar`'s own fixed 4-column width, so a corrupt/hand-edited
 *    `sidebarWidth: 0` (or a negative value) never renders a sidebar
 *    narrower than the activity bar it sits beside, let alone a
 *    zero/negative one Yoga would otherwise have to make sense of on its
 *    own.
 *  - `terminalWidth`, when given, adds a CEILING on top of that floor: the
 *    sidebar must never grow so wide that the `EditorArea` it competes with
 *    for columns (the same flex row, `shell.tsx`'s `Shell`) is squeezed to
 *    nothing — {@link MIN_EDITOR_WIDTH} columns are always reserved for it,
 *    past the activity bar's own width. `coerceLayoutState` never has a
 *    terminal width to pass (Req 6.4's persistence runs before any renderer
 *    exists), so it only ever applies the floor; `shell.tsx`'s `Shell` is
 *    the one call site with a LIVE terminal width
 *    (`useLiveTerminalDimensions`), so it is the only place the ceiling is
 *    actually enforced. A terminal too narrow to honor both floors at once
 *    still gets {@link MIN_SIDEBAR_WIDTH} rather than something narrower
 *    (this function's own "still usable" policy, matching
 *    `computeEditorViewportHeight`'s identical "clamp to a minimum of 1
 *    rather than 0/negative" precedent).
 */

/**
 * The absolute floor for `LayoutState.sidebarWidth` (Issue #105) —
 * comfortably above `shell.tsx`'s `ActivityBar`'s own fixed 4-column width
 * (duplicated here as {@link ACTIVITY_BAR_WIDTH_FOR_CAP} rather than
 * imported: `shell.tsx` already imports {@link clampSidebarWidth} from this
 * module, so the reverse edge would be circular — matches
 * `coreDefaults.ts`'s `DEFAULT_COLOR_THEME_ID`/`DEFAULT_KEYBINDING_PRESET`
 * precedent for this exact kind of small, hand-kept-in-sync duplication).
 * Wide enough to show a handful of characters of a tree label even at the
 * narrowest allowed width.
 */
export const MIN_SIDEBAR_WIDTH = 10;

/**
 * Columns always reserved for `EditorArea` once a live `terminalWidth` is
 * known (this module's TSDoc) — an arbitrary but deliberate "still usable"
 * floor, not a measurement of any particular editor feature's minimum.
 * Exported (rather than kept private like {@link ACTIVITY_BAR_WIDTH_FOR_CAP}
 * below) so `sidebarWidth.test.ts` can assert the exact cap the
 * terminal-aware branch computes, as a genuine drift guard against
 * `ACTIVITY_BAR_WIDTH_FOR_CAP`'s hand-kept-in-sync duplication going stale.
 */
export const MIN_EDITOR_WIDTH = 20;

/**
 * Duplicated from `shell.tsx`'s `ACTIVITY_BAR_WIDTH` (this module's TSDoc
 * explains why this module cannot import it directly). Kept in sync by
 * hand; `sidebarWidth.test.ts` asserts this literal equals the real
 * `shell.tsx` export, so a drift between the two fails a test rather than
 * silently under/over-reserving room for the activity bar.
 */
const ACTIVITY_BAR_WIDTH_FOR_CAP = 4;

/**
 * Clamp a desired `LayoutState.sidebarWidth` (Issue #105): always at least
 * {@link MIN_SIDEBAR_WIDTH}, and — when `terminalWidth` is given — never so
 * wide that fewer than {@link MIN_EDITOR_WIDTH} columns remain for
 * `EditorArea` past the activity bar (this module's TSDoc). Never throws: a
 * non-finite `desired` (`NaN`, `Infinity` — a hand-edited `state.json` or a
 * stray `NaN` from arithmetic upstream) degrades to
 * {@link MIN_SIDEBAR_WIDTH} rather than propagating; a fractional value is
 * truncated toward zero first, matching `viewport.ts`'s own
 * `Math.trunc`-based defensiveness.
 */
export function clampSidebarWidth(desired: number, terminalWidth?: number): number {
  const safeDesired = Number.isFinite(desired) ? Math.trunc(desired) : MIN_SIDEBAR_WIDTH;
  let width = Math.max(MIN_SIDEBAR_WIDTH, safeDesired);

  if (terminalWidth !== undefined && Number.isFinite(terminalWidth)) {
    const maxWidth = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.trunc(terminalWidth) - ACTIVITY_BAR_WIDTH_FOR_CAP - MIN_EDITOR_WIDTH,
    );
    width = Math.min(width, maxWidth);
  }

  return width;
}
