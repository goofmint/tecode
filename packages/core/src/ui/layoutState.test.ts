import { describe, expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import {
  createLayoutStateService,
  DEFAULT_LAYOUT_STATE,
  type LayoutState,
  type LayoutStateFs,
  type LayoutStateTimer,
} from "./layoutState";

/** A `StatusSink` stub that records every error it receives (matches
 * `config/service.test.ts`'s `createRecordingSink`). */
function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

/** An in-memory {@link LayoutStateFs}: `readFile` serves whatever
 * `setFile` last stored (or ENOENT); `writeFile` records every write so
 * tests can assert on it directly instead of round-tripping through a real
 * file (matches `config/service.test.ts`'s `createFakeFs`). */
function createFakeFs(initial: Record<string, string> = {}): {
  fs: LayoutStateFs;
  writes(): { path: string; data: string }[];
  setFile(path: string, content: string): void;
} {
  const files = new Map(Object.entries(initial));
  const writes: { path: string; data: string }[] = [];
  return {
    fs: {
      async readFile(path) {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        }
        return content;
      },
      async mkdir() {
        // No-op — the fake has no real directories to create.
      },
      async writeFile(path, data) {
        writes.push({ path, data });
        files.set(path, data);
      },
    },
    writes: () => writes,
    setFile(path, content) {
      files.set(path, content);
    },
  };
}

/** A manually-driven {@link LayoutStateTimer}: `schedule` records the
 * callback instead of running it on a real clock; the test fires it later
 * via `runScheduled()` — deterministic, no real waiting (design.md §16's
 * "no flaky timing"). */
function createManualTimer(): {
  timer: LayoutStateTimer;
  scheduledCount(): number;
  cancelledCount(): number;
  runScheduled(): void;
} {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  let cancelledCount = 0;
  return {
    timer: {
      schedule(fn) {
        const handle = nextHandle++;
        pending.set(handle, fn);
        return handle;
      },
      cancel(handle) {
        if (pending.delete(handle as number)) cancelledCount += 1;
      },
    },
    scheduledCount: () => nextHandle,
    cancelledCount: () => cancelledCount,
    runScheduled() {
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, fn] of entries) fn();
    },
  };
}

describe("createLayoutStateService — load (Req 6.4)", () => {
  test("no file yet: ready resolves and get() reports DEFAULT_LAYOUT_STATE", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });

    await service.ready;
    expect(service.get()).toEqual(DEFAULT_LAYOUT_STATE);
  });

  test("a well-formed file overrides the defaults", async () => {
    const stored: LayoutState = {
      sidebarVisible: false,
      sidebarWidth: 42,
      panelVisible: true,
      panelHeight: 12,
      activeView: "explorer",
    };
    const { fs } = createFakeFs({ "/state.json": JSON.stringify(stored) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });

    await service.ready;
    expect(service.get()).toEqual(stored);
  });

  test("a corrupt file keeps last-good defaults and reports through log/sink", async () => {
    const { fs } = createFakeFs({ "/state.json": "{ not json" });
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });

    await service.ready;
    expect(service.get()).toEqual(DEFAULT_LAYOUT_STATE);
    expect(errors.some((e) => e.path === "/state.json")).toBe(true);
    expect(log.entries().some((e) => e.level === "error")).toBe(true);
  });

  test("a partially-typed file falls back per-field to defaults", async () => {
    const { fs } = createFakeFs({
      "/state.json": JSON.stringify({ sidebarWidth: "not a number", panelVisible: true }),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });

    await service.ready;
    const state = service.get();
    expect(state.sidebarWidth).toBe(DEFAULT_LAYOUT_STATE.sidebarWidth);
    expect(state.panelVisible).toBe(true);
    expect(state.sidebarVisible).toBe(DEFAULT_LAYOUT_STATE.sidebarVisible);
  });
});

