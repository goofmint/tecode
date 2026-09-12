/**
 * Tests for {@link SearchView} (Issue #147) — fake `Input`/`Tree`
 * components stand in for `@tecode/core`'s real ones (this built-in has no
 * compile-time or runtime dependency on them, `SearchView.tsx`'s TSDoc),
 * proving the PROP WIRING and the callback paths rather than the real
 * components' rendering (already covered by `@tecode/core`'s own
 * `components.snapshot.test.tsx`). Mirrors `../explorer/
 * ExplorerView.test.tsx`'s shape throughout.
 */

import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { DirEntry, Tecode, Uri } from "@tecode/api";
import { createIgnoreChecker } from "../shared";
import { createSearchStore, type SearchStore, type SearchTarget } from "./store";
import {
  createSearchViewComponent,
  SEARCH_FOCUS_CONTEXT_KEY,
  SEARCH_VIEW_CHROME_HEIGHT,
  SearchView,
  searchStatusText,
} from "./SearchView";

const ROOT: Uri = "file:///workspace/";

type FakeTree = { [name: string]: FakeTree | string };

function resolve(tree: FakeTree, uri: Uri): FakeTree | string {
  const relative = uri.replace(ROOT, "").replace(/\/$/, "");
  const segments = relative.length > 0 ? relative.split("/").map(decodeURIComponent) : [];
  let node: FakeTree | string = tree;
  for (const segment of segments) {
    if (typeof node === "string") throw new Error("ENOTDIR");
    const next: FakeTree | string | undefined = node[segment];
    if (next === undefined) throw new Error("ENOENT");
    node = next;
  }
  return node;
}

function createStore(tree: FakeTree, rootUri: Uri | undefined): SearchStore {
  return createSearchStore(rootUri, {
    async readdir(uri: Uri): Promise<DirEntry[]> {
      const node = resolve(tree, uri);
      if (typeof node === "string") throw new Error("ENOTDIR");
      return Object.entries(node).map(([name, value]) => ({
        name,
        type: typeof value === "string" ? "file" : "directory",
      }));
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      const node = resolve(tree, uri);
      if (typeof node !== "string") throw new Error("EISDIR");
      return new TextEncoder().encode(node);
    },
    ignore: createIgnoreChecker(),
    showMessage: () => {},
    caseSensitive: false,
    maxResults: 100,
  });
}

/** A minimal fake `tecode.ui.Tree` — captures the last props it was
 * rendered with and renders each node's label as text (mirrors
 * `../explorer/ExplorerView.test.tsx`'s own `createFakeTree`). */
