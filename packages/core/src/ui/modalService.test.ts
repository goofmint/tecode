/**
 * `ModalService` tests (Task 3.1, Req 10.1, `modalService.ts`'s TSDoc):
 * filtering, accept/cancel resolution, wrap-around navigation, input-box
 * validation, and the "opening supersedes an already-open modal" contract.
 */

import { describe, expect, test } from "bun:test";
import type { QuickPickItem } from "@tecode/api";
import { createModalService, filterQuickPickItems } from "./modalService";

const ITEMS: QuickPickItem[] = [
  { label: "Alpha", description: "first" },
  { label: "Beta", detail: "second item" },
  { label: "Gamma", description: "third", detail: "final" },
];

describe("filterQuickPickItems (pure)", () => {
  test("an empty query matches every item", () => {
    expect(filterQuickPickItems(ITEMS, "")).toEqual(ITEMS);
  });

  test("matches case-insensitively against label", () => {
    expect(filterQuickPickItems(ITEMS, "alpha").map((i) => i.label)).toEqual(["Alpha"]);
  });

  test("matches against description", () => {
    expect(filterQuickPickItems(ITEMS, "third").map((i) => i.label)).toEqual(["Gamma"]);
  });

  test("matches against detail", () => {
    expect(filterQuickPickItems(ITEMS, "second").map((i) => i.label)).toEqual(["Beta"]);
  });

  test("no match narrows to an empty list", () => {
    expect(filterQuickPickItems(ITEMS, "zzz")).toEqual([]);
  });
});

describe("ModalService — quick pick", () => {
  test("getState reports the open quick pick with every item visible", () => {
    const service = createModalService();
    void service.openQuickPick(ITEMS);
    const state = service.getState();
    expect(state.mode).toBe("quickPick");
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.items).toEqual(ITEMS);
    expect(state.activeIndex).toBe(0);
  });

  test("setFilter narrows getState().items and re-clamps activeIndex", () => {
    const service = createModalService();
    void service.openQuickPick(ITEMS);
    service.selectNext();
    service.selectNext(); // activeIndex now 2 (Gamma) against the unfiltered list
    service.setFilter("beta");

    const state = service.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.items.map((i) => i.label)).toEqual(["Beta"]);
    // Only one item is visible now — the raw index (2) clamps down to it.
    expect(state.activeIndex).toBe(0);
  });

  test("accept resolves the active FILTERED item", async () => {
    const service = createModalService();
    const pending = service.openQuickPick(ITEMS);
    service.setFilter("gamma");
    service.accept();
    expect(await pending).toEqual(ITEMS[2]);
  });

  test("accept resolves undefined when filtering leaves nothing visible", async () => {
    const service = createModalService();
    const pending = service.openQuickPick(ITEMS);
    service.setFilter("nothing matches this");
    service.accept();
    expect(await pending).toBeUndefined();
  });

  test("cancel (escape) resolves undefined and closes the modal", async () => {
    const service = createModalService();
    const pending = service.openQuickPick(ITEMS);
    service.cancel();
    expect(await pending).toBeUndefined();
    expect(service.getState().mode).toBeNull();
  });

  test("selectNext/selectPrevious wrap around the filtered list", () => {
    const service = createModalService();
    void service.openQuickPick(ITEMS);

    service.selectPrevious(); // wraps from 0 to the last item
    let state = service.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.activeIndex).toBe(ITEMS.length - 1);

    service.selectNext(); // wraps back to the first item
    state = service.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.activeIndex).toBe(0);
  });

  test("selectNext/selectPrevious are no-ops when the filtered list is empty", () => {
    const service = createModalService();
    void service.openQuickPick(ITEMS);
    service.setFilter("zzz");
    expect(() => service.selectNext()).not.toThrow();
    expect(() => service.selectPrevious()).not.toThrow();
    const state = service.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.activeIndex).toBe(-1);
  });

  test("opening a new quick pick while one is open cancels the previous one", async () => {
    const service = createModalService();
    const first = service.openQuickPick(ITEMS);
    const second = service.openQuickPick([{ label: "Only" }]);

    expect(await first).toBeUndefined();
    service.accept();
    expect(await second).toEqual({ label: "Only" });
  });
});

describe("ModalService — input box", () => {
  test("getState reports the open input box, seeded from options.value", () => {
    const service = createModalService();
    void service.openInputBox({ value: "seed" });
    const state = service.getState();
    expect(state.mode).toBe("inputBox");
    if (state.mode !== "inputBox") throw new Error("unreachable");
    expect(state.value).toBe("seed");
    expect(state.validationMessage).toBeUndefined();
  });

  test("accept resolves the current value", async () => {
    const service = createModalService();
    const pending = service.openInputBox();
    service.setInputValue("hello");
    service.accept();
    expect(await pending).toBe("hello");
  });

  test("cancel (escape) resolves undefined", async () => {
    const service = createModalService();
    const pending = service.openInputBox({ value: "abc" });
    service.cancel();
    expect(await pending).toBeUndefined();
  });

  test("validateInput blocks accept while it reports an error", async () => {
    const service = createModalService();
    const pending = service.openInputBox({
      validateInput: (value) => (value.length === 0 ? "Required" : undefined),
    });

    service.accept(); // still empty — validation fails, modal stays open
    expect(service.getState().mode).toBe("inputBox");

    service.setInputValue("ok");
    const state = service.getState();
    if (state.mode !== "inputBox") throw new Error("unreachable");
    expect(state.validationMessage).toBeUndefined();

    service.accept();
    expect(await pending).toBe("ok");
  });

  test("a throwing validateInput is treated as valid rather than breaking the modal", async () => {
    const service = createModalService();
    const pending = service.openInputBox({
      validateInput: () => {
        throw new Error("boom");
      },
    });
    expect(service.getState().mode).toBe("inputBox");
    service.accept();
    expect(await pending).toBe("");
  });
});

describe("ModalService — onDidChange / dispose", () => {
  test("onDidChange fires on open, filter, select, accept, and cancel", () => {
    const service = createModalService();
    let fireCount = 0;
    service.onDidChange(() => {
      fireCount += 1;
    });

    void service.openQuickPick(ITEMS);
    expect(fireCount).toBe(1);
    service.setFilter("a");
    expect(fireCount).toBe(2);
    service.selectNext();
    expect(fireCount).toBe(3);
    service.accept();
    expect(fireCount).toBe(4);
  });

  test("a throwing listener does not stop other listeners", () => {
    const service = createModalService();
    let secondCalled = false;
    service.onDidChange(() => {
      throw new Error("boom");
    });
    service.onDidChange(() => {
      secondCalled = true;
    });
    expect(() => void service.openQuickPick(ITEMS)).not.toThrow();
    expect(secondCalled).toBe(true);
  });

  test("dispose cancels a pending modal and clears listeners", async () => {
    const service = createModalService();
    const pending = service.openQuickPick(ITEMS);
    let fired = false;
    service.onDidChange(() => {
      fired = true;
    });
    fired = false; // reset after the open's own initial fire

    service.dispose();
    expect(await pending).toBeUndefined();
    expect(fired).toBe(true);

    fired = false;
    service.dispose(); // idempotent — no throw, no further listener calls (already cleared)
    expect(fired).toBe(false);
  });
});
