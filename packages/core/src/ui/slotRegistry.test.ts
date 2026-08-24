import { describe, expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import type { PendingViewContribution } from "../host/registration";
import { createSlotRegistry } from "./slotRegistry";

function warnings(log: ReturnType<typeof createHostLog>): HostError[] {
  return log
    .entries()
    .filter((e) => e.level === "warning")
    .map((e) => e.error);
}

const noopComponent = () => undefined;

describe("createSlotRegistry — registerView/getViews (Req 6.2, 6.3)", () => {
  test("register/dispose symmetry: a disposed view is gone from getViews", () => {
    const registry = createSlotRegistry();
    const sub = registry.registerView("sidebar.view", "demo.view", noopComponent);

    expect(registry.getViews("sidebar.view").map((v) => v.id)).toEqual(["demo.view"]);
    expect(registry.getView("sidebar.view", "demo.view")?.component).toBe(noopComponent);

    sub.dispose();
    expect(registry.getViews("sidebar.view")).toEqual([]);
    expect(registry.getView("sidebar.view", "demo.view")).toBeUndefined();

    // Idempotent.
    expect(() => sub.dispose()).not.toThrow();
  });

  test("dispose is a no-op if a later registration has already superseded it (identity-checked)", () => {
    const registry = createSlotRegistry();
    const first = registry.registerView("sidebar.view", "demo.view", noopComponent);
    const secondComponent = () => "second";
    registry.registerView("sidebar.view", "demo.view", secondComponent);

    first.dispose();

    // The second registration is still present — first.dispose() only
    // removes itself if it is still the current entry.
    expect(registry.getView("sidebar.view", "demo.view")?.component).toBe(secondComponent);
  });

  test("last-wins on a duplicate (slot, id): the newer component wins and a warning is logged", () => {
    const log = createHostLog();
    const registry = createSlotRegistry({ log });
    const first = () => "first";
    const second = () => "second";

    registry.registerView("panel.tab", "demo.tab", first);
    registry.registerView("panel.tab", "demo.tab", second);

    expect(registry.getView("panel.tab", "demo.tab")?.component).toBe(second);
    expect(warnings(log).some((e) => e.message.includes("demo.tab"))).toBe(true);
  });

  test("getViews preserves registration order", () => {
    const registry = createSlotRegistry();
    registry.registerView("activityBar.item", "a", noopComponent);
    registry.registerView("activityBar.item", "b", noopComponent);
    registry.registerView("activityBar.item", "c", noopComponent);

    expect(registry.getViews("activityBar.item").map((v) => v.id)).toEqual(["a", "b", "c"]);
  });

  test("registerView accepts optional title/icon metadata", () => {
    const registry = createSlotRegistry();
    registry.registerView("sidebar.view", "demo.view", noopComponent, {
      title: "Demo",
      icon: "★",
    });

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.title).toBe("Demo");
    expect(entry?.icon).toBe("★");
  });
});

describe("createSlotRegistry — onDidChange (Req 6.2, 6.3)", () => {
  test("fires with the changed slot on register and on dispose", () => {
    const registry = createSlotRegistry();
    const events: string[] = [];
    registry.onDidChange((slot) => events.push(slot));

    const sub = registry.registerView("panel.tab", "demo.tab", noopComponent);
    expect(events).toEqual(["panel.tab"]);

    sub.dispose();
    expect(events).toEqual(["panel.tab", "panel.tab"]);
  });

  test("a disposed listener does not fire again; other listeners are unaffected", () => {
    const registry = createSlotRegistry();
    const events: string[] = [];
    const sub = registry.onDidChange(() => events.push("first"));
    registry.onDidChange(() => events.push("second"));

    sub.dispose();
    registry.registerView("panel.tab", "x", noopComponent);

    expect(events).toEqual(["second"]);
  });

  test("a throwing listener does not stop other listeners or propagate", () => {
    const registry = createSlotRegistry();
    const events: string[] = [];
    registry.onDidChange(() => {
      throw new Error("boom");
    });
    registry.onDidChange(() => events.push("still ran"));

    expect(() => registry.registerView("panel.tab", "x", noopComponent)).not.toThrow();
    expect(events).toEqual(["still ran"]);
  });
});

