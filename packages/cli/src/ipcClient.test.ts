/**
 * Tests for `ipcClient.ts` (Issue #158): the delegation DECISION
 * ({@link resolveDelegateTarget}, a pure function) and the delegation
 * itself ({@link delegateOpen}) against a hand-rolled in-memory connection
 * — no real socket, no mock library, matching `terminalSessionTracker.
 * test.ts`'s own shape.
 */

import { describe, expect, test } from "bun:test";
import {
  delegateOpen,
  resolveDelegateTarget,
  IPC_SOCKET_ENV_VAR,
  type DelegateConnect,
  type DelegateConnectHandlers,
} from "./ipcClient";
import { encodeIpcMessage, parseIpcRequest, IPC_PROTOCOL_VERSION } from "./ipcProtocol";

/** The "everything says delegate" baseline each case below perturbs by one
 * field, so a failing test names exactly which condition it is about. */
const DELEGATING_INPUT = {
  env: { [IPC_SOCKET_ENV_VAR]: "/run/user/1000/tecode/42.sock" },
  platformSupportsIpc: true,
  newWindow: false,
  wait: false,
  initialFilePath: "/abs/file.ts",
};

describe("resolveDelegateTarget", () => {
  test("delegates when the environment names a socket and there is a file to open", () => {
    expect(resolveDelegateTarget(DELEGATING_INPUT)).toEqual({
      socketPath: "/run/user/1000/tecode/42.sock",
      path: "/abs/file.ts",
      wait: false,
    });
  });

  test("carries --wait through to the request", () => {
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, wait: true })?.wait).toBe(true);
  });

  test("does not delegate without TECODE_SOCK — the ordinary launch from an outside shell", () => {
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, env: {} })).toBeUndefined();
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, env: { [IPC_SOCKET_ENV_VAR]: "" } })).toBeUndefined();
  });

  test("does not delegate with --new-window — the documented escape hatch", () => {
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, newWindow: true })).toBeUndefined();
  });

  test("does not delegate on a platform without the channel (Windows)", () => {
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, platformSupportsIpc: false })).toBeUndefined();
  });

  test("does not delegate without a file — a bare `tecode` or a directory argument wants its own editor", () => {
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, initialFilePath: undefined })).toBeUndefined();
    expect(resolveDelegateTarget({ ...DELEGATING_INPUT, initialFilePath: "" })).toBeUndefined();
  });
});

/** A fake {@link DelegateConnect} whose behaviour each test picks: it
 * records what was written and lets the test decide what (if anything) the
 * "host" answers. */
function createFakeConnect(behaviour: {
  reject?: boolean;
  respond?: (written: string, handlers: DelegateConnectHandlers) => void;
}): DelegateConnect & { written: string[]; ended: number } {
  const written: string[] = [];
  const state = { written, ended: 0 };
  const connect: DelegateConnect = (_socketPath, handlers) => {
    if (behaviour.reject) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve({
      write(data: string) {
        written.push(data);
        behaviour.respond?.(data, handlers);
      },
      end() {
        state.ended++;
      },
    });
  };
  return Object.assign(connect, state);
}

const TARGET = { socketPath: "/tmp/tecode/1.sock", path: "/abs/file.ts", wait: false };

describe("delegateOpen", () => {
  test("sends one well-formed open request and reports success on ok: true", async () => {
    const connect = createFakeConnect({
      respond: (_written, handlers) => {
        handlers.data(encodeIpcMessage({ v: IPC_PROTOCOL_VERSION, ok: true }));
      },
    });

    expect(await delegateOpen(TARGET, { connect, cwd: "/abs" })).toBe(true);
    expect(connect.written).toHaveLength(1);
    expect(parseIpcRequest((connect.written[0] ?? "").trim())).toEqual({
      v: IPC_PROTOCOL_VERSION,
      type: "open",
      path: "/abs/file.ts",
      cwd: "/abs",
      wait: false,
    });
  });

  test("a response split across two chunks is still understood", async () => {
    const encoded = encodeIpcMessage({ v: IPC_PROTOCOL_VERSION, ok: true });
    const connect = createFakeConnect({
      respond: (_written, handlers) => {
        handlers.data(encoded.slice(0, 4));
        handlers.data(encoded.slice(4));
      },
    });
    expect(await delegateOpen(TARGET, { connect })).toBe(true);
  });

  test("reports failure — i.e. 'start normally' — when the host answers ok: false", async () => {
    const connect = createFakeConnect({
      respond: (_written, handlers) => {
        handlers.data(encodeIpcMessage({ v: IPC_PROTOCOL_VERSION, ok: false, error: "unsupported request" }));
      },
    });
    expect(await delegateOpen(TARGET, { connect })).toBe(false);
  });

  test("a refused connection (dead instance, stale socket) resolves false rather than throwing", async () => {
    const connect = createFakeConnect({ reject: true });
    expect(await delegateOpen(TARGET, { connect })).toBe(false);
  });

  test("a peer that closes without answering resolves false", async () => {
    const connect = createFakeConnect({
      respond: (_written, handlers) => handlers.close(),
    });
    expect(await delegateOpen(TARGET, { connect })).toBe(false);
  });

  test("a silent host times out and resolves false instead of hanging the CLI", async () => {
    const connect = createFakeConnect({});
    expect(await delegateOpen(TARGET, { connect, timeoutMs: 10 })).toBe(false);
  });

  test("an unparseable answer is treated as no answer at all — the timeout decides", async () => {
    const connect = createFakeConnect({
      respond: (_written, handlers) => handlers.data("not json at all\n"),
    });
    expect(await delegateOpen(TARGET, { connect, timeoutMs: 10 })).toBe(false);
  });

  test("--wait is not time-bounded: a late answer still counts as success", async () => {
    let deliver: (() => void) | undefined;
    const connect = createFakeConnect({
      respond: (_written, handlers) => {
        deliver = () => handlers.data(encodeIpcMessage({ v: IPC_PROTOCOL_VERSION, ok: true }));
      },
    });
    // `timeoutMs` is deliberately tiny AND deliberately ignored here: a
    // `--wait` client is blocking on a human closing a tab, which has no
    // time bound (`DELEGATE_TIMEOUT_MS`'s TSDoc).
    const pending = delegateOpen({ ...TARGET, wait: true }, { connect, timeoutMs: 1 });
    await Bun.sleep(20);
    deliver?.();
    expect(await pending).toBe(true);
  });
});
