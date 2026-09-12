/**
 * `SearchView` — the React component `index.ts` registers into
 * `"sidebar.view"` under `manifest.ts`'s `SEARCH_VIEW_ID` (Issue #147). A
 * thin render of a {@link SearchStore}: a mode row, a query `tecode.ui.
 * Input`, a one-line status, and the results as a `tecode.ui.Tree` with
 * `focusContextKey="searchFocus"`. Everything else (walking, matching,
 * cancellation) lives in the store, not here — the same split
 * `../explorer/ExplorerView.tsx` already draws.
 *
 * **Injected components, cast once at module scope**: `tecode.ui.Input`/
 * `Tree` arrive as `@tecode/api`'s bare `ComponentType` (`(props: Record<
 * string, unknown>) => unknown`), so — exactly as `ExplorerView.tsx` does
 * — each is cast once into a real JSX-callable type here and every render
 * below writes plain, ergonomic JSX. Duck-typed prop shapes, never
 * imported from `@tecode/core` (the ESLint layering rule).
 *
 * **A plain text mode row, NOT `tecode.ui.Tabs`**: Issue #147's plan
 * proposed `Tabs` for the Files/Text switch; the real component cannot fit
 * here. `@tecode/core`'s `components.tsx` renders `Tabs` over
 * `<tab-select>` with a FIXED `TAB_WIDTH = 20` per tab and a measured
 * height of 3 rows (`shell.tsx`'s `TAB_BAR_HEIGHT` TSDoc) — two tabs is 40
 * columns, well past the sidebar's 30-column default width
 * (`layoutState.ts`'s `sidebarWidth: 30`), so the second tab would be
 * clipped out of existence and three of the sidebar's rows would go to
 * chrome. Two `<text>` cells with their own `onMouseDown` cost one row,
 * fit any width, and are the same "plain clickable glyph row" idiom
 * `shell.tsx`'s own `ActivityBar` uses. The keyboard/palette counterpart is
 * `search.toggleMode` (`manifest.ts`).
 *
 * **Focus on mount**: the query input is focused imperatively from a mount
 * `useEffect` via `tecode.ui.Input`'s `inputRef` — the same ordering
 * `@tecode/core`'s `findWidget.tsx` documents at length (a declarative
 * `focused` prop is applied at instance-creation time, before refs
 * attach). The view only mounts when the user actually reveals the search
 * sidebar (`shell.tsx`'s `Sidebar` renders the ACTIVE view only, and
 * unmounts it when hidden), so this never steals focus from anything the
 * user is doing elsewhere.
 */

import { useEffect, useReducer, useRef, type ReactNode } from "react";
import type { ComponentType, Tecode } from "@tecode/api";
import type { SearchStore, SearchTarget } from "./store";

/** The loose shape `tecode.ui.Tree` actually renders — duck-typed against
 * `@tecode/core`'s real `TreeProps`, never imported (this module's TSDoc).
 * Mirrors `../explorer/ExplorerView.tsx`'s own local copy. */
type TreeComponentProps = Record<string, unknown> & {
  nodes?: unknown[];
  selectedId?: string;
  expandedIds?: string[];
  onSelect?: (id: string) => void;
  onToggle?: (id: string, expanding: boolean) => void;
  onActivate?: (id: string) => void;
  focusContextKey?: string;
  width?: number;
  height?: number;
};

/** The loose shape `tecode.ui.Input` actually renders — duck-typed against
 * `@tecode/core`'s real `InputProps` (this module's TSDoc). */
type InputComponentProps = Record<string, unknown> & {
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  inputRef?: (node: FocusableNodeLike | null) => void;
};

/** The one method this module calls on the node `tecode.ui.Input`'s
 * `inputRef` hands back (this module's TSDoc's "Focus on mount") —
 * structurally `@tecode/core`'s `FocusableNode`, declared locally rather
 * than imported. */
interface FocusableNodeLike {
  focus(): void;
}

/** `searchFocus` — `tecode.ui.Tree`'s own `focusContextKey` prop reports
 * into it, so a future `when: "searchFocus"` keybinding has something to
 * gate on (mirrors `../explorer/ExplorerView.tsx`'s
 * `EXPLORER_FOCUS_CONTEXT_KEY`). Exported so `index.ts`/tests reference the
 * same string. */
export const SEARCH_FOCUS_CONTEXT_KEY = "searchFocus";

/** Rows this view's own chrome occupies above the results tree — the mode
 * row, the query input, and the status line, one row each. Subtracted from
 * the sidebar's content height before it reaches `Tree`'s own `height`
 * prop, the same "always drawn, so always reserved" accounting
 * `@tecode/core`'s `shell.tsx` does with `SIDEBAR_TITLE_HEIGHT`. */
export const SEARCH_VIEW_CHROME_HEIGHT = 3;

