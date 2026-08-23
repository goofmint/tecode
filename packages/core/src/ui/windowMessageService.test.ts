/**
 * `WindowMessageService` tests (Task 3.1, Req 10.1, `windowMessageService.
 * ts`'s TSDoc): `setStatusBarItem` registers against the real slot registry
 * with no component, `showMessage` reuses that same path, replaces a prior
 * message, and clears after the injected timeout.
 */

import { describe, expect, test } from "bun:test";
import { createSlotRegistry } from "./slotRegistry";
import {
  createWindowMessageService,
  WINDOW_MESSAGE_STATUS_BAR_ITEM_ID,
} from "./windowMessageService";

/** A fake timer scheduler — captures the callback so a test can fire it
 * manually instead of racing a real `setTimeout` (this module's own
 * injectable-timer-seam TSDoc). */
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

describe("WindowMessageService.setStatusBarItem", () => {
  test("registers into the real slot registry's statusBar.item slot with no component", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const service = createWindowMessageService({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    service.setStatusBarItem({ id: "ext.item", text: "hello", side: "right", priority: 5 });

    const [entry] = slotRegistry.getViews("statusBar.item");
    expect(entry?.title).toBe("hello");
    expect(entry?.component).toBeUndefined();
    expect(entry?.statusBar).toEqual({ side: "right", priority: 5 });
  });

  test("the returned Disposable removes the entry, idempotently", () => {
    const slotRegistry = createSlotRegistry();
    const service = createWindowMessageService({ slotRegistry });
    const disposable = service.setStatusBarItem({ id: "x", text: "t", side: "left", priority: 0 });

    expect(slotRegistry.getViews("statusBar.item").length).toBe(1);
    disposable.dispose();
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe("WindowMessageService.showMessage", () => {
  test("registers a statusBar.item under the well-known message id", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const service = createWindowMessageService({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    service.showMessage("Saved.", "info");

    const entry = slotRegistry.getView("statusBar.item", WINDOW_MESSAGE_STATUS_BAR_ITEM_ID);
    expect(entry?.title).toContain("Saved.");
  });

  test("kind changes the rendered glyph prefix", () => {
    const slotRegistry = createSlotRegistry();
    const service = createWindowMessageService({ slotRegistry, setTimeout: () => 0, clearTimeout: () => {} });

    service.showMessage("Oops", "error");
    expect(slotRegistry.getView("statusBar.item", WINDOW_MESSAGE_STATUS_BAR_ITEM_ID)?.title).toBe("✖ Oops");

    service.showMessage("Careful", "warning");
    expect(slotRegistry.getView("statusBar.item", WINDOW_MESSAGE_STATUS_BAR_ITEM_ID)?.title).toBe("⚠ Careful");
  });

  test("a second showMessage call replaces the first rather than stacking", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const service = createWindowMessageService({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    service.showMessage("First");
    service.showMessage("Second");

    expect(slotRegistry.getViews("statusBar.item").length).toBe(1);
    expect(slotRegistry.getView("statusBar.item", WINDOW_MESSAGE_STATUS_BAR_ITEM_ID)?.title).toBe("Second");
    // The first message's own timer was cancelled when the second replaced it.
    expect(timer.cleared.length).toBe(1);
  });

  test("the message clears itself once the injected timeout fires", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const service = createWindowMessageService({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    service.showMessage("Transient");
    expect(slotRegistry.getViews("statusBar.item").length).toBe(1);

    timer.fire();
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
  });

  test("dispose clears a pending message immediately", () => {
    const slotRegistry = createSlotRegistry();
    const timer = createFakeTimer();
    const service = createWindowMessageService({
      slotRegistry,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    service.showMessage("Bye");
    service.dispose();
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
    expect(() => service.dispose()).not.toThrow();
  });
});
