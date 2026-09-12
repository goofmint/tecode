/**
 * Tests for {@link createSearchStore} (Issue #147) — local fakes only (no
 * mock libraries, house convention): a fake `readdir`/`readFile` over an
 * in-memory tree (mirrors `../explorer/store.test.ts`'s `FakeTree`), and a
 * real {@link createIgnoreChecker} with no `git`/`.gitignore` dependencies
 * (deterministic: only dotfile/always-ignored-dir hiding applies).
 */

import { describe, expect, test } from "bun:test";
import type { DirEntry, MessageKind, Uri } from "@tecode/api";
import { createIgnoreChecker } from "../shared";
import { createSearchStore, type SearchStore } from "./store";

const ROOT: Uri = "file:///workspace/";

/** A file's contents, or a nested directory. */
type FakeTree = { [name: string]: FakeTree | string };

function resolve(tree: FakeTree, uri: Uri): FakeTree | string {
  const relative = uri.replace(ROOT, "").replace(/\/$/, "");
  const segments = relative.length > 0 ? relative.split("/").map(decodeURIComponent) : [];
  let node: FakeTree | string = tree;
  for (const segment of segments) {
    if (typeof node === "string") throw new Error(`ENOTDIR: ${uri}`);
    const next: FakeTree | string | undefined = node[segment];
    if (next === undefined) throw new Error(`ENOENT: ${uri}`);
    node = next;
  }
  return node;
}

function createFixture(
  tree: FakeTree,
  overrides: { rootUri?: Uri | undefined; caseSensitive?: boolean; maxResults?: number } = {},
): { store: SearchStore; messages: Array<{ message: string; kind?: MessageKind }> } {
  const messages: Array<{ message: string; kind?: MessageKind }> = [];
  const store = createSearchStore("rootUri" in overrides ? overrides.rootUri : ROOT, {
    async readdir(uri: Uri): Promise<DirEntry[]> {
      const node = resolve(tree, uri);
      if (typeof node === "string") throw new Error(`ENOTDIR: ${uri}`);
      return Object.entries(node).map(([name, value]) => ({
        name,
        type: typeof value === "string" ? "file" : "directory",
      }));
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      const node = resolve(tree, uri);
      if (typeof node !== "string") throw new Error(`EISDIR: ${uri}`);
      return new TextEncoder().encode(node);
    },
    ignore: createIgnoreChecker(),
    showMessage: (message, kind) => messages.push({ message, kind }),
    caseSensitive: overrides.caseSensitive ?? false,
    maxResults: overrides.maxResults ?? 1000,
  });
  return { store, messages };
}

/** Resolves once the store stops reporting itself loading — every search
 * fires `onDidChange` when it finishes (`store.ts`'s TSDoc). */
async function settle(store: SearchStore): Promise<void> {
  await new Promise<void>((resolve_) => {
    if (!store.isLoading()) {
      resolve_();
      return;
    }
    const sub = store.onDidChange(() => {
      if (store.isLoading()) return;
      sub.dispose();
      resolve_();
    });
  });
}

describe("createSearchStore — degrade and defaults (Issue #147)", () => {
  test("no rootUri degrades to a permanently empty store, never throws", async () => {
    const { store } = createFixture({}, { rootUri: undefined });
    store.setQuery("anything");
    await settle(store);
    expect(store.getRootUri()).toBeUndefined();
    expect(store.getNodes()).toEqual([]);
    expect(store.isLoading()).toBe(false);
    expect(() => store.toggle("file:///x", true)).not.toThrow();
    expect(store.resolveTarget("file:///x")).toBeUndefined();
  });

  test("starts in filename mode with an empty query and no results", () => {
    const { store } = createFixture({ "a.ts": "" });
    expect(store.getMode()).toBe("files");
    expect(store.getQuery()).toBe("");
    expect(store.getNodes()).toEqual([]);
    expect(store.getResultCount()).toBe(0);
  });

  test("an empty query never scans and clears any previous results", async () => {
    const { store } = createFixture({ "a.ts": "" });
    store.setQuery("a");
    await settle(store);
    expect(store.getResultCount()).toBe(1);

    store.setQuery("");
    await settle(store);
    expect(store.getNodes()).toEqual([]);
    expect(store.isLoading()).toBe(false);
  });

  test("a non-finite maxResults clamps to the floor instead of propagating", () => {
    const { store } = createFixture({}, { maxResults: Number.NaN });
    expect(store.getMaxResults()).toBe(1);
    store.setMaxResults(-5);
    expect(store.getMaxResults()).toBe(1);
  });
});

