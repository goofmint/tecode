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
    const files = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
    expect(files.map((f) => f.relativePath)).toEqual([
      "a.ts",
      "b.ts",
      "src/index.ts",
      "src/nested/deep.ts",
    ]);
  });

  test("produces absolute file:// URIs for each entry", async () => {
    const tree: FakeTree = { src: { "index.ts": null } };
    const files = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
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

  test("excludes .git and node_modules by default (ignore.ts's interim stub)", async () => {
    const tree: FakeTree = {
      ".git": { HEAD: null },
      node_modules: { "some-pkg": { "index.js": null } },
      src: { "index.ts": null },
    };
    const files = await walkFiles(ROOT, { readdir: createFakeReaddir(tree) });
    expect(files.map((f) => f.relativePath)).toEqual(["src/index.ts"]);
  });

  test("a custom ignore predicate overrides the default (swappable interface)", async () => {
    const tree: FakeTree = {
      "keep.ts": null,
      "skip.ts": null,
    };
    const files = await walkFiles(ROOT, {
      readdir: createFakeReaddir(tree),
      ignore: (name) => name === "skip.ts",
    });
    expect(files.map((f) => f.relativePath)).toEqual(["keep.ts"]);
  });

  test("an unreadable directory is skipped rather than throwing", async () => {
    const deps: WalkFilesDeps = {
      readdir: async (uri) => {
        if (uri === ROOT) return [{ name: "broken", type: "directory" }];
        throw new Error("permission denied");
      },
    };
    await expect(walkFiles(ROOT, deps)).resolves.toEqual([]);
  });

  test("an empty workspace yields an empty list", async () => {
    const files = await walkFiles(ROOT, { readdir: createFakeReaddir({}) });
    expect(files).toEqual([]);
  });
});