describe("createSlotRegistry — lazy views from pendingViews (Req 2.5, 6.2, design.md §8.2)", () => {
  function pendingSidebarView(overrides: Partial<PendingViewContribution["view"]> = {}) {
    const pending: PendingViewContribution = {
      extensionId: "demo.ext",
      view: { id: "demo.view", title: "Demo", slot: "sidebar", icon: "★", ...overrides },
    };
    return pending;
  }

  test("a pending sidebar view seeds a lazy sidebar.view entry with no component", () => {
    const registry = createSlotRegistry({ pendingViews: [pendingSidebarView()] });

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.lazy).toBe(true);
    expect(entry?.component).toBeUndefined();
    expect(entry?.extensionId).toBe("demo.ext");
    expect(entry?.title).toBe("Demo");
    expect(entry?.icon).toBe("★");
  });

  test("a pending sidebar view also synthesizes an activityBar.item entry immediately (Req 6.2)", () => {
    const registry = createSlotRegistry({ pendingViews: [pendingSidebarView()] });

    const item = registry.getView("activityBar.item", "demo.view");
    // `lazy: true` — a placeholder, not a real registration (this entry's
    // `component` is always undefined at this point); ActivityBar renders
    // on `component` presence, not `lazy` (shell.tsx), so this has no
    // rendering effect, but it matters for `storeEntry`'s duplicate-
    // registration warning: see the "no spurious warning" test below.
    expect(item?.lazy).toBe(true);
    expect(item?.title).toBe("Demo");
    expect(item?.icon).toBe("★");
  });

  test("a pending panel view seeds a lazy panel.tab entry and no activityBar.item", () => {
    const registry = createSlotRegistry({
      pendingViews: [
        { extensionId: "demo.ext", view: { id: "demo.panel", title: "Demo Panel", slot: "panel" } },
      ],
    });

    expect(registry.getView("panel.tab", "demo.panel")?.lazy).toBe(true);
    expect(registry.getView("activityBar.item", "demo.panel")).toBeUndefined();
  });

  test("a real registerView call for the same id resolves the lazy entry (last-wins, no duplicate warning)", () => {
    const log = createHostLog();
    const registry = createSlotRegistry({ pendingViews: [pendingSidebarView()], log });

    const realComponent = () => "real";
    registry.registerView("sidebar.view", "demo.view", realComponent);

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.lazy).toBe(false);
    expect(entry?.component).toBe(realComponent);
    // Resolving a lazy placeholder is the expected activation flow, not a
    // collision — no warning should be logged for it.
    expect(warnings(log)).toEqual([]);
  });

  test("a real registerView call for the synthesized activityBar.item placeholder logs no spurious warning", () => {
    // Regression test: the synthesized activityBar.item placeholder is
    // `lazy: true` (not a real registration), so an extension's later, real
    // `registerView("activityBar.item", id, ...)` call must resolve it
    // exactly like any other lazy entry — not trip `storeEntry`'s
    // duplicate-registration warning, which only fires against a non-lazy
    // existing entry.
    const log = createHostLog();
    const registry = createSlotRegistry({ pendingViews: [pendingSidebarView()], log });

    const realComponent = () => "real icon";
    registry.registerView("activityBar.item", "demo.view", realComponent);

    const entry = registry.getView("activityBar.item", "demo.view");
    expect(entry?.lazy).toBe(false);
    expect(entry?.component).toBe(realComponent);
    expect(warnings(log)).toEqual([]);
  });

  test("requestActivation calls activateExtension for a lazy, unresolved view exactly once until it resolves", async () => {
    const calls: string[] = [];
    let resolveActivation: () => void = () => {};
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const registry = createSlotRegistry({
      pendingViews: [pendingSidebarView()],
      activateExtension: async (id) => {
        calls.push(id);
        await activation;
      },
    });

    registry.requestActivation("sidebar.view", "demo.view");
    registry.requestActivation("sidebar.view", "demo.view"); // still in flight — must not double-call
    expect(calls).toEqual(["demo.ext"]);

    resolveActivation();
    await activation;
    // Let the in-flight promise's .finally() run.
    await Promise.resolve();
    await Promise.resolve();

    registry.registerView("sidebar.view", "demo.view", noopComponent);
    registry.requestActivation("sidebar.view", "demo.view"); // now resolved — must not call again
    expect(calls).toEqual(["demo.ext"]);
  });

  test("a rejected activation is logged, and a later requestActivation for the same view retries", async () => {
    const log = createHostLog();
    const calls: string[] = [];
    let attempt = 0;
    const registry = createSlotRegistry({
      pendingViews: [pendingSidebarView()],
      log,
      activateExtension: async (id) => {
        calls.push(id);
        attempt += 1;
        if (attempt === 1) throw new Error("activation boom");
      },
    });

    registry.requestActivation("sidebar.view", "demo.view");
    expect(calls).toEqual(["demo.ext"]);

    // Let the rejected promise's .catch()/.finally() run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      log
        .entries()
        .some((e) => e.level === "error" && e.error.message.includes("activation boom")),
    ).toBe(true);

    // The failed attempt must not leave the view stuck — a later
    // requestActivation for the same still-unresolved view retries.
    registry.requestActivation("sidebar.view", "demo.view");
    expect(calls).toEqual(["demo.ext", "demo.ext"]);
  });

  test("requestActivation never throws and is a no-op with no activateExtension wired", () => {
    const registry = createSlotRegistry({ pendingViews: [pendingSidebarView()] });
    expect(() => registry.requestActivation("sidebar.view", "demo.view")).not.toThrow();
  });

  test("requestActivation is a no-op for an entry that already has a component", () => {
    let calls = 0;
    const registry = createSlotRegistry({
      activateExtension: async () => {
        calls += 1;
      },
    });
    registry.registerView("sidebar.view", "demo.view", noopComponent);
    registry.requestActivation("sidebar.view", "demo.view");
    expect(calls).toBe(0);
  });

  test("requestActivation is a no-op for an unknown (slot, id)", () => {
    const registry = createSlotRegistry();
    expect(() => registry.requestActivation("sidebar.view", "nope")).not.toThrow();
  });
});