describe("createLayoutStateService — update()/debounce/flush (Req 6.4, design.md §8.2)", () => {
  test("update() reflects immediately in get() before any write happens", async () => {
    const { fs, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const { timer } = createManualTimer();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs, timer });
    await service.ready;

    service.update({ sidebarWidth: 99 });
    expect(service.get().sidebarWidth).toBe(99);
    expect(writes()).toEqual([]);
  });

  test("the write only happens once the debounce timer fires", async () => {
    const { fs, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const { timer, runScheduled } = createManualTimer();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs, timer });
    await service.ready;

    service.update({ sidebarWidth: 99 });
    expect(writes()).toEqual([]);

    runScheduled();
    await service.flush(); // drains the chain scheduleSave() appended

    expect(writes()).toHaveLength(1);
    const written = JSON.parse(writes()[0]!.data) as LayoutState;
    expect(written.sidebarWidth).toBe(99);
  });

  test("a burst of update() calls before the timer fires produces exactly one write, with the latest values", async () => {
    const { fs, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const { timer, runScheduled, cancelledCount } = createManualTimer();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs, timer });
    await service.ready;

    service.update({ sidebarWidth: 10 });
    service.update({ sidebarWidth: 20 });
    service.update({ sidebarWidth: 30, activeView: "explorer" });

    // Each update() cancels the previous debounce timer and starts a new
    // one — two of the three scheduled timers get cancelled.
    expect(cancelledCount()).toBe(2);

    runScheduled();
    await service.flush();

    expect(writes()).toHaveLength(1);
    const written = JSON.parse(writes()[0]!.data) as LayoutState;
    expect(written.sidebarWidth).toBe(30);
    expect(written.activeView).toBe("explorer");
  });

  test("flush() cancels the pending debounce and writes immediately (the shutdown path)", async () => {
    const { fs, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const { timer, cancelledCount } = createManualTimer();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs, timer });
    await service.ready;

    service.update({ panelVisible: true });
    await service.flush();

    expect(cancelledCount()).toBe(1);
    expect(writes()).toHaveLength(1);
    const written = JSON.parse(writes()[0]!.data) as LayoutState;
    expect(written.panelVisible).toBe(true);
  });

  test("flush() with nothing pending resolves without writing", async () => {
    const { fs, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    await service.flush();
    expect(writes()).toEqual([]);
  });

  test("a write failure is reported through log/sink and never throws", async () => {
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const fs: LayoutStateFs = {
      async readFile() {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      async mkdir() {
        // No-op.
      },
      async writeFile() {
        throw new Error("disk full");
      },
    };
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    service.update({ sidebarWidth: 5 });
    await expect(service.flush()).resolves.toBeUndefined();
    expect(errors.some((e) => e.message.includes("disk full"))).toBe(true);
  });

  test("a roundtrip across a simulated restart: flush(), then a fresh service reads it back", async () => {
    const { fs, setFile, writes } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();

    const first = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await first.ready;
    first.update({ sidebarWidth: 77, activeView: "search" });
    await first.flush();

    expect(writes()).toHaveLength(1);
    // Simulate a fresh process by pointing a brand-new service at the same
    // (now-populated) fake file store.
    setFile("/state.json", writes()[0]!.data);
    const second = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await second.ready;

    expect(second.get().sidebarWidth).toBe(77);
    expect(second.get().activeView).toBe("search");
  });

  test("an update() that lands mid-load wins over the persisted value for that field, without losing other persisted fields", async () => {
    const stored: LayoutState = {
      sidebarVisible: false,
      sidebarWidth: 42,
      panelVisible: true,
      panelHeight: 12,
      activeView: "explorer",
    };
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const writes: { path: string; data: string }[] = [];
    const fs: LayoutStateFs = {
      async readFile() {
        await gate; // Blocks until the test calls releaseRead() below.
        return JSON.stringify(stored);
      },
      async mkdir() {
        // No-op.
      },
      async writeFile(p, data) {
        writes.push({ path: p, data });
      },
    };
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });

    // update() arrives while `load()` is still awaiting `fs.readFile` —
    // the exact race this test guards against.
    service.update({ sidebarWidth: 99 });
    expect(service.get().sidebarWidth).toBe(99);

    releaseRead?.();
    await service.ready;

    // The local update must survive load()'s merge...
    expect(service.get().sidebarWidth).toBe(99);
    // ...while every other field still came from the persisted file.
    expect(service.get().panelVisible).toBe(true);
    expect(service.get().panelHeight).toBe(12);
    expect(service.get().activeView).toBe("explorer");
    expect(service.get().sidebarVisible).toBe(false);

    await service.flush();
    expect(writes).toHaveLength(1);
    const written = JSON.parse(writes[0]!.data) as LayoutState;
    expect(written.sidebarWidth).toBe(99);
    expect(written.panelVisible).toBe(true);
    expect(written.activeView).toBe("explorer");
  });
});

describe("createLayoutStateService — onDidChange (Issue #101)", () => {
  test("a registered listener is called synchronously on update()", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    let calls = 0;
    service.onDidChange(() => {
      calls += 1;
      // Synchronous: get() already reflects the new value by the time the
      // listener runs, with no microtask/timer in between.
      expect(service.get().panelVisible).toBe(true);
    });

    service.update({ panelVisible: true });
    expect(calls).toBe(1);
  });

  test("multiple listeners all fire", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    let firstCalls = 0;
    let secondCalls = 0;
    service.onDidChange(() => {
      firstCalls += 1;
    });
    service.onDidChange(() => {
      secondCalls += 1;
    });

    service.update({ sidebarWidth: 50 });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  test("a disposed listener stops firing; dispose() is idempotent", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    let calls = 0;
    const sub = service.onDidChange(() => {
      calls += 1;
    });

    service.update({ sidebarWidth: 1 });
    expect(calls).toBe(1);

    sub.dispose();
    service.update({ sidebarWidth: 2 });
    expect(calls).toBe(1); // no further calls once disposed

    // Idempotent — a second dispose() must not throw or double-remove
    // some other listener.
    expect(() => sub.dispose()).not.toThrow();
  });

  test("one listener throwing does not affect the others or the update() caller", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    let secondCalls = 0;
    service.onDidChange(() => {
      throw new Error("boom");
    });
    service.onDidChange(() => {
      secondCalls += 1;
    });

    expect(() => service.update({ sidebarWidth: 7 })).not.toThrow();
    expect(secondCalls).toBe(1);
    expect(log.entries().some((e) => e.level === "error" && e.error.message.includes("boom"))).toBe(true);
  });

  test("a no-op update (value unchanged) does not fire onDidChange", async () => {
    const { fs } = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createLayoutStateService({ log, sink, path: "/state.json", fs });
    await service.ready;

    let calls = 0;
    service.onDidChange(() => {
      calls += 1;
    });

    // DEFAULT_LAYOUT_STATE.panelVisible is already false.
    service.update({ panelVisible: false });
    expect(calls).toBe(0);

    service.update({ panelVisible: true });
    expect(calls).toBe(1);
  });
});
