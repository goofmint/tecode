/**
 * `ExplorerView` — the React component `index.ts` registers into
 * `"sidebar.view"` under `manifest.ts`'s `EXPLORER_VIEW_ID` (Task 3.3, Req
 * 11.2; design.md §13's `explorer` design). A thin render of an
 * {@link ExplorerStore} over `tecode.ui.Tree`, with
 * `focusContextKey="explorerFocus"` (Req 4.6, 11.2) — everything else
 * (loading, mutation, `fs.watch`) lives in the store/`index.ts`, not here.
 *
 * **Bridging `tecode.ui.Tree`'s `ComponentType` into a real JSX element**:
 * `@tecode/api`'s `UiNamespace.Tree` is typed as the bare, React-free
 * `ComponentType = (props: Record<string, unknown>) => unknown`
 * (`namespaces.ts`'s TSDoc) — this built-in has no dependency on
 * `@tecode/core`'s REAL `Tree` implementation, only on the interface. The
 * exact same cast `@tecode/core`'s OWN `components.tsx`'s
 * `RegisteredView` uses (`const Component = props.component as unknown as
 * (p: Record<string, unknown>) => ReactNode`) is applied once here, at
 * module scope, so every render just writes plain, ergonomic JSX
 * (`<TreeComponent nodes={...} .../>`) rather than re-casting inline.
 *
 * **Why THIS built-in needs `react`/`@opentui/react` as real
 * dependencies** (checked against `eslint.config.mjs`: only importing
 * `@tecode/core` is blocked, not `react`/`@opentui/react` themselves) —
 * `packages/builtin`'s `package.json`/`tsconfig.json` were extended for
 * this task (Task 3.3's plan: "builtin's package.json may need react")
 * since no other built-in has registered a `tecode.ui` view before this
 * one; the root `tsconfig.json`'s `jsx: "react-jsx"` /
 * `jsxImportSource: "@opentui/react"` already applies repo-wide, so this
 * package just needed `**\/*.tsx` added to its own `tsconfig.json`'s
 * `include` to be picked up at all.
 */

import { useEffect, useReducer, type ReactNode } from "react";
import type { ComponentType, Tecode } from "@tecode/api";
import type { ExplorerStore } from "./store";

/** The loose shape `tecode.ui.Tree` actually renders (this module's
 * TSDoc) — duck-typed against `@tecode/core`'s real `TreeProps`, never
 * imported (the layering rule). */
type TreeComponentProps = Record<string, unknown> & {
  nodes?: unknown[];
  selectedId?: string;
  expandedIds?: string[];
  onSelect?: (id: string) => void;
  onToggle?: (id: string, expanding: boolean) => void;
  onActivate?: (id: string) => void;
  focusContextKey?: string;
};

/** Props for {@link ExplorerView}. */
export interface ExplorerViewProps {
  store: ExplorerStore;
  /** `tecode.ui.Tree` itself (`ctx.api.ui.Tree`) — injected rather than
   * imported so this component has zero compile-time dependency on
   * `@tecode/core` (matches every other `packages/builtin/**` module's
   * "only `@tecode/api`" discipline). */
  Tree: Tecode["ui"]["Tree"];
  /** Called when the user activates (Enter, or a mouse click on) a FILE
   * node — `index.ts` wires this to `workbench.action.files.openUri`. Not
   * called for a directory node (Tree's own `return`/click toggles its
   * expansion instead — see `components.tsx`'s `onActivate` TSDoc). */
  onOpenFile: (uri: string) => void;
}

/** `explorerFocus` (Req 4.6, 11.2) — `tecode.ui.Tree`'s own
 * `focusContextKey` prop reports into it via `@tecode/core`'s
 * `useFocusTracking` (`components.tsx`), which is what a `when:
 * "explorerFocus"` keybinding elsewhere would gate on. Exported so
 * `index.ts`/tests reference the same string. */
export const EXPLORER_FOCUS_CONTEXT_KEY = "explorerFocus";

/**
 * Renders `store`'s current tree state (Task 3.3). Subscribes to `store.
 * onDidChange` and force-re-renders on every mutation — the same
 * "subscribe + force-render, with an unconditional extra render right
 * after subscribing to close the subscribe-after-render race" shape
 * `@tecode/core`'s `ui/modalOverlay.tsx`'s `ModalOverlay` already uses for
 * its own external store (that module's TSDoc explains the race in full).
 */
export function ExplorerView(props: ExplorerViewProps): ReactNode {
  const { store } = props;
  const TreeComponent = props.Tree as unknown as (p: TreeComponentProps) => ReactNode;

  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = store.onDidChange(() => forceRender());
    forceRender();
    return () => sub.dispose();
  }, [store]);

  const rootUri = store.getRootUri();
  if (!rootUri) {
    return <text>{"No folder is open."}</text>;
  }

  const nodes = store.getNodes();
  if (nodes.length === 0) {
    return <text>{"(empty)"}</text>;
  }

  return (
    <TreeComponent
      nodes={nodes}
      selectedId={store.getSelectedId()}
      expandedIds={store.getExpandedIds()}
      focusContextKey={EXPLORER_FOCUS_CONTEXT_KEY}
      onSelect={(id) => store.setSelectedId(id)}
      onToggle={(id, expanding) => store.toggle(id, expanding)}
      onActivate={(id) => {
        if (store.isDirectory(id)) return; // Tree's own Enter/click already toggled it.
        props.onOpenFile(id);
      }}
    />
  );
}

/**
 * Wrap {@link ExplorerView} as a plain `tecode.ui.registerView`-compatible
 * {@link ComponentType} (`(props: Record<string, unknown>) => unknown`,
 * `@tecode/api`'s `namespaces.ts`) — `index.ts` stays a `.ts` file with no
 * JSX of its own; this is the one place that bridges `ExplorerViewProps`
 * (a real, narrow prop type) into the loose shape `registerView` expects,
 * closing over `props` (built once, in `index.ts`'s `activate(ctx)`) so
 * every render always sees the SAME `store`/`Tree`/`onOpenFile` regardless
 * of whatever the caller (`shell.tsx`'s `Sidebar`, which passes none for a
 * `sidebar.view`) hands it as its own component props.
 */
export function createExplorerViewComponent(props: ExplorerViewProps): ComponentType {
  return () => <ExplorerView {...props} />;
}