describe("createSlotRegistry — seedPendingViews (Req 2.1, 2.5, 6.2, design.md §3, §8.2)", () => {
  function pendingSidebarView(overrides: Partial<PendingViewContribution["view"]> = {}) {
    const pending: PendingViewContribution = {
      extensionId: "demo.ext",
      view: { id: "demo.view", title: "Demo", slot: "sidebar", icon: "★", ...overrides },
    };
    return pending;
  }

  test("seeds a lazy sidebar.view entry, with no component, exactly like the constructor's pendingViews", () => {
    const registry = createSlotRegistry();
    registry.seedPendingViews([pendingSidebarView()]);

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.lazy).toBe(true);
    expect(entry?.component).toBeUndefined();
    expect(entry?.extensionId).toBe("demo.ext");
    expect(entry?.title).toBe("Demo");
    expect(entry?.icon).toBe("★");
  });

  test("a seeded sidebar view also synthesizes an activityBar.item placeholder (Req 6.2)", () => {
    const registry = createSlotRegistry();
    registry.seedPendingViews([pendingSidebarView()]);

    const item = registry.getView("activityBar.item", "demo.view");
    expect(item?.lazy).toBe(true);
    expect(item?.title).toBe("Demo");
    expect(item?.icon).toBe("★");
  });

  test("requestActivation calls activateExtension for a view seeded after construction", async () => {
    const calls: string[] = [];
    const registry = createSlotRegistry({
      activateExtension: async (id) => {
        calls.push(id);
      },
    });
    registry.seedPendingViews([pendingSidebarView()]);

    registry.requestActivation("sidebar.view", "demo.view");
    expect(calls).toEqual(["demo.ext"]);
  });

  test("a later real registerView completes the seeded entry in place, with no spurious re-registered warning", () => {
    const log = createHostLog();
    const registry = createSlotRegistry({ log });
    registry.seedPendingViews([pendingSidebarView()]);

    const realComponent = () => "real";
    registry.registerView("sidebar.view", "demo.view", realComponent);

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.lazy).toBe(false);
    expect(entry?.component).toBe(realComponent);
    // Same non-collision contract as a construction-time pendingViews
    // seed (the describe block above) — resolving a lazy placeholder is
    // the expected activation flow, not a duplicate registration.
    expect(warnings(log)).toEqual([]);

    // The synthesized activityBar.item placeholder resolves the same way.
    registry.registerView("activityBar.item", "demo.view", realComponent);
    const item = registry.getView("activityBar.item", "demo.view");
    expect(item?.lazy).toBe(false);
    expect(warnings(log)).toEqual([]);
  });

  test("onDidChange fires for the slot a seeded view lands in", () => {
    const registry = createSlotRegistry();
    const changed: string[] = [];
    registry.onDidChange((slot) => changed.push(slot));

    registry.seedPendingViews([pendingSidebarView()]);

    expect(changed).toContain("sidebar.view");
    expect(changed).toContain("activityBar.item");
  });

  test("re-seeding after a real registration does not regress it back to a lazy placeholder", () => {
    const registry = createSlotRegistry();
    const realComponent = () => "real";
    registry.registerView("sidebar.view", "demo.view", realComponent);

    // A later seedPendingViews call for the same (slot, id) — e.g. a
    // second discovery pass — must not clobber the already-active real
    // registration back to lazy/no-component (SlotRegistry.
    // seedPendingViews's TSDoc).
    registry.seedPendingViews([pendingSidebarView()]);

    const entry = registry.getView("sidebar.view", "demo.view");
    expect(entry?.lazy).toBe(false);
    expect(entry?.component).toBe(realComponent);
  });

  test("seedPendingViews with an empty array is a safe no-op", () => {
    const registry = createSlotRegistry();
    expect(() => registry.seedPendingViews([])).not.toThrow();
    expect(registry.getViews("sidebar.view")).toEqual([]);
  });
});