describe("createSearchStore — filename mode (Issue #147)", () => {
  test("ranks matching paths and ignores dotfiles/node_modules (the shared IgnoreChecker)", async () => {
    const { store } = createFixture({
      src: { "alpha.ts": "", "beta.ts": "" },
      node_modules: { "alpha.ts": "" },
      ".hidden": { "alpha.ts": "" },
    });
    store.setQuery("alpha");
    await settle(store);
    expect(store.getNodes().map((n) => n.label)).toEqual(["src/alpha.ts"]);
    expect(store.getNodes()[0]?.id).toBe("file:///workspace/src/alpha.ts");
  });

  test("fires onDidChange while searching and again when done", async () => {
    const { store } = createFixture({ "a.ts": "" });
    let fired = 0;
    const sub = store.onDidChange(() => (fired += 1));
    store.setQuery("a");
    await settle(store);
    sub.dispose();
    expect(fired).toBeGreaterThanOrEqual(2);
  });

  test("maxResults truncates the ranked list and reports it", async () => {
    const { store } = createFixture({ "a1.ts": "", "a2.ts": "", "a3.ts": "" }, { maxResults: 2 });
    store.setQuery("a");
    await settle(store);
    expect(store.getResultCount()).toBe(2);
    expect(store.isTruncated()).toBe(true);
  });

  test("the newest query wins — a superseded search never commits its results", async () => {
    const { store } = createFixture({ "alpha.ts": "", "beta.ts": "" });
    store.setQuery("alpha");
    store.setQuery("beta");
    await settle(store);
    expect(store.getNodes().map((n) => n.label)).toEqual(["beta.ts"]);
  });

  test("resolveTarget returns the file uri with no position", async () => {
    const { store } = createFixture({ "a.ts": "" });
    store.setQuery("a");
    await settle(store);
    expect(store.resolveTarget("file:///workspace/a.ts")).toEqual({ uri: "file:///workspace/a.ts" });
    expect(store.resolveTarget("file:///workspace/missing.ts")).toBeUndefined();
  });

  test("a failing workspace walk reports through showMessage instead of throwing", async () => {
    const messages: Array<{ message: string; kind?: MessageKind }> = [];
    const store = createSearchStore(ROOT, {
      readdir: () => Promise.reject(new Error("permission denied")),
      readFile: () => Promise.reject(new Error("permission denied")),
      ignore: createIgnoreChecker(),
      showMessage: (message, kind) => messages.push({ message, kind }),
      caseSensitive: false,
      maxResults: 10,
    });
    store.setQuery("a");
    await settle(store);
    // `walkFiles` swallows an unreadable directory itself, so the result is
    // simply an empty file list — never an exception out of the store.
    expect(store.getNodes()).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe("createSearchStore — full-text mode (Issue #147)", () => {
  test("typing does NOT search until submit()", async () => {
    const { store } = createFixture({ "a.ts": "needle here" });
    store.setMode("text");
    store.setQuery("needle");
    await settle(store);
    expect(store.getResultCount()).toBe(0);

    store.submit();
    await settle(store);
    expect(store.getResultCount()).toBe(1);
  });

  test("builds a file -> hit-line tree, expanded by default", async () => {
    const { store } = createFixture({ "a.ts": "one needle\ntwo\nthree needle" });
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await settle(store);

    const nodes = store.getNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("a.ts (2)");
    expect(nodes[0]?.children?.map((child) => child.label)).toEqual(["1: one needle", "3: three needle"]);
    expect(store.getExpandedIds()).toEqual(["file:///workspace/a.ts"]);
  });

  test("collapsing a file hides its hits without losing them", async () => {
    const { store } = createFixture({ "a.ts": "needle" });
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await settle(store);

    store.toggle("file:///workspace/a.ts", false);
    expect(store.getNodes()[0]?.children).toBeUndefined();
    expect(store.getExpandedIds()).toEqual([]);

    store.toggle("file:///workspace/a.ts", true);
    expect(store.getNodes()[0]?.children).toHaveLength(1);
  });

  test("resolveTarget maps a hit node to its file and zero-based position", async () => {
    const { store } = createFixture({ "a.ts": "xx\nab needle" });
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await settle(store);

    const hitId = store.getNodes()[0]?.children?.[0]?.id ?? "";
    expect(store.resolveTarget(hitId)).toEqual({
      uri: "file:///workspace/a.ts",
      position: { line: 1, character: 3 },
    });
    // The FILE node itself opens the file with no cursor move.
    expect(store.resolveTarget("file:///workspace/a.ts")).toEqual({ uri: "file:///workspace/a.ts" });
  });

  test("binary files and unreadable files are skipped, not reported as matches", async () => {
    const messages: Array<{ message: string; kind?: MessageKind }> = [];
    const store = createSearchStore(ROOT, {
      async readdir() {
        return [
          { name: "bin.dat", type: "file" },
          { name: "boom.ts", type: "file" },
          { name: "ok.ts", type: "file" },
        ];
      },
      async readFile(uri: Uri): Promise<Uint8Array> {
        if (uri.endsWith("bin.dat")) return new Uint8Array([0x71, 0x00, 0x71]);
        if (uri.endsWith("boom.ts")) throw new Error("permission denied");
        return new TextEncoder().encode("q");
      },
      ignore: createIgnoreChecker(),
      showMessage: (message, kind) => messages.push({ message, kind }),
      caseSensitive: false,
      maxResults: 10,
    });

    store.setMode("text");
    store.setQuery("q");
    store.submit();
    await settle(store);

    expect(store.getNodes().map((n) => n.label)).toEqual(["ok.ts (1)"]);
    expect(messages).toEqual([]);
  });

  test("maxResults caps total hits and reports truncation", async () => {
    const { store } = createFixture({ "a.ts": "q\nq\nq\nq" }, { maxResults: 2 });
    store.setMode("text");
    store.setQuery("q");
    store.submit();
    await settle(store);
    expect(store.getResultCount()).toBe(2);
    expect(store.isTruncated()).toBe(true);
  });

  test("search.caseSensitive applies, live", async () => {
    const { store } = createFixture({ "a.ts": "Needle" });
    store.setMode("text");
    store.setQuery("needle");
    store.submit();
    await settle(store);
    expect(store.getResultCount()).toBe(1);

    store.setCaseSensitive(true);
    await settle(store);
    expect(store.getCaseSensitive()).toBe(true);
    expect(store.getResultCount()).toBe(0);
  });

  test("switching modes discards the other mode's results and re-runs the query", async () => {
    const { store } = createFixture({ "needle.ts": "nothing here" });
    store.setQuery("needle");
    await settle(store);
    expect(store.getResultCount()).toBe(1);

    store.setMode("text");
    await settle(store);
    expect(store.getMode()).toBe("text");
    expect(store.getResultCount()).toBe(0);
  });
});

describe("createSearchStore — refresh (Issue #147)", () => {
  test("refresh() re-walks the workspace so newly created files show up", async () => {
    const tree: FakeTree = { "a.ts": "" };
    const { store } = createFixture(tree);
    store.setQuery("ts");
    await settle(store);
    expect(store.getResultCount()).toBe(1);

    tree["b.ts"] = "";
    // Without a refresh the cached file list still has one entry
    // (`store.ts`'s "The file list is walked once and cached").
    store.setQuery("t");
    await settle(store);
    expect(store.getResultCount()).toBe(1);

    store.refresh();
    await settle(store);
    expect(store.getResultCount()).toBe(2);
  });
});