function createFakeTree(): { Tree: Tecode["ui"]["Tree"]; lastProps: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const Tree = ((rawProps: Record<string, unknown>) => {
    captured = rawProps;
    const nodes = (rawProps["nodes"] as Array<{ id: string; label: string }> | undefined) ?? [];
    return (
      <box>
        {nodes.map((n) => (
          <text key={n.id}>{n.label}</text>
        ))}
      </box>
    ) as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Tree"];
  return { Tree, lastProps: () => captured };
}

/** A minimal fake `tecode.ui.Input` — captures its props and renders its
 * current value, enough to prove the query wiring without OpenTUI's real
 * `<input>`. */
function createFakeInput(): {
  Input: Tecode["ui"]["Input"];
  lastProps: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const Input = ((rawProps: Record<string, unknown>) => {
    captured = rawProps;
    const value = typeof rawProps["value"] === "string" ? rawProps["value"] : "";
    return (<text>{value}</text>) as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Input"];
  return { Input, lastProps: () => captured };
}

function callProp<T extends unknown[]>(
  props: Record<string, unknown> | undefined,
  name: string,
  ...args: T
): void {
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`expected a ${name} callback`);
  (handler as (...a: T) => void)(...args);
}

describe("SearchView (Issue #147)", () => {
  test("shows the mode row, with the active mode bracketed", async () => {
    const store = createStore({}, ROOT);
    const { Tree } = createFakeTree();
    const { Input } = createFakeInput();
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={() => {}} />,
      { width: 40, height: 8 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("[Files]");
    expect(frame).toContain("Text");
  });

  test("the mode row follows the store's current mode", async () => {
    const store = createStore({}, ROOT);
    const { Tree } = createFakeTree();
    const { Input } = createFakeInput();
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={() => {}} />,
      { width: 40, height: 8 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("[Files]");

    await act(async () => {
      store.setMode("text");
    });
    await renderOnce();
    expect(captureCharFrame()).toContain("[Text]");
  });

  test("typing into the query Input drives the store, and Enter submits", async () => {
    const store = createStore({ "alpha.ts": "a hit here" }, ROOT);
    const { Tree } = createFakeTree();
    const { Input, lastProps } = createFakeInput();
    const { renderOnce } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={() => {}} />,
      { width: 40, height: 8 },
    );
    await renderOnce();

    await act(async () => {
      callProp(lastProps(), "onChange", "alpha");
    });
    expect(store.getQuery()).toBe("alpha");

    // Full-text mode only searches on Enter (`store.ts`'s `setQuery`
    // TSDoc), so the submit callback is what makes results appear.
    await act(async () => {
      store.setMode("text");
      callProp(lastProps(), "onChange", "hit");
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(store.getResultCount()).toBe(0);

    await act(async () => {
      callProp(lastProps(), "onSubmit", "hit");
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(store.getResultCount()).toBe(1);
  });

  test("renders results through Tree and re-renders on store changes", async () => {
    const store = createStore({ "alpha.ts": "" }, ROOT);
    const { Tree, lastProps } = createFakeTree();
    const { Input } = createFakeInput();
    const { renderOnce, captureCharFrame } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={() => {}} />,
      { width: 40, height: 8 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("Type to search");

    await act(async () => {
      store.setQuery("alpha");
      await new Promise((r) => setTimeout(r, 20));
    });
    await renderOnce();

    expect(captureCharFrame()).toContain("alpha.ts");
    expect(lastProps()?.["focusContextKey"]).toBe(SEARCH_FOCUS_CONTEXT_KEY);
    expect(lastProps()?.["selectedId"]).toBeUndefined();
  });

  test("activating a result node calls onActivateTarget with the resolved target", async () => {
    const store = createStore({ "a.ts": "needle" }, ROOT);
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await new Promise((r) => setTimeout(r, 20));

    const activated: SearchTarget[] = [];
    const { Tree, lastProps } = createFakeTree();
    const { Input } = createFakeInput();
    const { renderOnce } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={(t) => activated.push(t)} />,
      { width: 40, height: 8 },
    );
    await renderOnce();

    const hitId = store.getNodes()[0]?.children?.[0]?.id ?? "";
    await act(async () => {
      callProp(lastProps(), "onActivate", hitId);
    });
    expect(activated).toEqual([{ uri: "file:///workspace/a.ts", position: { line: 0, character: 0 } }]);
  });

  test("Tree's onSelect/onToggle are wired to the store", async () => {
    const store = createStore({ "a.ts": "needle" }, ROOT);
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await new Promise((r) => setTimeout(r, 20));

    const { Tree, lastProps } = createFakeTree();
    const { Input } = createFakeInput();
    const { renderOnce } = await testRender(
      <SearchView store={store} Input={Input} Tree={Tree} onActivateTarget={() => {}} />,
      { width: 40, height: 8 },
    );
    await renderOnce();

    await act(async () => {
      callProp(lastProps(), "onSelect", "file:///workspace/a.ts");
      callProp(lastProps(), "onToggle", "file:///workspace/a.ts", false);
    });
    expect(store.getSelectedId()).toBe("file:///workspace/a.ts");
    expect(store.getExpandedIds()).toEqual([]);
  });

  test("the render-time width/height reach Tree, with this view's own chrome subtracted", async () => {
    const store = createStore({ "a.ts": "" }, ROOT);
    store.setQuery("a");
    await new Promise((r) => setTimeout(r, 20));

    const { Tree, lastProps } = createFakeTree();
    const { Input } = createFakeInput();
    const component = createSearchViewComponent({
      store,
      Input,
      Tree,
      onActivateTarget: () => {},
    }) as unknown as (props: Record<string, unknown>) => ReactNode;
    const { renderOnce } = await testRender(<>{component({ width: 29, height: 20 })}</>, {
      width: 40,
      height: 24,
    });
    await renderOnce();

    expect(lastProps()?.["width"]).toBe(29);
    expect(lastProps()?.["height"]).toBe(20 - SEARCH_VIEW_CHROME_HEIGHT);
  });
});

describe("searchStatusText (Issue #147)", () => {
  test("reports no folder, the empty-query hint, and result counts", async () => {
    const empty = createStore({}, undefined);
    expect(searchStatusText(empty)).toBe("No folder is open.");

    const store = createStore({ "a.ts": "" }, ROOT);
    expect(searchStatusText(store)).toBe("Type to search file names.");

    store.setMode("text");
    expect(searchStatusText(store)).toBe("Type a query, then press Enter.");

    store.setMode("files");
    store.setQuery("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(searchStatusText(store)).toBe("1 files");

    store.setQuery("zzz");
    await new Promise((r) => setTimeout(r, 20));
    expect(searchStatusText(store)).toBe("No results");
  });
});
