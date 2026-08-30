/**
 * `TerminalView` — the React component `index.ts` registers into
 * `"panel.tab"` under `manifest.ts`'s `TERMINAL_VIEW_ID` (Issue #98 Phase
 * 4). A thin bridge over `tecode.ui.Terminal` (`@tecode/core`'s real
 * `TerminalGridView`, `create.ts`'s `uiNamespace`) plus `TerminalStore`
 * (`./store.ts`) — this component owns no VT-emulation/rendering logic of
 * its own, matching `explorer/ExplorerView.tsx`'s own "thin bridge over
 * `tecode.ui.Tree` + `ExplorerStore`" shape exactly.
 *
 * **`viewProps` (Issue #98 Phase 3/4)**: `props.height`/`props.width`
 * come from `@tecode/core`'s `shell.tsx`'s `Panel`, which passes them via
 * `RegisteredView`'s `viewProps` (`Panel`'s own TSDoc) — already net of
 * Panel's own chrome (border, tab bar). `undefined` (no live renderer
 * mounted) falls back to a conservative 80x24 default.
 */

import { useCallback, useEffect, useReducer, type ReactNode } from "react";
import type { ComponentType, Tecode } from "@tecode/api";
import type { TerminalStore } from "./store";

/** The loose shape `tecode.ui.Terminal` actually renders (this module's
 * TSDoc) — duck-typed against `@tecode/core`'s real `TerminalGridViewProps`,
 * never imported (the layering rule: `packages/builtin` may not import
 * `@tecode/core`). */
type TerminalComponentProps = Record<string, unknown> & {
  session?: unknown;
  cols?: number;
  rows?: number;
  autoFocus?: boolean;
  onFocusHandleChange?: (focus: () => void) => void;
};

/** Conservative fallback size (this module's TSDoc's "no live renderer"
 * case) — matches a traditional default terminal size, and is only ever
 * used until `TerminalGridView`'s own resize effect corrects it against
 * the real panel dimensions. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Props for {@link TerminalView}. */
export interface TerminalViewProps {
  store: TerminalStore;
  /** `tecode.ui.Terminal` itself (`ctx.api.ui.Terminal`) — injected rather
   * than imported, exactly like `ExplorerViewProps.Tree`'s own TSDoc
   * explains. */
  Terminal: Tecode["ui"]["Terminal"];
  /** Panel's own live content dimensions (`Panel`'s `viewProps`) —
   * `undefined` falls back to {@link DEFAULT_COLS}/{@link DEFAULT_ROWS}. */
  height?: number;
  width?: number;
}

/**
 * Renders `store`'s current session through `tecode.ui.Terminal`.
 * Subscribes to `store.onDidChange` and force-re-renders on every
 * mutation — the same "subscribe + force-render, with an unconditional
 * extra render right after subscribing to close the subscribe-after-render
 * race" shape `explorer/ExplorerView.tsx`'s own `ExplorerView` uses.
 *
 * **Spawns lazily, on mount**: `store.ensureSession()` is idempotent
 * (`store.ts`'s own TSDoc) — a caller (`index.ts`'s `terminal.focus`/
 * `terminal.new` handlers) may already have called it before this
 * component ever mounts (the common case: the command runs first, THEN
 * `workbench.action.showPanel` causes `Panel` to mount this component),
 * but calling it again here too means the view is self-sufficient even if
 * something else mounts it directly.
 */
export function TerminalView(props: TerminalViewProps): ReactNode {
  const { store } = props;
  const TerminalComponent = props.Terminal as unknown as (p: TerminalComponentProps) => ReactNode;

  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = store.onDidChange(() => forceRender());
    forceRender();
    return () => sub.dispose();
  }, [store]);

  useEffect(() => {
    store.ensureSession();
  }, [store]);

  // Stable identity (matches `@tecode/core`'s `TerminalGridView`'s own
  // `focusThisView`/`EditorArea`'s `focusEditorText` convention) — an
  // inline arrow here would make `TerminalGridView`'s own
  // `onFocusHandleChange` effect re-run (and re-register) on every
  // unrelated re-render of THIS component.
  const handleFocusHandleChange = useCallback(
    (focus: () => void) => {
      store.registerFocusHandle(focus);
    },
    [store],
  );
  // Clears the store's handle on unmount (Panel fully unmounts its hidden
  // tab's component — `@tecode/core`'s `shell.tsx`'s `Panel` TSDoc) so a
  // later `requestFocus()` call correctly falls back to "pending" instead
  // of invoking a handle whose underlying node has already detached.
  useEffect(() => {
    return () => store.registerFocusHandle(undefined);
  }, [store]);

  return (
    <TerminalComponent
      session={store.getSession()}
      cols={Math.max(1, props.width ?? DEFAULT_COLS)}
      rows={Math.max(1, props.height ?? DEFAULT_ROWS)}
      onFocusHandleChange={handleFocusHandleChange}
    />
  );
}

/**
 * Wrap {@link TerminalView} as a plain `tecode.ui.registerView`-compatible
 * {@link ComponentType} (`explorer/ExplorerView.tsx`'s
 * `createExplorerViewComponent` precedent) — closes over the STATIC props
 * (`store`/`Terminal`, built once in `index.ts`'s `activate(ctx)`) while
 * still forwarding whatever DYNAMIC `viewProps` the caller
 * (`RegisteredView`, `Panel`'s own `viewProps={{ height, width }}`) hands
 * it at render time — unlike `createExplorerViewComponent` (whose wrapper
 * takes no runtime props at all, since `Sidebar` passes none), this one
 * DOES read them, since the terminal panel genuinely needs its live
 * height/width to size the pty/emulator correctly (Issue #98's own
 * requirement).
 */
export function createTerminalViewComponent(
  props: Pick<TerminalViewProps, "store" | "Terminal">,
): ComponentType {
  return (runtimeProps: Record<string, unknown>) => (
    <TerminalView
      {...props}
      height={typeof runtimeProps["height"] === "number" ? runtimeProps["height"] : undefined}
      width={typeof runtimeProps["width"] === "number" ? runtimeProps["width"] : undefined}
    />
  );
}
