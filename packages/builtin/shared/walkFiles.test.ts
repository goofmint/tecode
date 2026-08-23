/**
 * Tests for {@link walkFiles} (Task 3.2, Req 11.3) against a fake in-memory
 * directory tree (no real filesystem, no `node:fs` — matches this suite's
 * "no mock libraries, local fakes" house convention).
 */

import { describe, expect, test } from "bun:test";
import type { DirEntry, Uri } from "@tecode/api";
import { walkFiles, type WalkFilesDeps } from "./walkFiles";

const ROOT: Uri = "file:///workspace/";

/** A fake `readdir` over a plain nested-object tree: a directory value is
 * itself a `Record<name, Entry>`; a file value is `null`. Mirrors
 * `@tecode/api`'s `FileSystem.readdir` shape exactly (`DirEntry[]`). */
type FakeTree = { [name: string]: FakeTree | null };

function createFakeReaddir(tree: FakeTree): WalkFilesDeps["readdir"] {
  return async (uri: Uri): Promise<DirEntry[]> => {
    const relative = uri.replace(ROOT, "").replace(/\/$/, "");
    const segments = relative.length > 0 ? relative.split("/") : [];
    let node: FakeTree = tree;
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment);
      const next = node[decoded];
      if (next === null || next === undefined) {
        throw new Error(`ENOTDIR or ENOENT: ${uri}`);
      }
      node = next;
    }
    return Object.entries(node).map(([name, value]) => ({
      name,
      type: value === null ? "file" : "directory",
    }));
  };
}

describe("walkFiles (Task 3.2, Req 11.3)", () => {
  test("lists files recursively with relative paths, deterministically sorted", async () => {
    const tree: FakeTree = {
      "b.ts": null,
      "a.ts": null,
      src: {
        "index.ts": null,
        nested: { "deep.ts": null },
      },
    };
    const { files, truncated } = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
    expect(files.map((f) => f.relativePath)).toEqual([
      "a.ts",
      "b.ts",
      "src/index.ts",
      "src/nested/deep.ts",
    ]);
    expect(truncated).toBe(false);
  });

  test("produces absolute file:// URIs for each entry", async () => {
    const tree: FakeTree = { src: { "index.ts": null } };
    const { files } = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
    expect(files).toHaveLength(1);
    expect(files[0]!.uri).toBe("file:///workspace/src/index.ts");
  });

  test("is deterministic across repeated calls over the same tree", async () => {
    const tree: FakeTree = { z: null, m: { "n.ts": null }, a: null };
    const deps: WalkFilesDeps = { readdir: createFakeReaddir(tree) };
    const first = await walkFiles(ROOT, deps);
    const second = await walkFiles(ROOT, deps);
    expect(first).toEqual(second);
  });

  test("excludes .git and node_modules by default (ignore.ts's real ignore-aware default)", async () => {
    const tree: FakeTree = {
      ".git": { HEAD: null },
      node_modules: { "some-pkg": { "index.js": null } },
      src: { "index.ts": null },
    };
    const { files } = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
    expect(files.map((f) => f.relativePath)).toEqual(["src/index.ts"]);
  });

  test("a custom IgnoreChecker overrides the default (swappable interface, Task 3.3)", async () => {
    const tree: FakeTree = {
      "keep.ts": null,
      "skip.ts": null,
    };
    const { files } = await walkFiles(ROOT, {
      readdir: createFakeReaddir(tree),
      ignore: { filterEntries: async ({ entries }) => entries.filter((e) => e.name !== "skip.ts") },
    });
    expect(files.map((f) => f.relativePath)).toEqual(["keep.ts"]);
  });

  test("showHidden bypasses the default ignore logic entirely (Req 9.5)", async () => {
    const tree: FakeTree = {
      ".git": { HEAD: null },
      "visible.ts": null,
    };
    const { files } = await walkFiles(ROOT, { readdir: createFakeReaddir(tree), showHidden: true });
    expect(files.map((f) => f.relativePath).sort()).toEqual([".git/HEAD", "visible.ts"]);
  });

  test("an unreadable directory is skipped rather than throwing", async () => {
    const deps: WalkFilesDeps = {
      readdir: async (uri) => {
        if (uri === ROOT) return [{ name: "broken", type: "directory" }];
        throw new Error("permission denied");
      },
    };
    await expect(walkFiles(ROOT, deps)).resolves.toEqual({ files: [], truncated: false });
  });

  test("an empty workspace yields an empty list", async () => {
    const { files, truncated } = await walkFiles(ROOT, { readdir: createFakeReaddir({}) });
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });

  describe("maxResults (code review finding, bounded workspace scan)", () => {
    /** Wraps `readdir` counting how many times each directory URI is read,
     * so a test can prove a directory past the cap is never even opened —
     * not merely that the final file list was truncated after a full walk. */
    function createCountingReaddir(tree: FakeTree): {
      readdir: WalkFilesDeps["readdir"];
      callsFor: (uri: Uri) => number;
    } {
      const inner = createFakeReaddir(tree);
      const counts = new Map<string, number>();
      return {
        readdir: async (uri) => {
          counts.set(uri, (counts.get(uri) ?? 0) + 1);
          return inner(uri);
        },
        callsFor: (uri) => counts.get(uri) ?? 0,
      };
    }

    test("stops traversal entirely once the cap is reached — deeper directories are never read", async () => {
      const tree: FakeTree = {
        a: { "1.ts": null },
        b: { "2.ts": null },
        // Sorts after "a" and "b" — with maxResults: 2 hit inside "b", this
        // directory must never be `readdir`'d at all.
        c: { "3.ts": null },
      };
      const { readdir, callsFor } = createCountingReaddir(tree);

      const { files, truncated } = await walkFiles(ROOT, { readdir, maxResults: 2 });

      expect(files.map((f) => f.relativePath)).toEqual(["a/1.ts", "b/2.ts"]);
      expect(truncated).toBe(true);
      expect(callsFor("file:///workspace/c")).toBe(0);
    });

    test("truncated is false when the cap is never reached", async () => {
      const tree: FakeTree = { "a.ts": null, "b.ts": null };
      const { files, truncated } = await walkFiles(ROOT, {
        readdir: createFakeReaddir(tree),
        maxResults: 10,
      });
      expect(files).toHaveLength(2);
      expect(truncated).toBe(false);
    });

    test("omitting maxResults walks the whole tree, unchanged from before", async () => {
      const tree: FakeTree = {
        a: { "1.ts": null },
        b: { "2.ts": null },
        c: { "3.ts": null },
      };
      const { files, truncated } = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
      expect(files.map((f) => f.relativePath)).toEqual(["a/1.ts", "b/2.ts", "c/3.ts"]);
      expect(truncated).toBe(false);
    });
  });
});
