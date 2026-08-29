/**
 * Tests for {@link createTerminalStore} (Issue #98 Phase 4) — local fakes
 * only (no mock libraries, house convention), matching `explorer/
 * store.test.ts`'s own shape.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, Listener, PtyExitEvent, PtySession, PtySpawnOptions } from "@tecode/api";
import { createTerminalStore, type TerminalStore } from "./store";

function createFakeSession(): PtySession & { disposed: boolean; fireExit: (exitCode: number) => void } {
  let disposed = false;
  const exitListeners = new Set<Listener<PtyExitEvent>>();
  return {
    get disposed() {
      return disposed;
    },
    write() {},
    resize() {},
    onData: () => ({ dispose() {} }) as Disposable,
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    dispose() {
      disposed = true;
    },
    fireExit(exitCode) {
      for (const l of Array.from(exitListeners)) l({ exitCode });
    },
  };
}

function createHarness(): {
  store: TerminalStore;
  spawnCalls: PtySpawnOptions[];
  sessions: ReturnType<typeof createFakeSession>[];
} {
  const spawnCalls: PtySpawnOptions[] = [];
  const sessions: ReturnType<typeof createFakeSession>[] = [];
  const store = createTerminalStore({
    spawn: (options) => {
      spawnCalls.push(options);
      const session = createFakeSession();
      sessions.push(session);
      return session;
    },
    cmd: ["/bin/sh"],
    initialCols: 80,
    initialRows: 24,
  });
  return { store, spawnCalls, sessions };
}

describe("createTerminalStore — session lifecycle", () => {
  test("getSession() is undefined before anything spawns", () => {
    const { store } = createHarness();
    expect(store.getSession()).toBeUndefined();
  });

  test("ensureSession() spawns once with the configured cmd/initial size", () => {
    const { store, spawnCalls } = createHarness();
    const session = store.ensureSession();
    expect(session).toBeDefined();
    expect(spawnCalls).toEqual([{ cmd: ["/bin/sh"], cwd: undefined, cols: 80, rows: 24 }]);
  });

  test("ensureSession() is idempotent — a second call returns the SAME session without spawning again", () => {
    const { store, spawnCalls } = createHarness();
    const first = store.ensureSession();
    const second = store.ensureSession();
    expect(second).toBe(first);
    expect(spawnCalls).toHaveLength(1);
  });

  test("onDidChange fires when ensureSession() actually spawns", () => {
    const { store } = createHarness();
    let changes = 0;
    store.onDidChange(() => changes++);
    store.ensureSession();
    expect(changes).toBe(1);
    store.ensureSession(); // idempotent — no second fire
    expect(changes).toBe(1);
  });

  test("respawn() disposes the current session and spawns a fresh one", () => {
    const { store, sessions } = createHarness();
    const first = store.ensureSession();
    const second = store.respawn();
    expect(second).not.toBe(first);
    expect(sessions[0]?.disposed).toBe(true);
    expect(store.getSession()).toBe(second);
  });

  test("respawn() with no prior session simply spawns one (no crash on nothing-to-dispose)", () => {
    const { store, sessions } = createHarness();
    const session = store.respawn();
    expect(session).toBeDefined();
    expect(sessions).toHaveLength(1);
  });

  test("a session that exits on its own clears getSession() and fires onDidChange", () => {
    const { store, sessions } = createHarness();
    store.ensureSession();
    let changes = 0;
    store.onDidChange(() => changes++);

    sessions[0]?.fireExit(0);

    expect(store.getSession()).toBeUndefined();
    expect(changes).toBe(1);
  });

  test("after a session exits, ensureSession() spawns a genuinely new one", () => {
    const { store, sessions } = createHarness();
    store.ensureSession();
    sessions[0]?.fireExit(1);

    const fresh = store.ensureSession();

    expect(fresh).not.toBe(sessions[0]);
    expect(sessions).toHaveLength(2);
  });

  test("dispose() tears down the current session; a second call is a no-op", () => {
    const { store, sessions } = createHarness();
    store.ensureSession();
    store.dispose();
    expect(sessions[0]?.disposed).toBe(true);
    expect(store.getSession()).toBeUndefined();
    expect(() => store.dispose()).not.toThrow();
  });

  test("dispose() with no session ever spawned is a harmless no-op", () => {
    const { store } = createHarness();
    expect(() => store.dispose()).not.toThrow();
  });
});

describe("createTerminalStore — focus handle brokering", () => {
  test("requestFocus() calls an already-registered handle immediately", () => {
    const { store } = createHarness();
    let focused = 0;
    store.registerFocusHandle(() => focused++);

    store.requestFocus();

    expect(focused).toBe(1);
  });

  test("requestFocus() before any handle registers is remembered and consumed on the next registerFocusHandle() call", () => {
    const { store } = createHarness();
    store.requestFocus(); // No handle yet — must not throw, must be remembered.

    let focused = 0;
    store.registerFocusHandle(() => focused++);

    expect(focused).toBe(1);
  });

  test("registerFocusHandle() with no pending request does NOT call the handle", () => {
    const { store } = createHarness();
    let focused = 0;
    store.registerFocusHandle(() => focused++);
    expect(focused).toBe(0);
  });

  test("registerFocusHandle(undefined) (unmount) clears the handle — a later requestFocus() goes back to pending", () => {
    const { store } = createHarness();
    let focused = 0;
    store.registerFocusHandle(() => focused++);
    store.registerFocusHandle(undefined);

    store.requestFocus();
    expect(focused).toBe(0); // no handle attached right now

    let focusedAgain = 0;
    store.registerFocusHandle(() => focusedAgain++);
    expect(focusedAgain).toBe(1); // the pending request from above is consumed
  });

  test("a consumed pending request is not replayed a second time", () => {
    const { store } = createHarness();
    store.requestFocus();
    let calls = 0;
    store.registerFocusHandle(() => calls++);
    expect(calls).toBe(1);

    store.registerFocusHandle(undefined);
    store.registerFocusHandle(() => calls++);
    expect(calls).toBe(1); // no NEW pending request — stays at 1
  });
});
