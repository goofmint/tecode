/**
 * Tests for {@link createTerminalSessionTracker} (Issue #98 Phase 3/5)
 * against a hand-rolled fake `TerminalNamespace` — no real `Bun.Terminal`,
 * no mocking library.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, Listener, PtyExitEvent, PtySession, PtySpawnOptions, TerminalNamespace } from "@tecode/api";
import { createTerminalSessionTracker } from "./terminalSessionTracker";

/** A minimal, hand-rolled fake `PtySession` — records writes, lets the
 * test fire `onExit`, and reports whether `dispose()` was called. */
function createFakeSession(): PtySession & { written: string[]; disposed: boolean; fireExit: (exitCode: number) => void } {
  const written: string[] = [];
  let disposed = false;
  const exitListeners = new Set<Listener<PtyExitEvent>>();
  return {
    written,
    get disposed() {
      return disposed;
    },
    write(data) {
      written.push(data);
    },
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

function createFakeNamespace(supported = true): Pick<TerminalNamespace, "isSupported" | "spawn"> & {
  spawned: PtySpawnOptions[];
  nextSession: ReturnType<typeof createFakeSession>;
} {
  const spawned: PtySpawnOptions[] = [];
  const state = {
    spawned,
    nextSession: createFakeSession(),
    isSupported: () => supported,
    spawn(options: PtySpawnOptions) {
      spawned.push(options);
      // Reads `state.nextSession` at CALL time, not at construction time
      // — lets a test swap in a fresh fake session between two `spawn()`
      // calls (this file's "second spawn() replaces..." test).
      return state.nextSession;
    },
  };
  return state;
}

describe("createTerminalSessionTracker", () => {
  test("isSupported() delegates straight to the wrapped namespace", () => {
    const supported = createTerminalSessionTracker(createFakeNamespace(true));
    const unsupported = createTerminalSessionTracker(createFakeNamespace(false));
    expect(supported.isSupported()).toBe(true);
    expect(unsupported.isSupported()).toBe(false);
  });

  test("writeToActiveSession is a no-op before anything has spawned", () => {
    const tracker = createTerminalSessionTracker(createFakeNamespace());
    expect(tracker.hasActiveSession()).toBe(false);
    expect(() => tracker.writeToActiveSession("x")).not.toThrow();
  });

  test("after spawn(), writeToActiveSession writes into the real returned session", () => {
    const inner = createFakeNamespace();
    const tracker = createTerminalSessionTracker(inner);

    const session = tracker.spawn({ cmd: ["bash"], cols: 80, rows: 24 });

    expect(tracker.hasActiveSession()).toBe(true);
    tracker.writeToActiveSession("hello");
    expect(inner.nextSession.written).toEqual(["hello"]);
    // The caller's own returned session's `write` reaches the SAME
    // underlying session too — it is not a separate, disconnected object.
    session.write("direct");
    expect(inner.nextSession.written).toEqual(["hello", "direct"]);
  });

  test("spawn() forwards options unmodified to the wrapped namespace", () => {
    const inner = createFakeNamespace();
    const tracker = createTerminalSessionTracker(inner);
    const options: PtySpawnOptions = { cmd: ["bash", "-l"], cols: 100, rows: 30, cwd: "/tmp" };

    tracker.spawn(options);

    expect(inner.spawned).toEqual([options]);
  });

  test("a session that exits on its own clears the active session — subsequent writes are silent no-ops", () => {
    const inner = createFakeNamespace();
    const tracker = createTerminalSessionTracker(inner);
    tracker.spawn({ cmd: ["bash"], cols: 80, rows: 24 });
    expect(tracker.hasActiveSession()).toBe(true);

    inner.nextSession.fireExit(0);

    expect(tracker.hasActiveSession()).toBe(false);
    tracker.writeToActiveSession("after-exit");
    expect(inner.nextSession.written).toEqual([]);
  });

  test("calling the returned session's own dispose() clears the active session and disposes the real one", () => {
    const inner = createFakeNamespace();
    const tracker = createTerminalSessionTracker(inner);
    const session = tracker.spawn({ cmd: ["bash"], cols: 80, rows: 24 });

    session.dispose();

    expect(tracker.hasActiveSession()).toBe(false);
    expect(inner.nextSession.disposed).toBe(true);
    tracker.writeToActiveSession("after-dispose");
    expect(inner.nextSession.written).toEqual([]);
  });

  test("a second spawn() replaces the tracked active session with the new one (single-terminal MVP: last spawn wins)", () => {
    const inner = createFakeNamespace();
    const tracker = createTerminalSessionTracker(inner);
    tracker.spawn({ cmd: ["bash"], cols: 80, rows: 24 });
    const firstSession = inner.nextSession;

    const secondFakeSession = createFakeSession();
    inner.nextSession = secondFakeSession;
    tracker.spawn({ cmd: ["zsh"], cols: 80, rows: 24 });

    tracker.writeToActiveSession("goes-to-second");
    expect(firstSession.written).toEqual([]);
    expect(secondFakeSession.written).toEqual(["goes-to-second"]);
  });
});
