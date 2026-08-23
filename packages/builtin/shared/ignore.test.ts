/**
 * Tests for {@link createIgnoreChecker} (Task 3.3, Req 11.2) — stubs
 * {@link GitRunner} BOTH ways (git present / absent → glob fallback, this
 * task's completion requirement) with local fakes, never a real `git`
 * subprocess (this suite's house convention: no mock libraries, local
 * fakes only).
 */

import { describe, expect, test } from "bun:test";
import type { DirEntry, Uri } from "@tecode/api";
import { createIgnoreChecker, type FilterEntriesOptions } from "./ignore";
import type { GitRunner } from "./gitRunner";

const ROOT: Uri = "file:///workspace/";

function entry(name: string, type: DirEntry["type"] = "file"): DirEntry {
  return { name, type };
}

function names(entries: DirEntry[]): string[] {
  return entries.map((e) => e.name);
}

/** A fake `GitRunner` that reports `git` unavailable — the glob-fallback
 * path. */
function createUnavailableGitRunner(): GitRunner {
  return {
    isAvailable: async () => false,
    checkIgnore: async () => {
      throw new Error("must not be called when git is unavailable");
    },
    isRepository: async () => {
      throw new Error("must not be called when git is unavailable");
    },
  };
}

/** A fake `GitRunner` that reports `git` available and ignores every
 * absolute path whose basename is in `ignoredBasenames` — enough to prove
 * the git path is actually exercised (batched call included) without a
 * real subprocess. */
function createFakeGitRunner(
  ignoredBasenames: ReadonlySet<string>,
): GitRunner & { calls: Array<{ cwd: string; paths: readonly string[] }> } {
  const calls: Array<{ cwd: string; paths: readonly string[] }> = [];
  return {
    calls,
    isAvailable: async () => true,
    isRepository: async () => true,
    checkIgnore: async (cwd, paths) => {
      calls.push({ cwd, paths });
      const ignored = paths.filter((p) => ignoredBasenames.has(p.split("/").pop() ?? ""));
      return new Set(ignored);
    },
  };
}

function baseOptions(entries: DirEntry[], overrides: Partial<FilterEntriesOptions> = {}): FilterEntriesOptions {
  return {
    rootUri: ROOT,
    dirUri: ROOT,
    relativeDir: "",
    entries,
    ...overrides,
  };
}

