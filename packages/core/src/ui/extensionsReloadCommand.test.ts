/**
 * Tests for {@link createExtensionsReloadHandler}/
 * {@link registerExtensionsReloadCommand} (Req 2.8, design.md §4.4).
 *
 * Never spawns a real subprocess: `reExec` is always a hand-rolled fake
 * that records it was called instead of actually re-execing the test
 * runner (matches this module's own TSDoc: "the real `Bun.spawn(...)` +
 * `process.exit(0)` closure is `main.ts`'s composition-root job"). The
 * "layout state is persisted before reload" case wires a REAL
 * {@link createLayoutStateService} against a fake {@link LayoutStateFs} —
 * matching `layoutState.test.ts`'s own `createFakeFs` — so the flush
 * actually reaches a (fake) file, proving this command drives the real
 * service's real persistence path rather than a hand-rolled `flush`
 * double.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createLayoutStateService, type LayoutStateFs } from "./layoutState";
import {
  createExtensionsReloadHandler,
  EXTENSIONS_RELOAD_COMMAND_ID,
  registerExtensionsReloadCommand,
} from "./extensionsReloadCommand";

/** A `StatusSink`-free recording log (matches every other `ui/*` test's
 * `createHostLog()` + entry filtering). */
function errorMessages(log: ReturnType<typeof createHostLog>): string[] {
  return log
    .entries()
    .filter((e) => e.level === "error")
    .map((e) => e.error.message);
}

/** An in-memory {@link LayoutStateFs} (matches `layoutState.test.ts`'s own
 * `createFakeFs`): `writeFile` records every write so this suite can
 * assert the layout-state service's flush genuinely reached disk (through
 * the fake) before `reExec` runs. */
function createFakeLayoutFs(): { fs: LayoutStateFs; writes(): { path: string; data: string }[] } {
  const files = new Map<string, string>();
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
  };
}

describe("createExtensionsReloadHandler (Req 2.8)", () => {
  test("flushes layout state, THEN calls reExec exactly once, in that order", async () => {
    const order: string[] = [];
    const layoutState = {
      flush: async () => {
        order.push("flush");
      },
    };
    let reExecCalls = 0;
    const reExec = () => {
      reExecCalls += 1;
      order.push("reExec");
    };

    const handler = createExtensionsReloadHandler({ layoutState, reExec });
    await handler();

    expect(order).toEqual(["flush", "reExec"]);
    expect(reExecCalls).toBe(1);
  });

  test("persists real layout state through a real LayoutStateService before reExec runs", async () => {
    const { fs, writes } = createFakeLayoutFs();
    const log = createHostLog();
    const sink = { error() {} };
    const layoutState = createLayoutStateService({ log, sink, path: "/state.json", fs, debounceMs: 10_000 });
    await layoutState.ready;

    // A change that has NOT reached the debounced write yet (debounceMs is
    // 10s, well beyond this test's lifetime) — proves `flush()` (not the
    // debounce timer) is what gets this to disk before reload.
    layoutState.update({ sidebarWidth: 42 });
    expect(writes()).toEqual([]);

    let reExecCalled = false;
    const handler = createExtensionsReloadHandler({
      layoutState,
      reExec: () => {
        reExecCalled = true;
      },
    });
    await handler();

    expect(reExecCalled).toBe(true);
    expect(writes().length).toBeGreaterThan(0);
    const lastWrite = writes().at(-1)!;
    expect(lastWrite.path).toBe("/state.json");
    expect(JSON.parse(lastWrite.data).sidebarWidth).toBe(42);
  });

  test("a flush() rejection is logged as an error and reExec is NOT called", async () => {
    const log = createHostLog();
    const layoutState = {
      flush: () => Promise.reject(new Error("disk full")),
    };
    let reExecCalls = 0;
    const handler = createExtensionsReloadHandler({
      layoutState,
      reExec: () => {
        reExecCalls += 1;
      },
      log,
    });

    await handler();

    expect(reExecCalls).toBe(0);
    expect(errorMessages(log).some((m) => m.includes("flush failed") && m.includes("disk full"))).toBe(true);
  });

  test("a throwing flush() is treated the same as a rejection: logged, reExec not called, handler does not throw", async () => {
    const log = createHostLog();
    const layoutState = {
      flush: () => {
        throw new Error("synchronous boom");
      },
    };
    let reExecCalls = 0;
    const handler = createExtensionsReloadHandler({
      layoutState,
      reExec: () => {
        reExecCalls += 1;
      },
      log,
    });

    await expect(handler()).resolves.toBeUndefined();
    expect(reExecCalls).toBe(0);
    expect(errorMessages(log).some((m) => m.includes("synchronous boom"))).toBe(true);
  });

  test("a throwing reExec is caught, logged, and does not propagate", async () => {
    const log = createHostLog();
    const layoutState = { flush: async () => {} };
    const handler = createExtensionsReloadHandler({
      layoutState,
      reExec: () => {
        throw new Error("spawn failed");
      },
      log,
    });

    await expect(handler()).resolves.toBeUndefined();
    expect(errorMessages(log).some((m) => m.includes("reExec failed") && m.includes("spawn failed"))).toBe(
      true,
    );
  });

  test("never throws even with no log wired", async () => {
    const layoutState = { flush: () => Promise.reject(new Error("boom")) };
    const handler = createExtensionsReloadHandler({ layoutState, reExec: () => {} });
    await expect(handler()).resolves.toBeUndefined();
  });
});

describe("registerExtensionsReloadCommand (Req 2.8)", () => {
  test("registers under extensions.reload with a palette title/category", () => {
    const registered: { id: string; meta?: { title?: string; category?: string } }[] = [];
    const commands = {
      registerCore(id: string, _handler: unknown, meta?: { title?: string; category?: string }) {
        registered.push({ id, meta });
        return { dispose() {} };
      },
    };

    registerExtensionsReloadCommand(commands, {
      layoutState: { flush: async () => {} },
      reExec: () => {},
    });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(EXTENSIONS_RELOAD_COMMAND_ID);
    expect(registered[0]?.meta?.title).toBe("Reload Window");
    expect(registered[0]?.meta?.category).toBe("Extensions");
  });

  test("the registered handler drives flush -> reExec end to end", async () => {
    const order: string[] = [];
    let disposeCalled = false;
    const registered: Record<string, (...args: unknown[]) => unknown> = {};
    const commands = {
      registerCore(id: string, handler: (...args: unknown[]) => unknown) {
        registered[id] = handler;
        return {
          dispose() {
            disposeCalled = true;
          },
        };
      },
    };

    const sub = registerExtensionsReloadCommand(commands, {
      layoutState: {
        flush: async () => {
          order.push("flush");
        },
      },
      reExec: () => order.push("reExec"),
    });

    expect(registered[EXTENSIONS_RELOAD_COMMAND_ID]).toBeDefined();
    await registered[EXTENSIONS_RELOAD_COMMAND_ID]!();
    expect(order).toEqual(["flush", "reExec"]);

    sub.dispose();
    expect(disposeCalled).toBe(true);
  });
});