describe("createSlotRegistry — activityBar/sidebar pairing (Req 6.2)", () => {
  test("listSidebarPairs unions ids from both slots, matched by id", () => {
    const registry = createSlotRegistry();
    registry.registerView("activityBar.item", "explorer", noopComponent);
    registry.registerView("sidebar.view", "explorer", noopComponent);
    registry.registerView("activityBar.item", "search", noopComponent); // no sidebar view yet

    const pairs = registry.listSidebarPairs();
    const byId = new Map(pairs.map((p) => [p.id, p]));

    expect(byId.get("explorer")?.activityItem).toBeDefined();
    expect(byId.get("explorer")?.sidebarView).toBeDefined();
    expect(byId.get("search")?.activityItem).toBeDefined();
    expect(byId.get("search")?.sidebarView).toBeUndefined();
  });

  test("a pending sidebar view is paired immediately even before activation", () => {
    const registry = createSlotRegistry({
      pendingViews: [
        {
          extensionId: "demo.ext",
          view: { id: "demo.view", title: "Demo", slot: "sidebar" },
        },
      ],
    });

    const pair = registry.listSidebarPairs().find((p) => p.id === "demo.view");
    expect(pair?.activityItem).toBeDefined();
    expect(pair?.sidebarView?.lazy).toBe(true);
  });
});

describe("createSlotRegistry — statusBar.item sides/priorities (design.md §8.2)", () => {
  test("listStatusBarItems sorts left before right, then by descending priority", () => {
    const registry = createSlotRegistry();
    registry.registerView("statusBar.item", "right-low", noopComponent, {
      statusBar: { side: "right", priority: 1 },
    });
    registry.registerView("statusBar.item", "left-high", noopComponent, {
      statusBar: { side: "left", priority: 10 },
    });
    registry.registerView("statusBar.item", "left-low", noopComponent, {
      statusBar: { side: "left", priority: 1 },
    });
    registry.registerView("statusBar.item", "right-high", noopComponent, {
      statusBar: { side: "right", priority: 10 },
    });

    expect(registry.listStatusBarItems().map((e) => e.id)).toEqual([
      "left-high",
      "left-low",
      "right-high",
      "right-low",
    ]);
  });

  test("ties break by registration order", () => {
    const registry = createSlotRegistry();
    registry.registerView("statusBar.item", "first", noopComponent, {
      statusBar: { side: "left", priority: 0 },
    });
    registry.registerView("statusBar.item", "second", noopComponent, {
      statusBar: { side: "left", priority: 0 },
    });

    expect(registry.listStatusBarItems().map((e) => e.id)).toEqual(["first", "second"]);
  });

  test("a plain registerView call with no meta defaults to { side: 'left', priority: 0 }", () => {
    const registry = createSlotRegistry();
    registry.registerView("statusBar.item", "plain", noopComponent);

    expect(registry.getView("statusBar.item", "plain")?.statusBar).toEqual({
      side: "left",
      priority: 0,
    });
  });
});
