/**
 * Pure panel-height clamping (Issue #118; Req 6.4, design.md §8.2's
 * "persist layout state (sidebar width, visibility) across sessions" —
 * `panelHeight` is the same persisted field, just for the bottom `Panel`
 * instead of the sidebar): the one clamp every entry point that can change
 * `LayoutState.panelHeight` shares — a hand-edited `state.json`
 * (`layoutState.ts`'s `coerceLayoutState`), the live render site
 * (`shell.tsx`'s `Shell`), and the `workbench.panelHeight` setting
 * (`panelHeightConfigSync.ts`). Unlike `sidebarWidth.ts`'s equivalent, there
 * is (yet) no resize COMMAND or mouse-drag entry point for the panel — Issue
 * #118 is scoped to a one-directional config -> layout sync only, so those
 * two entry points from `sidebarWidth.ts`'s list simply don't exist here.
 * No UI dependencies: a plain, deterministic computation over numbers,
 * unit-testable without a renderer (matches `viewport.ts`'s
 * `computeEditorViewportHeight`, `sidebarWidth.ts`'s own shape).
 *
 * **Two independent floors/ceilings, not one** (translated vertically from
 * `sidebarWidth.ts`'s identical two-tier shape, sideways -> downward):
 *  - {@link MIN_PANEL_HEIGHT} is an ABSOLUTE floor, applied even when no
 *    terminal height is known at all (`coerceLayoutState` reads `state.json`
 *    before any live terminal exists) — comfortably above the Panel's own
 *    fixed chrome (its top border plus a rendered tab bar, `shell.tsx`'s
 *    `Panel`), so a corrupt/hand-edited `panelHeight: 0` (or a negative
 *    value) never renders a panel too short to show its own chrome, let
 *    alone a zero/negative one Yoga would otherwise have to make sense of on
 *    its own.
 *  - `terminalHeight`, when given, adds a CEILING on top of that floor: the
 *    panel must never grow so tall that the `EditorArea` it competes with
 *    for rows (the same flex column, `shell.tsx`'s `Shell`) is squeezed to
 *    nothing — {@link MIN_EDITOR_HEIGHT} rows are always reserved for it,
 *    past `EditorArea`'s own tab bar and `Shell`'s `StatusBar`.
 *    `coerceLayoutState` never has a terminal height to pass (Req 6.4's
 *    persistence runs before any renderer exists), so it only ever applies
 *    the floor; `shell.tsx`'s `Shell` is the one call site with a LIVE
 *    terminal height (`useLiveTerminalDimensions`), so it is the only place
 *    the ceiling is actually enforced. A terminal too short to honor both
 *    floors at once still gets {@link MIN_PANEL_HEIGHT} rather than
 *    something shorter (this function's own "still usable" policy, matching
 *    `computeEditorViewportHeight`'s identical "clamp to a minimum of 1
 *    rather than 0/negative" precedent).
 */

/**
 * The absolute floor for `LayoutState.panelHeight` (Issue #118) —
 * comfortably above the Panel's own fixed chrome: its top border
 * (`shell.tsx`'s `Panel`'s `PANEL_BORDER_HEIGHT`, 1 row) plus a rendered tab
 * bar (`shell.tsx`'s `TAB_BAR_HEIGHT`, 3 rows) totals 4 rows, so
 * {@link MIN_PANEL_HEIGHT} leaves at least one row of actual content beneath
 * that chrome — never a panel so short its own tab bar and border don't
 * even fit.
 */
export const MIN_PANEL_HEIGHT = 5;

/**
 * Rows always reserved for `EditorArea`'s text plane once a live
 * `terminalHeight` is known (this module's TSDoc) — an arbitrary but
 * deliberate "still usable" floor, not a measurement of any particular
 * editor feature's minimum. Named so the ceiling arithmetic below reads as
 * a reservation rather than a bare literal — `viewport.ts`'s
 * `computeEditorViewportHeight` enforces the equivalent floor for the text
 * plane itself via an anonymous `1`; this is `sidebarWidth.ts`'s
 * `MIN_EDITOR_WIDTH` counterpart for the vertical axis. Exported (rather
 * than kept private like {@link TAB_BAR_HEIGHT_FOR_CAP}/
 * {@link STATUS_BAR_HEIGHT_FOR_CAP} below) so `panelHeight.test.ts` can
 * assert the exact cap the terminal-aware branch computes, as a genuine
 * drift guard.
 */
export const MIN_EDITOR_HEIGHT = 1;

/**
 * Duplicated from `shell.tsx`'s `TAB_BAR_HEIGHT` (this module's TSDoc
 * explains why this module cannot import it directly — `shell.tsx` already
 * imports {@link clampPanelHeight} from this module, so the reverse edge
 * would be circular, matching `sidebarWidth.ts`'s `ACTIVITY_BAR_WIDTH_FOR_CAP`
 * precedent). Kept in sync by hand; `panelHeight.test.ts` asserts this
 * literal equals the real `shell.tsx` export, so a drift between the two
 * fails a test rather than silently under/over-reserving room for
 * `EditorArea`'s tab bar.
 */
const TAB_BAR_HEIGHT_FOR_CAP = 3;

/**
 * Duplicated from `shell.tsx`'s `STATUS_BAR_HEIGHT`, for the same
 * circular-import reason as {@link TAB_BAR_HEIGHT_FOR_CAP} above. Kept in
 * sync by hand; `panelHeight.test.ts` asserts this literal equals the real
 * `shell.tsx` export.
 */
const STATUS_BAR_HEIGHT_FOR_CAP = 1;

/**
 * Clamp a desired `LayoutState.panelHeight` (Issue #118): always at least
 * {@link MIN_PANEL_HEIGHT}, and — when `terminalHeight` is given — never so
 * tall that fewer than {@link MIN_EDITOR_HEIGHT} rows remain for
 * `EditorArea`'s text plane past its tab bar and `Shell`'s `StatusBar` (this
 * module's TSDoc). Never throws: a non-finite `desired` (`NaN`, `Infinity` —
 * a hand-edited `state.json` or a stray `NaN` from arithmetic upstream)
 * degrades to {@link MIN_PANEL_HEIGHT} rather than propagating; a fractional
 * value is truncated toward zero first, matching `sidebarWidth.ts`'s own
 * `Math.trunc`-based defensiveness.
 */
export function clampPanelHeight(desired: number, terminalHeight?: number): number {
  const safeDesired = Number.isFinite(desired) ? Math.trunc(desired) : MIN_PANEL_HEIGHT;
  let height = Math.max(MIN_PANEL_HEIGHT, safeDesired);

  if (terminalHeight !== undefined && Number.isFinite(terminalHeight)) {
    const maxHeight = Math.max(
      MIN_PANEL_HEIGHT,
      Math.trunc(terminalHeight) - TAB_BAR_HEIGHT_FOR_CAP - STATUS_BAR_HEIGHT_FOR_CAP - MIN_EDITOR_HEIGHT,
    );
    height = Math.min(height, maxHeight);
  }

  return height;
}
