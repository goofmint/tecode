/**
 * Tests for `ipcSocketPath.ts` (Issue #158). Every input is injected
 * (`pid`/`env`/`tmpdir`/`uid`), so nothing here reads or mutates a real
 * global — matching `terminal/platform.ts`'s own "plain parameters, real
 * defaults" convention.
 *
 * Expected paths are built with `join` rather than written as POSIX
 * literals: the helper itself uses `node:path`, so a literal `"/a/b"` would
 * fail on Windows over nothing more than the separator (CodeRabbit review
 * on PR #159).
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIpcSocketDir, resolveIpcSocketPath } from "./ipcSocketPath";

test("uses $XDG_RUNTIME_DIR when it is set", () => {
  expect(resolveIpcSocketPath({ pid: 4242, env: { XDG_RUNTIME_DIR: "/run/user/1000" } })).toBe(
    join("/run/user/1000", "tecode", "4242.sock"),
  );
});

test("falls back to os.tmpdir() when XDG_RUNTIME_DIR is unset or empty", () => {
  const fakeTmp = (): string => "/fake/tmp";
  expect(resolveIpcSocketPath({ pid: 7, env: {}, tmpdir: fakeTmp, uid: 501 })).toBe(
    join("/fake/tmp", "tecode-501", "7.sock"),
  );
  // An empty string is not a usable directory — treated exactly like unset
  // rather than resolving to a bare "tecode/<pid>.sock" relative path.
  expect(
    resolveIpcSocketPath({ pid: 7, env: { XDG_RUNTIME_DIR: "" }, tmpdir: fakeTmp, uid: 501 }),
  ).toBe(join("/fake/tmp", "tecode-501", "7.sock"));
});

test("the os.tmpdir() fallback is per-user, so a shared /tmp cannot lock one user out", () => {
  // `ipcServer.ts` creates this directory 0700 — a fixed name under a
  // shared /tmp would make the first user's directory unusable by everyone
  // else (that function's own TSDoc).
  const fakeTmp = (): string => "/fake/tmp";
  expect(resolveIpcSocketDir({ env: {}, tmpdir: fakeTmp, uid: 501 })).not.toBe(
    resolveIpcSocketDir({ env: {}, tmpdir: fakeTmp, uid: 502 }),
  );
  // $XDG_RUNTIME_DIR is already per-user, so it keeps the plain name.
  expect(resolveIpcSocketDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 501 })).toBe(
    join("/run/user/1000", "tecode"),
  );
});

test("the pid is what separates two concurrently running instances", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(resolveIpcSocketPath({ pid: 1, env })).not.toBe(resolveIpcSocketPath({ pid: 2, env }));
});

test("resolveIpcSocketDir is the socket path's parent — the directory the server creates 0700", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(resolveIpcSocketDir({ env })).toBe(join("/run/user/1000", "tecode"));
  expect(resolveIpcSocketPath({ pid: 9, env })).toBe(join(resolveIpcSocketDir({ env }), "9.sock"));
});

test("defaults to the real process.pid, environment, tmpdir and uid", () => {
  const expected = resolveIpcSocketPath({
    pid: process.pid,
    env: process.env,
    tmpdir,
    uid: process.getuid?.(),
  });
  expect(resolveIpcSocketPath()).toBe(expected);
});