describe("createIgnoreChecker (Task 3.3, Req 11.2)", () => {
  describe("with no dependencies at all", () => {
    test("still hides dotfiles and the always-ignored VCS/dependency directory names", async () => {
      const checker = createIgnoreChecker();
      const visible = await checker.filterEntries(
        baseOptions([
          entry(".git", "directory"),
          entry(".env"),
          entry("node_modules", "directory"),
          entry("src", "directory"),
          entry("index.ts"),
        ]),
      );
      expect(names(visible)).toEqual(["src", "index.ts"]);
    });

    test("never excludes a FILE named like an always-ignored directory (dirs-only rule)", async () => {
      const checker = createIgnoreChecker();
      const visible = await checker.filterEntries(baseOptions([entry("node_modules", "file")]));
      expect(names(visible)).toEqual(["node_modules"]);
    });
  });

  describe("showHidden bypass (Req 9.5)", () => {
    test("bypasses dotfile hiding AND the always-ignored directory names", async () => {
      const checker = createIgnoreChecker();
      const visible = await checker.filterEntries(
        baseOptions([entry(".git", "directory"), entry("node_modules", "directory"), entry("src", "directory")], {
          showHidden: true,
        }),
      );
      expect(names(visible)).toEqual([".git", "node_modules", "src"]);
    });

    test("bypasses git check-ignore too", async () => {
      const gitRunner = createFakeGitRunner(new Set(["ignored.ts"]));
      const checker = createIgnoreChecker({ gitRunner });
      const visible = await checker.filterEntries(
        baseOptions([entry("ignored.ts"), entry("kept.ts")], { showHidden: true }),
      );
      expect(names(visible)).toEqual(["ignored.ts", "kept.ts"]);
      expect(gitRunner.calls).toEqual([]);
    });

    test("re-evaluated fresh on every call — no restart needed to take effect", async () => {
      const checker = createIgnoreChecker();
      const entries = [entry(".env")];
      expect(names(await checker.filterEntries(baseOptions(entries, { showHidden: false })))).toEqual([]);
      expect(names(await checker.filterEntries(baseOptions(entries, { showHidden: true })))).toEqual([".env"]);
      expect(names(await checker.filterEntries(baseOptions(entries, { showHidden: false })))).toEqual([]);
    });
  });

  describe("git available (batched check-ignore)", () => {
    test("filters out entries git reports ignored, keeps the rest", async () => {
      const gitRunner = createFakeGitRunner(new Set(["dist"]));
      const checker = createIgnoreChecker({ gitRunner });
      const visible = await checker.filterEntries(
        baseOptions([entry("dist", "directory"), entry("src", "directory"), entry("index.ts")]),
      );
      expect(names(visible)).toEqual(["src", "index.ts"]);
    });

    test("batches the whole directory's candidates into ONE checkIgnore call", async () => {
      const gitRunner = createFakeGitRunner(new Set());
      const checker = createIgnoreChecker({ gitRunner });
      await checker.filterEntries(baseOptions([entry("a.ts"), entry("b.ts"), entry("c.ts")]));
      expect(gitRunner.calls).toHaveLength(1);
      expect(gitRunner.calls[0]?.paths).toHaveLength(3);
    });

    test("never calls readFile (.gitignore content) when git is available", async () => {
      let readFileCalled = false;
      const gitRunner = createFakeGitRunner(new Set());
      const checker = createIgnoreChecker({
        gitRunner,
        readFile: async () => {
          readFileCalled = true;
          return new TextEncoder().encode("");
        },
      });
      await checker.filterEntries(baseOptions([entry("a.ts")]));
      expect(readFileCalled).toBe(false);
    });

    test("dotfiles and always-ignored directory names are excluded before git is even consulted", async () => {
      const gitRunner = createFakeGitRunner(new Set());
      const checker = createIgnoreChecker({ gitRunner });
      await checker.filterEntries(baseOptions([entry(".git", "directory"), entry("src", "directory")]));
      expect(gitRunner.calls).toHaveLength(1);
      expect(gitRunner.calls[0]?.paths).toEqual(["/workspace/src"]);
    });

    test("a checkIgnore failure degrades to 'nothing further ignored' rather than throwing", async () => {
      const gitRunner: GitRunner = {
        isAvailable: async () => true,
        isRepository: async () => true,
        checkIgnore: async () => {
          throw new Error("git exploded");
        },
      };
      const checker = createIgnoreChecker({ gitRunner });
      const visible = await checker.filterEntries(baseOptions([entry("a.ts")]));
      expect(names(visible)).toEqual(["a.ts"]);
    });

    test("an isAvailable failure falls back to the glob path rather than throwing", async () => {
      const gitRunner: GitRunner = {
        isAvailable: async () => {
          throw new Error("spawn failed");
        },
        isRepository: async () => true,
        checkIgnore: async () => new Set(),
      };
      const checker = createIgnoreChecker({
        gitRunner,
        readFile: async () => new TextEncoder().encode("*.log"),
      });
      const visible = await checker.filterEntries(baseOptions([entry("debug.log"), entry("keep.ts")]));
      expect(names(visible)).toEqual(["keep.ts"]);
    });
  });

  describe("git available but the workspace is not a repository", () => {
    test("falls back to the glob path rather than silently disabling .gitignore filtering", async () => {
      const gitRunner: GitRunner = {
        isAvailable: async () => true,
        isRepository: async () => false,
        checkIgnore: async () => {
          throw new Error("must not be called when the workspace is not a git repository");
        },
      };
      const checker = createIgnoreChecker({
        gitRunner,
        readFile: async () => new TextEncoder().encode("*.log"),
      });
      const visible = await checker.filterEntries(
        baseOptions([entry("debug.log"), entry("keep.ts")]),
      );
      expect(names(visible)).toEqual(["keep.ts"]);
    });

    test("isRepository is checked once per root and cached", async () => {
      let repoChecks = 0;
      const gitRunner: GitRunner = {
        isAvailable: async () => true,
        isRepository: async () => {
          repoChecks += 1;
          return false;
        },
        checkIgnore: async () => new Set(),
      };
      const checker = createIgnoreChecker({ gitRunner, readFile: async () => new TextEncoder().encode("") });
      await checker.filterEntries(baseOptions([entry("a.ts")]));
      await checker.filterEntries(
        baseOptions([entry("b.ts")], { dirUri: "file:///workspace/src/", relativeDir: "src" }),
      );
      expect(repoChecks).toBe(1);
    });

    test("an isRepository failure also falls back to the glob path rather than throwing", async () => {
      const gitRunner: GitRunner = {
        isAvailable: async () => true,
        isRepository: async () => {
          throw new Error("spawn failed");
        },
        checkIgnore: async () => new Set(),
      };
      const checker = createIgnoreChecker({
        gitRunner,
        readFile: async () => new TextEncoder().encode("*.log"),
      });
      const visible = await checker.filterEntries(
        baseOptions([entry("debug.log"), entry("keep.ts")]),
      );
      expect(names(visible)).toEqual(["keep.ts"]);
    });
  });

  describe("git unavailable (glob fallback over the root .gitignore)", () => {
    test("applies the root .gitignore's patterns", async () => {
      const checker = createIgnoreChecker({
        gitRunner: createUnavailableGitRunner(),
        readFile: async () => new TextEncoder().encode("*.log\n/dist"),
      });
      const visible = await checker.filterEntries(
        baseOptions([entry("debug.log"), entry("dist", "directory"), entry("src", "directory")]),
      );
      expect(names(visible)).toEqual(["src"]);
    });

    test("no readFile dependency at all: nothing further is ignored beyond dotfiles/always-ignored", async () => {
      const checker = createIgnoreChecker({ gitRunner: createUnavailableGitRunner() });
      const visible = await checker.filterEntries(baseOptions([entry("a.ts"), entry("b.log")]));
      expect(names(visible)).toEqual(["a.ts", "b.log"]);
    });

    test("a readFile rejection (no .gitignore file) degrades to 'nothing further ignored'", async () => {
      const checker = createIgnoreChecker({
        gitRunner: createUnavailableGitRunner(),
        readFile: async () => {
          throw new Error("ENOENT");
        },
      });
      const visible = await checker.filterEntries(baseOptions([entry("a.ts")]));
      expect(names(visible)).toEqual(["a.ts"]);
    });

    test("paths are normalized root-relative before matching a nested directory", async () => {
      const checker = createIgnoreChecker({
        gitRunner: createUnavailableGitRunner(),
        readFile: async () => new TextEncoder().encode("/src/*.generated.ts"),
      });
      const visible = await checker.filterEntries(
        baseOptions([entry("a.generated.ts"), entry("b.ts")], {
          dirUri: "file:///workspace/src/",
          relativeDir: "src",
        }),
      );
      expect(names(visible)).toEqual(["b.ts"]);
    });

    test("the same root .gitignore is only read once across multiple directories (cached per checker)", async () => {
      let readCount = 0;
      const checker = createIgnoreChecker({
        gitRunner: createUnavailableGitRunner(),
        readFile: async () => {
          readCount += 1;
          return new TextEncoder().encode("*.log");
        },
      });
      await checker.filterEntries(baseOptions([entry("a.ts")]));
      await checker.filterEntries(
        baseOptions([entry("b.ts")], { dirUri: "file:///workspace/src/", relativeDir: "src" }),
      );
      expect(readCount).toBe(1);
    });
  });
});
