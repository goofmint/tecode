/**
 * Tests for `runTecode`'s single-instance delegation branch (Issue #158,
 * `main.ts`) — the decision to hand this invocation's file to an
 * already-running instance, wired against a fake client seam
 * (`RunTecodeOptions.delegateOpen`) so no socket is involved.
 *
 * **Only the DECLINED path runs in-process**, deliberately: a successful
 * delegation ends in `process.exit(0)`, which would take the test runner
 * with it. Declining is the more valuable half to pin anyway — it is what
 * guarantees a broken or absent channel never costs the user their editor
 * (`ipcClient.ts`'s "fail-safe in exactly one direction" TSDoc) — and the
 * successful half's own behaviour is already proven end to end, over a real
 * socket, in `ipcServer.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShutdown, runTecode, type AssemblyRoot } from "./main";
import { IPC_SOCKET_ENV_VAR, type DelegateTarget } from "./ipcClient";

const SOCKET = "/run/user/1000/tecode/4242.sock";

let previousSocketEnv: string | undefined;

afterEach(() => {
  if (previousSocketEnv === undefined) delete process.env[IPC_SOCKET_ENV_VAR];
  else process.env[IPC_SOCKET_ENV_VAR] = previousSocketEnv;
  previousSocketEnv = undefined;
});

/** Run `runTecode` far enough to observe the delegation decision, with the
 * render seam stubbed out and no extensions loaded, then tear the whole
 * root down through the SAME shutdown sequence production uses. */
async function runWithFakeDelegate(options: {
  socketEnv?: string;
  newWindow?: boolean;
  wait?: boolean;
  withFileArgument?: boolean;
  delegated: boolean;
}): Promise<{ calls: DelegateTarget[]; startedUp: boolean }> {
  previousSocketEnv = process.env[IPC_SOCKET_ENV_VAR];
  if (options.socketEnv === undefined) delete process.env[IPC_SOCKET_ENV_VAR];
  else process.env[IPC_SOCKET_ENV_VAR] = options.socketEnv;

  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-delegate-"));
  const filePath = join(workspaceDir, "file.ts");
  await writeFile(filePath, "export const a = 1;\n", "utf8");

  const calls: DelegateTarget[] = [];
  let root: AssemblyRoot | undefined;
  try {
    const result = await runTecode(options.withFileArgument === false ? [] : [filePath], {
      cwd: workspaceDir,
      headless: false,
      builtins: [],
      renderShell: async () => {},
      newWindow: options.newWindow,
      wait: options.wait,
      delegateOpen: async (target) => {
        calls.push(target);
        return options.delegated;
      },
    });
    root = result.root;
    return { calls, startedUp: true };
  } finally {
    if (root) await createShutdown(root)();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("delegates when TECODE_SOCK names a socket and a file was given", async () => {
  const { calls, startedUp } = await runWithFakeDelegate({ socketEnv: SOCKET, delegated: false });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.socketPath).toBe(SOCKET);
  expect(calls[0]?.path.endsWith("file.ts")).toBe(true);
  expect(calls[0]?.wait).toBe(false);
  // Declined (no listener on the other end) — so this process went on to
  // build a real editor exactly as it always did.
  expect(startedUp).toBe(true);
});

test("--wait rides along in the delegated request", async () => {
  const { calls } = await runWithFakeDelegate({ socketEnv: SOCKET, wait: true, delegated: false });
  expect(calls[0]?.wait).toBe(true);
});

test("--new-window never delegates — the escape hatch for a nested instance", async () => {
  const { calls, startedUp } = await runWithFakeDelegate({
    socketEnv: SOCKET,
    newWindow: true,
    delegated: false,
  });
  expect(calls).toEqual([]);
  expect(startedUp).toBe(true);
});

test("no TECODE_SOCK means no delegation attempt at all — the ordinary launch", async () => {
  const { calls, startedUp } = await runWithFakeDelegate({ delegated: false });
  expect(calls).toEqual([]);
  expect(startedUp).toBe(true);
});

test("a launch with no file argument never delegates — it wants its own editor", async () => {
  const { calls, startedUp } = await runWithFakeDelegate({
    socketEnv: SOCKET,
    withFileArgument: false,
    delegated: false,
  });
  expect(calls).toEqual([]);
  expect(startedUp).toBe(true);
});

test("runTecode opens no IPC socket of its own — only what the caller asks for", async () => {
  // `main()` is what derives the production socket path; a direct
  // `runTecode` call must never leave a live listener behind holding the
  // event loop open (`RunTecodeOptions.ipcSocketPath`'s TSDoc).
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-delegate-"));
  try {
    const result = await runTecode([], {
      cwd: workspaceDir,
      headless: false,
      builtins: [],
      renderShell: async () => {},
    });
    expect(result.root.ipcServer.socketPath).toBeUndefined();
    await createShutdown(result.root)();
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
