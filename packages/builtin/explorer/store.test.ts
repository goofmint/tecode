/**
 * Tests for {@link createExplorerStore} (Task 3.3, Req 11.2) — local fakes
 * only (no mock libraries, house convention): a fake `readdir` over an
 * in-memory tree (mirrors `../shared/walkFiles.test.ts`'s `FakeTree`), and
 * a real {@link createIgnoreChecker} with no `git`/`.gitignore`
 * dependencies (deterministic: only dotfile/always-ignored-dir hiding
 * applies, exactly like `ignore.test.ts`'s "no dependencies at all" suite).
 */

import { describe, expect, test } from "bun:test";
import type { DirEntry, MessageKind, Uri } from "@tecode/api";
import { createIgnoreChecker } from "../shared";
import { createExplorerStore, type ExplorerStore } from "./store";

const ROOT: Uri = "file:///workspace/";

type FakeTree = { [name: string]: FakeTree | null };

function createFakeReaddir(tree: FakeTree): (uri: Uri) => Promise<DirEntry[]> {
  return async (uri: Uri): Promise<DirEntry[]> => {
    const relative = uri.replace(ROOT, "").replace(/\/$/, "");
    const segments = relative.length > 0 ? relative.split("/").map(decodeURIComponent) : [];
    let node: FakeTree = tree;
    for (const segment of segments) {
      const next = node[segment];
      if (next === null || next === undefined) throw new Error(`ENOENT: ${uri}`);
      node = next;
    }
    return Object.entries(node).map(([name, value]) => ({
      name,
      type: value === null ? "file" : "directory",
    }));
  };
}

function createStore(
  tree: FakeTree,
  overrides: { rootUri?: Uri | undefined; showHidden?: boolean } = {},
): { store: ExplorerStore; messages: Array<{ message: string; kind?: MessageKind }> } {
  const messages: Array<{ message: string; kind?: MessageKind }> = [];
  const store = createExplorerStore("rootUri" in overrides ? overrides.rootUri : ROOT, {
    readdir: createFakeReaddir(tree),
    ignore: createIgnoreChecker(),
    showMessage: (message, kind) => messages.push({ message, kind }),
    showHidden: overrides.showHidden ?? false,
  });
  return { store, messages };
}

async function waitForChange(store: ExplorerStore): Promise<void> {
  await new Promise<void>((resolve) => {
    const sub = store.onDidChange(() => {
      sub.dispose();
      resolve();
    });
  });
}

