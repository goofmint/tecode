import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHostLog, type HostLogEntry } from "@tecode/core";
import { resolveConfigDirOverride, resolveStartupTarget } from "./argv";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test("no positional argument resolves to cwd with no initial file", async () => {
  const log = createHostLog();
  const target = await resolveStartupTarget([], "/some/cwd", log);
  expect(target).toEqual({ workspaceRoot: "/some/cwd" });
  expect(log.entries()).toEqual([]);
});

test("a directory argument becomes workspaceRoot with no initial file", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const log = createHostLog();
  const target = await resolveStartupTarget([dir], "/irrelevant", log);
  expect(target).toEqual({ workspaceRoot: dir });
});

test("a file argument's parent directory becomes workspaceRoot, and the file is the initial file", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const filePath = join(dir, "notes.txt");
  await writeFile(filePath, "hello", "utf8");

  const log = createHostLog();
  const target = await resolveStartupTarget([filePath], "/irrelevant", log);
  expect(target).toEqual({ workspaceRoot: dir, initialFilePath: filePath });
});

test("a relative path argument resolves against cwd", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  await mkdir(join(dir, "sub"), { recursive: true });

  const log = createHostLog();
  const target = await resolveStartupTarget(["sub"], dir, log);
  expect(target).toEqual({ workspaceRoot: join(dir, "sub") });
});

test("a nonexistent path logs a warning and falls back to cwd", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const missing = join(dir, "does-not-exist");

  const log = createHostLog();
  const target = await resolveStartupTarget([missing], "/fallback-cwd", log);
  expect(target).toEqual({ workspaceRoot: "/fallback-cwd" });

  const entries: readonly HostLogEntry[] = log.entries();
  expect(entries.length).toBe(1);
  expect(entries[0]?.level).toBe("warning");
  expect(entries[0]?.error.message).toContain(missing);
});

test("only the first non-flag token is treated as the positional argument", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const log = createHostLog();
  const target = await resolveStartupTarget(["--verbose", dir], "/irrelevant", log);
  expect(target).toEqual({ workspaceRoot: dir });
});

test("uses the injected fs seam instead of touching real disk", async () => {
  const log = createHostLog();
  const fakeFs = {
    stat: async (path: string) => {
      expect(path).toBe(join("/cwd", "project"));
      return { isDirectory: () => true };
    },
  };
  const target = await resolveStartupTarget(["project"], "/cwd", log, fakeFs);
  expect(target).toEqual({ workspaceRoot: join("/cwd", "project") });
});

test("parent directory of a nested file resolves correctly", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const nested = join(dir, "a", "b");
  await mkdir(nested, { recursive: true });
  const filePath = join(nested, "file.ts");
  await writeFile(filePath, "", "utf8");

  const log = createHostLog();
  const target = await resolveStartupTarget([filePath], "/irrelevant", log);
  expect(target.workspaceRoot).toBe(dirname(filePath));
  expect(target.initialFilePath).toBe(filePath);
});

// --- resolveConfigDirOverride (Req 9.6, Issue #81 Phase 1) ---

test("resolveConfigDirOverride returns the token immediately after --config", () => {
  expect(resolveConfigDirOverride(["--config", "/tmp/cfg"])).toBe("/tmp/cfg");
});

test("resolveConfigDirOverride returns undefined when --config is absent", () => {
  expect(resolveConfigDirOverride([])).toBeUndefined();
  expect(resolveConfigDirOverride(["./src"])).toBeUndefined();
});

test("resolveConfigDirOverride returns undefined when --config is the last token (no value follows)", () => {
  expect(resolveConfigDirOverride(["--config"])).toBeUndefined();
  expect(resolveConfigDirOverride(["./src", "--config"])).toBeUndefined();
});

test("resolveConfigDirOverride finds --config regardless of surrounding tokens", () => {
  expect(resolveConfigDirOverride(["./src", "--config", "/tmp/cfg"])).toBe("/tmp/cfg");
  expect(resolveConfigDirOverride(["--config", "/tmp/cfg", "./src"])).toBe("/tmp/cfg");
});

// --- resolveStartupTarget's --config non-confusion (Req 9.6, Issue #81 Phase 1) ---

test("--config's value is not mistaken for the positional argument: a directory still follows it", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const srcDir = join(dir, "src");
  await mkdir(srcDir, { recursive: true });

  const log = createHostLog();
  const target = await resolveStartupTarget(
    ["--config", "/tmp/some-config-dir", srcDir],
    "/irrelevant",
    log,
  );
  expect(target).toEqual({ workspaceRoot: srcDir });
});

test("a REPEATED --config's value is not mistaken for the positional argument either", async () => {
  // Which `--config` wins is a separate question from which tokens are
  // values. Excluding only the FIRST occurrence's value left the second one
  // looking like a bare positional, so `--config /a --config /b` silently
  // opened `/b` as the WORKSPACE — a different thing entirely from what was
  // asked (CodeRabbit finding on PR #85).
  const dir = await mkdtemp(join(tmpdir(), "tecode-argv-repeat-"));
  const otherDir = await mkdtemp(join(tmpdir(), "tecode-argv-repeat-other-"));
  const log = createHostLog();
  try {
    const target = await resolveStartupTarget(
      ["--config", dir, "--config", otherDir],
      process.cwd(),
      log,
    );
    expect(target).toEqual({ workspaceRoot: process.cwd() });
    // The override itself still takes the first occurrence.
    expect(resolveConfigDirOverride(["--config", dir, "--config", otherDir])).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  }
});

test("--config with no following positional opens nothing (falls back to cwd)", async () => {
  const log = createHostLog();
  const target = await resolveStartupTarget(
    ["--config", "/tmp/some-config-dir"],
    "/fallback-cwd",
    log,
  );
  expect(target).toEqual({ workspaceRoot: "/fallback-cwd" });
  // The config dir's value itself was never treated as a bad startup
  // path — no warning should have been logged about it.
  expect(log.entries()).toEqual([]);
});

test("a plain positional argument still opens normally when --config is entirely absent", async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-argv-"));
  const log = createHostLog();
  const target = await resolveStartupTarget([dir], "/irrelevant", log);
  expect(target).toEqual({ workspaceRoot: dir });
});
