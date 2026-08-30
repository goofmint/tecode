/**
 * Tests for {@link createSidebarWidthStepHandler}/
 * {@link registerSidebarWidthCommands} (Issue #105), against fake
 * `layoutState`/`settingsWriter` narrowed to exactly the methods
 * `SidebarWidthCommandsDeps` declares — matches `panelCommands.test.ts`'s
 * own "no real service needed" shape.
 */

import { describe, expect, test } from "bun:test";
import { MIN_SIDEBAR_WIDTH } from "./sidebarWidth";
import {
  createSidebarWidthStepHandler,
  DECREASE_SIDEBAR_WIDTH_COMMAND_ID,
  INCREASE_SIDEBAR_WIDTH_COMMAND_ID,
  registerSidebarWidthCommands,
  SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS,
  SIDEBAR_WIDTH_FOCUS_WHEN,
  SIDEBAR_WIDTH_STEP,
  type SidebarWidthCommandsDeps,
} from "./sidebarWidthCommands";

function createFakeDeps(initialWidth: number): SidebarWidthCommandsDeps & {
  widths(): number[];
  writes(): number[];
} {
  let width = initialWidth;
  const writes: number[] = [];
  return {
    layoutState: {
      get: () => ({
        sidebarVisible: true,
        sidebarWidth: width,
        panelVisible: false,
        panelHeight: 10,
        activeView: undefined,
      }),
      update(partial) {
        if (partial.sidebarWidth !== undefined) width = partial.sidebarWidth;
      },
    },
    settingsWriter: {
      write(next) {
        writes.push(next);
      },
    },
    widths: () => [width],
    writes: () => writes,
  };
}

describe("createSidebarWidthStepHandler (Issue #105)", () => {
  test("a positive delta widens by SIDEBAR_WIDTH_STEP and writes both layoutState and settings", () => {
    const deps = createFakeDeps(30);
    const handler = createSidebarWidthStepHandler(deps, SIDEBAR_WIDTH_STEP);

    handler();

    expect(deps.widths()).toEqual([30 + SIDEBAR_WIDTH_STEP]);
    expect(deps.writes()).toEqual([30 + SIDEBAR_WIDTH_STEP]);
  });

  test("a negative delta narrows by SIDEBAR_WIDTH_STEP", () => {
    const deps = createFakeDeps(30);
    const handler = createSidebarWidthStepHandler(deps, -SIDEBAR_WIDTH_STEP);

    handler();

    expect(deps.widths()).toEqual([30 - SIDEBAR_WIDTH_STEP]);
    expect(deps.writes()).toEqual([30 - SIDEBAR_WIDTH_STEP]);
  });

  test("narrowing below MIN_SIDEBAR_WIDTH clamps rather than going negative", () => {
    const deps = createFakeDeps(MIN_SIDEBAR_WIDTH + 1);
    const handler = createSidebarWidthStepHandler(deps, -SIDEBAR_WIDTH_STEP);

    handler();

    expect(deps.widths()).toEqual([MIN_SIDEBAR_WIDTH]);
    expect(deps.writes()).toEqual([MIN_SIDEBAR_WIDTH]);
  });

  test("every invocation writes to settings — repeated presses each commit (no debounce skip at this layer)", () => {
    const deps = createFakeDeps(30);
    const handler = createSidebarWidthStepHandler(deps, SIDEBAR_WIDTH_STEP);

    handler();
    handler();
    handler();

    expect(deps.writes()).toEqual([35, 40, 45]);
  });
});

describe("SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS (Issue #105)", () => {
  test("binds ctrl+k [ to decrease and ctrl+k ] to increase, both scoped by SIDEBAR_WIDTH_FOCUS_WHEN", () => {
    expect(SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS).toEqual([
      { key: "ctrl+k [", command: DECREASE_SIDEBAR_WIDTH_COMMAND_ID, when: SIDEBAR_WIDTH_FOCUS_WHEN },
      { key: "ctrl+k ]", command: INCREASE_SIDEBAR_WIDTH_COMMAND_ID, when: SIDEBAR_WIDTH_FOCUS_WHEN },
    ]);
  });
});

describe("registerSidebarWidthCommands", () => {
  test("registers both commands under registerCore, with palette title/category", () => {
    const deps = createFakeDeps(30);
    const calls: { id: string; meta: unknown }[] = [];
    const fakeCommands = {
      registerCore(id: string, _handler: unknown, meta?: unknown) {
        calls.push({ id, meta });
        return { dispose() {} };
      },
    };

    registerSidebarWidthCommands(fakeCommands, deps);

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual([
      INCREASE_SIDEBAR_WIDTH_COMMAND_ID,
      DECREASE_SIDEBAR_WIDTH_COMMAND_ID,
    ]);
    expect(calls[0]?.meta).toEqual({ title: "Increase Sidebar Width", category: "View" });
    expect(calls[1]?.meta).toEqual({ title: "Decrease Sidebar Width", category: "View" });
  });

  test("dispose() disposes both registrations and is idempotent", () => {
    const deps = createFakeDeps(30);
    let disposeCount = 0;
    const fakeCommands = {
      registerCore: () => ({
        dispose() {
          disposeCount += 1;
        },
      }),
    };

    const result = registerSidebarWidthCommands(fakeCommands, deps);
    result.dispose();
    result.dispose();

    expect(disposeCount).toBe(2);
  });
});
