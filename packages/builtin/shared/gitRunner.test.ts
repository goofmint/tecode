/**
 * Tests for {@link createBunGitRunner} (Task 3.3, Req 11.2) — the real
 * `Bun.spawn`-backed `GitRunner` implementation. `ignore.ts`'s own tests
 * stub `GitRunner` entirely (this task's "stub both ways" completion
 * requirement); this suite instead proves the REAL implementation actually
 * talks to a real `git` CLI correctly, against a real temp git repository —
 * skipped outright when this environment has no `git` binary at all
 * (`isAvailable()` reporting `false` is itself part of what's asserted).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunGitRunner, uriToGitPath } from "./gitRunner";

async function initRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

describe("createBunGitRunner (Task 3.3, Req 11.2)", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("isAvailable() reports true when the git CLI is installed", async () => {
    const runner = createBunGitRunner();
    expect(await runner.isAvailable()).toBe(true);
  });

  test("isAvailable() caches its result — a second call does not re-spawn", async () => {
    const runner = createBunGitRunner();
    const first = await runner.isAvailable();
    const second = await runner.isAvailable();
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  test("checkIgnore reports paths matched by the repo's real .gitignore, echoed back exactly as given", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-gitrunner-"));
    await initRepo(dir);
    await writeFile(join(dir, ".gitignore"), "*.log\n");
    const keptPath = join(dir, "keep.ts");
    const ignoredPath = join(dir, "debug.log");
    await writeFile(keptPath, "export {};\n");
    await writeFile(ignoredPath, "log line\n");

    const runner = createBunGitRunner();
    const ignored = await runner.checkIgnore(dir, [keptPath, ignoredPath]);

    expect(ignored.has(ignoredPath)).toBe(true);
    expect(ignored.has(keptPath)).toBe(false);
  });

  test("checkIgnore respects a nested .gitignore too (real git resolves the full chain)", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-gitrunner-"));
    await initRepo(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", ".gitignore"), "generated.ts\n");
    const nestedIgnoredPath = join(dir, "src", "generated.ts");
    const nestedKeptPath = join(dir, "src", "index.ts");
    await writeFile(nestedIgnoredPath, "// generated\n");
    await writeFile(nestedKeptPath, "export {};\n");

    const runner = createBunGitRunner();
    const ignored = await runner.checkIgnore(dir, [nestedIgnoredPath, nestedKeptPath]);

    expect(ignored.has(nestedIgnoredPath)).toBe(true);
    expect(ignored.has(nestedKeptPath)).toBe(false);
  });

  test("checkIgnore returns an empty set when nothing is ignored (git's exit 1 is not an error here)", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-gitrunner-"));
    await initRepo(dir);
    const filePath = join(dir, "a.ts");
    await writeFile(filePath, "export {};\n");

    const runner = createBunGitRunner();
    const ignored = await runner.checkIgnore(dir, [filePath]);

    expect(ignored.size).toBe(0);
  });

  test("checkIgnore against a non-repository directory degrades to an empty set rather than throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-gitrunner-not-a-repo-"));
    const filePath = join(dir, "a.ts");
    await writeFile(filePath, "export {};\n");

    const runner = createBunGitRunner();
    await expect(runner.checkIgnore(dir, [filePath])).resolves.toEqual(new Set());
  });

  test("checkIgnore with an empty path list never spawns and resolves to an empty set", async () => {
    const runner = createBunGitRunner();
    const ignored = await runner.checkIgnore("/nonexistent", []);
    expect(ignored.size).toBe(0);
  });
});

describe("uriToGitPath (Task 3.3, Req 11.2)", () => {
  test("converts a file:// URI to a real filesystem path", () => {
    expect(uriToGitPath("file:///workspace/src")).toBe("/workspace/src");
  });

  test("falls back to the raw string for an unparseable URI rather than throwing", () => {
    expect(uriToGitPath("not-a-uri" as never)).toBe("not-a-uri");
  });
});
