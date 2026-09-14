/**
 * Tests for `ipcSocketPath.ts` (Issue #158). Every input is injected
 * (`pid`/`env`/`tmpdir`), so nothing here reads or mutates a real global —
 * matching `terminal/platform.ts`'s own "plain parameters, real defaults"
 * convention.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIpcSocketDir, resolveIpcSocketPath } from "./ipcSocketPath";

test("uses $XDG_RUNTIME_DIR when it is set", () => {
  expect(resolveIpcSocketPath({ pid: 4242, env: { XDG_RUNTIME_DIR: "/run/user/1000" } })).toBe(
    "/run/user/1000/tecode/4242.sock",
  );
});

test("falls back to os.tmpdir() when XDG_RUNTIME_DIR is unset or empty", () => {
  const fakeTmp = (): string => "/fake/tmp";
  expect(resolveIpcSocketPath({ pid: 7, env: {}, tmpdir: fakeTmp })).toBe("/fake/tmp/tecode/7.sock");
  // An empty string is not a usable directory — treated exactly like unset
  // rather than resolving to a bare "tecode/<pid>.sock" relative path.
  expect(resolveIpcSocketPath({ pid: 7, env: { XDG_RUNTIME_DIR: "" }, tmpdir: fakeTmp })).toBe(
    "/fake/tmp/tecode/7.sock",
  );
});

test("the pid is what separates two concurrently running instances", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(resolveIpcSocketPath({ pid: 1, env })).not.toBe(resolveIpcSocketPath({ pid: 2, env }));
});

test("resolveIpcSocketDir is the socket path's parent — the directory the server creates 0700", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(resolveIpcSocketDir({ env })).toBe("/run/user/1000/tecode");
  expect(resolveIpcSocketPath({ pid: 9, env })).toBe(join(resolveIpcSocketDir({ env }), "9.sock"));
});

test("defaults to the real process.pid and environment", () => {
  const expected = resolveIpcSocketPath({ pid: process.pid, env: process.env, tmpdir: tmpdir });
  expect(resolveIpcSocketPath()).toBe(expected);
});
