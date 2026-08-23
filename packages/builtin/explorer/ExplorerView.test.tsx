/**
 * Tests for {@link ExplorerView} (Task 3.3, Req 11.2) — a fake `Tree`
 * component stands in for `@tecode/core`'s real one (this built-in has no
 * compile-time or runtime dependency on it, `ExplorerView.tsx`'s TSDoc),
 * proving the PROP WIRING (`nodes`/`selectedId`/`expandedIds`/
 * `focusContextKey`/`onSelect`/`onToggle`/`onActivate`) rather than
 * `tecode.ui.Tree`'s own rendering (already covered by `@tecode/core`'s
 * `components.test.tsx`).
 */

import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { Tecode, Uri } from "@tecode/api";
import { createIgnoreChecker } from "../shared";
import { createExplorerStore } from "./store";
import { EXPLORER_FOCUS_CONTEXT_KEY, ExplorerView } from "./ExplorerView";

/** A minimal fake `tecode.ui.Tree` — captures the last props it was
 * rendered with (for assertion) and renders each node's label as text,
 * enough to prove `ExplorerView` passes the right data through without
 * reimplementing the real `Tree`'s rendering/keyboard logic. */
function createFakeTree(): { Tree: Tecode["ui"]["Tree"]; lastProps: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const Tree = ((rawProps: Record<string, unknown>) => {
    captured = rawProps;
    const nodes = (rawProps["nodes"] as Array<{ id: string; label: string }> | undefined) ?? [];
    return <box>{nodes.map((n) => <text key={n.id}>{n.label}</text>)}</box> as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Tree"];
  return { Tree, lastProps: () => captured };
}

type FakeTree = { [name: string]: FakeTree | null };
const ROOT: Uri = "file:///workspace/";

function createStore(tree: FakeTree, rootUri: Uri | undefined) {
  return createExplorerStore(rootUri, {
    readdir: async (uri) => {
      const relative = uri.replace(ROOT, "").replace(/\/$/, "");
      const segments = relative.length > 0 ? relative.split("/") : [];
      let node: FakeTree = tree;
      for (const segment of segments) {
        const next = node[decodeURIComponent(segment)];
        if (next === null || next === undefined) throw new Error("ENOENT");
        node = next;
      }
      return Object.entries(node).map(([name, value]) => ({
        name,
        type: (value === null ? "file" : "directory") as "file" | "directory",
      }));
    },
    ignore: createIgnoreChecker(),
    showMessage: () => {},
    showHidden: false,
  });
}

describe("ExplorerView (Task 3.3, Req 11.2)", () => {
  test("shows 'No folder is open.' when the store has no rootUri", async () => {
    const store = createStore({}, undefined);
    const { Tree } = createFakeTree();
    const { renderOnce, captureCharFrame } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("No folder is open.");
  });

  test("shows '(empty)' before the root has loaded", async () => {
    const store = createStore({}, ROOT);
    const { Tree } = createFakeTree();
    const { renderOnce, captureCharFrame } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("(empty)");
  });

  test("renders the store's nodes once loaded, and re-renders on store changes", async () => {
    const store = createStore({ "a.ts": null }, ROOT);
    const { Tree } = createFakeTree();
    const { renderOnce, captureCharFrame } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("(empty)");

    await act(async () => {
      await store.reload(ROOT);
    });
    await renderOnce();
    expect(captureCharFrame()).toContain("a.ts");
  });

  test("passes selectedId, expandedIds, and focusContextKey through to Tree", async () => {
    const store = createStore({ src: { "a.ts": null } }, ROOT);
    await store.reload(ROOT);
    store.setSelectedId("file:///workspace/src" as Uri);
    store.toggle("file:///workspace/src" as Uri, true);
    await new Promise((r) => setTimeout(r, 10)); // let the toggle's own reload settle

    const { Tree, lastProps } = createFakeTree();
    const { renderOnce } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();

    expect(lastProps()?.["selectedId"]).toBe("file:///workspace/src");
    expect(lastProps()?.["expandedIds"]).toEqual(["file:///workspace/src"]);
    expect(lastProps()?.["focusContextKey"]).toBe(EXPLORER_FOCUS_CONTEXT_KEY);
  });

  test("onSelect from Tree updates the store's selection", async () => {
    const store = createStore({ "a.ts": null }, ROOT);
    await store.reload(ROOT);
    const { Tree, lastProps } = createFakeTree();
    const { renderOnce } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();

    act(() => {
      (lastProps()?.["onSelect"] as (id: string) => void)("file:///workspace/a.ts");
    });
    expect(store.getSelectedId()).toBe("file:///workspace/a.ts");
  });

  test("onToggle from Tree toggles the store's expansion", async () => {
    const store = createStore({ src: { "a.ts": null } }, ROOT);
    await store.reload(ROOT);
    const { Tree, lastProps } = createFakeTree();
    const { renderOnce } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={() => {}} />,
      { width: 30, height: 5 },
    );
    await renderOnce();

    act(() => {
      (lastProps()?.["onToggle"] as (id: string, expanding: boolean) => void)("file:///workspace/src", true);
    });
    expect(store.getExpandedIds()).toEqual(["file:///workspace/src"]);
  });

  test("onActivate on a FILE node calls onOpenFile with its uri", async () => {
    const store = createStore({ "a.ts": null }, ROOT);
    await store.reload(ROOT);
    const opened: string[] = [];
    const { Tree, lastProps } = createFakeTree();
    const { renderOnce } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={(uri) => opened.push(uri)} />,
      { width: 30, height: 5 },
    );
    await renderOnce();

    act(() => {
      (lastProps()?.["onActivate"] as (id: string) => void)("file:///workspace/a.ts");
    });
    expect(opened).toEqual(["file:///workspace/a.ts"]);
  });

  test("onActivate on a DIRECTORY node does NOT call onOpenFile", async () => {
    const store = createStore({ src: { "a.ts": null } }, ROOT);
    await store.reload(ROOT);
    const opened: string[] = [];
    const { Tree, lastProps } = createFakeTree();
    const { renderOnce } = await testRender(
      <ExplorerView store={store} Tree={Tree} onOpenFile={(uri) => opened.push(uri)} />,
      { width: 30, height: 5 },
    );
    await renderOnce();

    act(() => {
      (lastProps()?.["onActivate"] as (id: string) => void)("file:///workspace/src");
    });
    expect(opened).toEqual([]);
  });
});