describe("createExplorerStore (Task 3.3, Req 11.2)", () => {
  test("no rootUri degrades to a permanently empty tree, never throws", () => {
    const { store } = createStore({}, { rootUri: undefined });
    expect(store.getRootUri()).toBeUndefined();
    expect(store.getNodes()).toEqual([]);
    expect(store.resolveTargetDirectory()).toBeUndefined();
    expect(() => store.toggle("file:///x" as Uri, true)).not.toThrow();
    expect(() => store.setSelectedId("file:///x" as Uri)).not.toThrow();
  });

  test("getNodes() is empty before the root has ever loaded", () => {
    const { store } = createStore({ "a.ts": null });
    expect(store.getNodes()).toEqual([]);
  });

  test("reload(rootUri) populates top-level nodes, sorted, with directories marked hasChildren", async () => {
    const { store } = createStore({
      "b.ts": null,
      "a.ts": null,
      src: { "index.ts": null },
    });
    await store.reload(ROOT);
    expect(store.getNodes()).toEqual([
      { id: "file:///workspace/a.ts", label: "a.ts", hasChildren: false, children: undefined },
      { id: "file:///workspace/b.ts", label: "b.ts", hasChildren: false, children: undefined },
      { id: "file:///workspace/src", label: "src", hasChildren: true, children: undefined },
    ]);
  });

  test("dotfiles and node_modules are hidden by default (real IgnoreChecker, no git/.gitignore)", async () => {
    const { store } = createStore({
      ".git": { HEAD: null },
      node_modules: { pkg: null },
      "keep.ts": null,
    });
    await store.reload(ROOT);
    expect(store.getNodes().map((n) => n.label)).toEqual(["keep.ts"]);
  });

  test("a readdir failure reports via showMessage and leaves prior children untouched", async () => {
    let shouldFail = false;
    const tree: FakeTree = { "a.ts": null };
    const baseReaddir = createFakeReaddir(tree);
    const messages: Array<{ message: string; kind?: MessageKind }> = [];
    const store = createExplorerStore(ROOT, {
      readdir: async (uri) => {
        if (shouldFail) throw new Error("permission denied");
        return baseReaddir(uri);
      },
      ignore: createIgnoreChecker(),
      showMessage: (message, kind) => messages.push({ message, kind }),
      showHidden: false,
    });

    await store.reload(ROOT);
    expect(store.getNodes().map((n) => n.label)).toEqual(["a.ts"]);

    shouldFail = true;
    await store.reload(ROOT);

    expect(store.getNodes().map((n) => n.label)).toEqual(["a.ts"]); // unchanged
    expect(messages.some((m) => m.kind === "error" && /permission denied/.test(m.message))).toBe(true);
  });

  describe("toggle (expand/collapse)", () => {
    test("expanding a directory for the first time loads its children lazily", async () => {
      const { store } = createStore({ src: { "a.ts": null, "b.ts": null } });
      await store.reload(ROOT);
      expect(store.getExpandedIds()).toEqual([]);

      const changed = waitForChange(store);
      store.toggle("file:///workspace/src" as Uri, true);
      await changed;

      expect(store.getExpandedIds()).toEqual(["file:///workspace/src"]);
      expect(store.getNodes()[0]?.children?.map((c) => c.label)).toEqual(["a.ts", "b.ts"]);
    });

    test("collapsing keeps the cached children (a re-expand is instant, no reload)", async () => {
      const { store } = createStore({ src: { "a.ts": null } });
      await store.reload(ROOT);
      await new Promise<void>((resolve) => {
        const sub = store.onDidChange(() => {
          sub.dispose();
          resolve();
        });
        store.toggle("file:///workspace/src" as Uri, true);
      });

      store.toggle("file:///workspace/src" as Uri, false);
      expect(store.getExpandedIds()).toEqual([]);
      // Collapsed nodes render no children array (Tree hides them), but the
      // directory itself is still known/marked hasChildren.
      expect(store.getNodes()[0]).toEqual({
        id: "file:///workspace/src",
        label: "src",
        hasChildren: true,
        children: undefined,
      });

      store.toggle("file:///workspace/src" as Uri, true);
      // Instant — no intervening readdir needed, so no async wait here.
      expect(store.getNodes()[0]?.children?.map((c) => c.label)).toEqual(["a.ts"]);
    });

    test("toggling a uri that is not a known directory is a no-op", () => {
      const { store } = createStore({ "a.ts": null });
      expect(() => store.toggle("file:///workspace/a.ts" as Uri, true)).not.toThrow();
      expect(store.getExpandedIds()).toEqual([]);
    });
  });

  describe("selection", () => {
    test("setSelectedId/getSelectedId round-trip and notify on change", async () => {
      const { store } = createStore({ "a.ts": null });
      const changed = waitForChange(store);
      store.setSelectedId("file:///workspace/a.ts" as Uri);
      await changed;
      expect(store.getSelectedId()).toBe("file:///workspace/a.ts" as Uri);
    });

    test("setting the same id again does not fire onDidChange", async () => {
      const { store } = createStore({ "a.ts": null });
      store.setSelectedId("file:///workspace/a.ts" as Uri);
      let fired = false;
      const sub = store.onDidChange(() => (fired = true));
      store.setSelectedId("file:///workspace/a.ts" as Uri);
      sub.dispose();
      expect(fired).toBe(false);
    });
  });

  describe("resolveTargetDirectory", () => {
    test("no selection resolves to the root", async () => {
      const { store } = createStore({ "a.ts": null });
      await store.reload(ROOT);
      expect(store.resolveTargetDirectory()).toBe(ROOT);
    });

    test("a selected directory resolves to itself", async () => {
      const { store } = createStore({ src: { "a.ts": null } });
      await store.reload(ROOT);
      store.setSelectedId("file:///workspace/src" as Uri);
      expect(store.resolveTargetDirectory()).toBe("file:///workspace/src");
    });

    test("a selected file resolves to its parent directory", async () => {
      const { store } = createStore({ src: { "a.ts": null } });
      await store.reload(ROOT);
      await new Promise<void>((resolve) => {
        const sub = store.onDidChange(() => {
          sub.dispose();
          resolve();
        });
        store.toggle("file:///workspace/src" as Uri, true);
      });
      store.setSelectedId("file:///workspace/src/a.ts" as Uri);
      expect(store.resolveTargetDirectory()).toBe("file:///workspace/src");
    });
  });

  describe("getName / getParent / isDirectory", () => {
    test("report known children's metadata after a reload", async () => {
      const { store } = createStore({ src: { "a.ts": null } });
      await store.reload(ROOT);
      expect(store.getName("file:///workspace/src" as Uri)).toBe("src");
      expect(store.getParent("file:///workspace/src" as Uri)).toBe(ROOT);
      expect(store.isDirectory("file:///workspace/src" as Uri)).toBe(true);
      expect(store.isDirectory("file:///workspace/does-not-exist" as Uri)).toBe(false);
    });

    test("an unknown uri reports undefined name/parent", () => {
      const { store } = createStore({});
      expect(store.getName("file:///workspace/ghost" as Uri)).toBeUndefined();
      expect(store.getParent("file:///workspace/ghost" as Uri)).toBeUndefined();
    });
  });

  describe("showHidden", () => {
    test("setShowHidden(true) reloads every already-loaded directory and reveals hidden entries", async () => {
      const { store } = createStore({ ".env": null, "keep.ts": null });
      await store.reload(ROOT);
      expect(store.getNodes().map((n) => n.label)).toEqual(["keep.ts"]);

      const changed = waitForChange(store);
      store.setShowHidden(true);
      await changed;
      // The flag flips synchronously; the actual reveal lands once the
      // triggered reload resolves — poll briefly rather than assume one
      // `onDidChange` tick is enough (reload() fires its OWN change too).
      const start = Date.now();
      while (store.getNodes().length < 2 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(store.getNodes().map((n) => n.label).sort()).toEqual([".env", "keep.ts"]);
    });

    test("setShowHidden with the same value is a no-op", () => {
      const { store } = createStore({ "a.ts": null }, { showHidden: false });
      let fired = false;
      const sub = store.onDidChange(() => (fired = true));
      store.setShowHidden(false);
      sub.dispose();
      expect(fired).toBe(false);
    });

    test("getShowHidden reflects the constructed initial value", () => {
      const { store } = createStore({}, { showHidden: true });
      expect(store.getShowHidden()).toBe(true);
    });
  });
});