/** Props for {@link SearchView}. */
export interface SearchViewProps {
  store: SearchStore;
  /** `ctx.api.ui.Input`/`ctx.api.ui.Tree` — injected rather than imported
   * so this component has zero compile-time dependency on `@tecode/core`
   * (every `packages/builtin/**` module's "only `@tecode/api`"
   * discipline). */
  Input: Tecode["ui"]["Input"];
  Tree: Tecode["ui"]["Tree"];
  /** Called when the user activates (Enter, or a mouse click on) a result
   * node — `index.ts` wires this to "open the file, then move the cursor
   * to the hit". */
  onActivateTarget: (target: SearchTarget) => void;
  /** The sidebar's real content width/height in terminal columns/rows,
   * handed down fresh on every render by `shell.tsx`'s `Sidebar` via
   * `RegisteredView`'s `viewProps` (Issue #104 Phase 3, Issue #125) —
   * `../explorer/ExplorerView.tsx`'s own `width`/`height` TSDoc covers the
   * mechanism in full. Both optional: omitted, `Tree` keeps its
   * unbounded/unvirtualized rendering, exactly as when this view is
   * mounted without a `Sidebar` above it (this file's own tests). */
  width?: number;
  height?: number;
}

/** The one-line status under the query box: what the view is doing, or how
 * much it found. Exported for this module's own tests. */
export function searchStatusText(store: SearchStore): string {
  if (!store.getRootUri()) return "No folder is open.";
  if (store.isLoading()) return "Searching...";
  if (store.getQuery().length === 0) {
    return store.getMode() === "files" ? "Type to search file names." : "Type a query, then press Enter.";
  }
  const count = store.getResultCount();
  if (count === 0) return "No results";
  const unit = store.getMode() === "files" ? "files" : "lines";
  return store.isTruncated() ? `${count} ${unit} (truncated)` : `${count} ${unit}`;
}

/** The Files/Text mode row (this module's TSDoc's "A plain text mode
 * row"). The active mode is bracketed — plain ASCII, no colour dependency,
 * readable on any theme. */
function modeLabel(label: string, active: boolean): string {
  return active ? `[${label}]` : ` ${label} `;
}

/**
 * Renders `store`'s current search state (Issue #147). Subscribes to
 * `store.onDidChange` and force-re-renders on every mutation — the same
 * "subscribe + force-render, with an unconditional extra render right
 * after subscribing to close the subscribe-after-render race" shape
 * `../explorer/ExplorerView.tsx` uses.
 */
export function SearchView(props: SearchViewProps): ReactNode {
  const { store } = props;
  const InputComponent = props.Input as unknown as (p: InputComponentProps) => ReactNode;
  const TreeComponent = props.Tree as unknown as (p: TreeComponentProps) => ReactNode;

  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = store.onDidChange(() => forceRender());
    forceRender();
    return () => sub.dispose();
  }, [store]);

  // This module's TSDoc's "Focus on mount" — captured here, focused in the
  // effect below, which runs strictly after every ref has attached.
  const queryNodeRef = useRef<FocusableNodeLike | null>(null);
  useEffect(() => {
    queryNodeRef.current?.focus();
  }, []);

  const mode = store.getMode();
  const nodes = store.getNodes();
  const treeHeight =
    props.height !== undefined ? Math.max(1, props.height - SEARCH_VIEW_CHROME_HEIGHT) : undefined;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        <text onMouseDown={() => store.setMode("files")}>{modeLabel("Files", mode === "files")}</text>
        <text onMouseDown={() => store.setMode("text")}>{modeLabel("Text", mode === "text")}</text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }}>
        <InputComponent
          value={store.getQuery()}
          placeholder={mode === "files" ? "Search file names" : "Search in files"}
          onChange={(value) => store.setQuery(value)}
          // Enter: the only way a full-text search starts (`store.ts`'s
          // `setQuery` TSDoc). `onChange` has already recorded the text, so
          // the submitted value needs no second read here.
          onSubmit={() => store.submit()}
          inputRef={(node) => {
            queryNodeRef.current = node;
          }}
        />
      </box>
      <text>{searchStatusText(store)}</text>
      {nodes.length > 0 ? (
        <TreeComponent
          nodes={nodes}
          selectedId={store.getSelectedId()}
          expandedIds={store.getExpandedIds()}
          focusContextKey={SEARCH_FOCUS_CONTEXT_KEY}
          width={props.width}
          height={treeHeight}
          onSelect={(id) => store.setSelectedId(id)}
          onToggle={(id, expanding) => store.toggle(id, expanding)}
          onActivate={(id) => {
            const target = store.resolveTarget(id);
            if (target) props.onActivateTarget(target);
          }}
        />
      ) : null}
    </box>
  );
}

/**
 * Wrap {@link SearchView} as a plain `tecode.ui.registerView`-compatible
 * {@link ComponentType} — `index.ts` stays a `.ts` file with no JSX of its
 * own. Closes over the dependencies fixed at `activate(ctx)` time
 * (`store`/`Input`/`Tree`/`onActivateTarget`) while re-reading the
 * render-time `width`/`height` the sidebar hands down through `viewProps`;
 * `../explorer/ExplorerView.tsx`'s `createExplorerViewComponent` TSDoc
 * explains that split in full.
 */
export function createSearchViewComponent(props: SearchViewProps): ComponentType {
  return (rawProps: Record<string, unknown>) => {
    const width = typeof rawProps["width"] === "number" ? rawProps["width"] : undefined;
    const height = typeof rawProps["height"] === "number" ? rawProps["height"] : undefined;
    return <SearchView {...props} width={width ?? props.width} height={height ?? props.height} />;
  };
}
