/**
 * Tests for {@link createToggleSidebarVisibilityCommandHandler}/{@link
 * registerSidebarVisibilityCommand} (Issue #135) against a fake
 * `layoutState` narrowed to exactly the two methods
 * `ToggleSidebarVisibilityCommandDeps` declares — matches
 * `panelCommands.test.ts`'s own "no real service needed" shape.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT_STATE, type LayoutState } from "./layoutState";
import {
  createToggleSidebarVisibilityCommandHandler,
  registerSidebarVisibilityCommand,
  TOGGLE_SIDEBAR_VISIBILITY_COMMAND_ID,
  type ToggleSidebarVisibilityCommandDeps,
} from "./sidebarVisibilityCommands";

function createFakeLayoutState(
  sidebarVisible: boolean,
): ToggleSidebarVisibilityCommandDeps["layoutState"] & {
  updates: Partial<LayoutState>[];
} {
  const updates: Partial<LayoutState>[] = [];
  let state: LayoutState = { ...DEFAULT_LAYOUT_STATE, sidebarVisible };
  return {
    updates,
    get() {
      return state;
    },
    update(partial) {
      updates.push(partial);
      state = { ...state, ...partial };
    },
  };
}

describe("createToggleSidebarVisibilityCommandHandler", () => {
  test("visible -> hidden: reads the current value and writes its negation", async () => {
    const layoutState = createFakeLayoutState(true);
    const handler = createToggleSidebarVisibilityCommandHandler({ layoutState });

    await handler();

    expect(layoutState.updates).toEqual([{ sidebarVisible: false }]);
  });

  test("hidden -> visible: reads the current value and writes its negation", async () => {
    const layoutState = createFakeLayoutState(false);
    const handler = createToggleSidebarVisibilityCommandHandler({ layoutState });

    await handler();

    expect(layoutState.updates).toEqual([{ sidebarVisible: true }]);
  });

  test("calling the handler twice flips twice, back to the original value", async () => {
    const layoutState = createFakeLayoutState(true);
    const handler = createToggleSidebarVisibilityCommandHandler({ layoutState });

    await handler();
    await handler();

    expect(layoutState.updates).toEqual([{ sidebarVisible: false }, { sidebarVisible: true }]);
  });
});

describe("registerSidebarVisibilityCommand", () => {
  test("registers under TOGGLE_SIDEBAR_VISIBILITY_COMMAND_ID via registerCore, with a palette title/category", () => {
    const layoutState = createFakeLayoutState(true);
    const calls: { id: string; meta: unknown }[] = [];
    const fakeCommands = {
      registerCore(id: string, _handler: unknown, meta?: unknown) {
        calls.push({ id, meta });
        return { dispose() {} };
      },
    };

    registerSidebarVisibilityCommand(fakeCommands, { layoutState });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(TOGGLE_SIDEBAR_VISIBILITY_COMMAND_ID);
    expect(calls[0]?.meta).toEqual({ title: "Toggle Sidebar Visibility", category: "View" });
  });

  test("the returned Disposable is whatever registerCore returned", () => {
    const layoutState = createFakeLayoutState(true);
    const sentinel = { dispose() {} };
    const fakeCommands = { registerCore: () => sentinel };

    const result = registerSidebarVisibilityCommand(fakeCommands, { layoutState });

    expect(result).toBe(sentinel);
  });
});
