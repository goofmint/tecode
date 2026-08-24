/**
 * `HostErrorStatusSink` tests (Task 3.4, Req 11.6, `hostErrorSink.ts`'s
 * TSDoc): `error()` registers against the real slot registry with no
 * component, a new error replaces the previous one, and it auto-clears
 * after the injected timeout — mirrors `windowMessageService.test.ts`'s
 * own structure/fake-timer for the analogous `showMessage` mechanics.
 */

import { describe, expect, test } from "bun:test";
import { createSlotRegistry } from "./slotRegistry";
import {
  createHostErrorStatusSink,
  DEFAULT_HOST_ERROR_TIMEOUT_MS,
  HOST_ERROR_STATUS_BAR_ITEM_ID,
  HOST_ERROR_STATUS_BAR_PRIORITY,
} from "./hostErrorSink";

/** A fake timer scheduler (matches `windowMessageService.test.ts`'s own). */
function createFakeTimer(): {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  fire: () => void;
  scheduledMs: number[];
  cleared: unknown[];
} {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  const scheduledMs: number[] = [];
  const cleared: unknown[] = [];
  return {
    setTimeout: (callback, ms) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      scheduledMs.push(ms);
      return handle;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
      pending.delete(handle as number);
    },
    fire: () => {
      for (const callback of Array.from(pending.values())) callback();
      pending.clear();
    },
    scheduledMs,
    cleared,
  };
}

describe("createHostErrorStatusSink", () => {
  test("error() registers into the real slot registry's statusBar.item slot with no component, high left priority", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const sink = createHostErrorStatusSink({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    sink.error({ message: "Unknown command: foo.bar" });

    const entry = slotRegistry.getView("statusBar.item", HOST_ERROR_STATUS_BAR_ITEM_ID);
    expect(entry?.title).toBe("✖ Unknown command: foo.bar");
    expect(entry?.component).toBeUndefined();
    expect(entry?.statusBar).toEqual({ side: "left", priority: HOST_ERROR_STATUS_BAR_PRIORITY });
    expect(timer.scheduledMs).toEqual([DEFAULT_HOST_ERROR_TIMEOUT_MS]);
  });

  test("extensionId is prefixed into the rendered text when present", () => {
    const slotRegistry = createSlotRegistry();
    const sink = createHostErrorStatusSink({ slotRegistry, setTimeout: () => 0, clearTimeout: () => {} });

    sink.error({ extensionId: "demo.ext", message: "manifest invalid" });

    expect(slotRegistry.getView("statusBar.item", HOST_ERROR_STATUS_BAR_ITEM_ID)?.title).toBe(
      "✖ [demo.ext] manifest invalid",
    );
  });

  test("a second error() replaces the first rather than stacking, cancelling the first's timer", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const sink = createHostErrorStatusSink({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    sink.error({ message: "First failure" });
    sink.error({ message: "Second failure" });

    expect(slotRegistry.getViews("statusBar.item").length).toBe(1);
    expect(slotRegistry.getView("statusBar.item", HOST_ERROR_STATUS_BAR_ITEM_ID)?.title).toBe("✖ Second failure");
    expect(timer.cleared.length).toBe(1);
  });

  test("the notice clears itself once the injected timeout fires", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const sink = createHostErrorStatusSink({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    sink.error({ message: "Transient" });
    expect(slotRegistry.getViews("statusBar.item").length).toBe(1);

    timer.fire();
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
  });

  test("dispose clears a pending error immediately and is idempotent", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const sink = createHostErrorStatusSink({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    sink.error({ message: "Bye" });
    sink.dispose();
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
    expect(() => sink.dispose()).not.toThrow();
  });

  test("a custom timeoutMs overrides the default", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const sink = createHostErrorStatusSink({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      timeoutMs: 1234,
    });

    sink.error({ message: "x" });
    expect(timer.scheduledMs).toEqual([1234]);
  });
});
