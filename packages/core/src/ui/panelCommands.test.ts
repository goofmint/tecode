/**
 * Tests for {@link createShowPanelCommandHandler}/{@link
 * registerShowPanelCommand} (Issue #98 Phase 3) against a fake
 * `layoutState` narrowed to exactly the one method `ShowPanelCommandDeps`
 * declares — matches `openFileCommand.test.ts`'s own "no real service
 * needed" shape.
 */

import { describe, expect, test } from "bun:test";
import {
  createShowPanelCommandHandler,
  registerShowPanelCommand,
  SHOW_PANEL_COMMAND_ID,
  type ShowPanelCommandDeps,
} from "./panelCommands";

function createFakeLayoutState(): ShowPanelCommandDeps["layoutState"] & { updates: Partial<{ panelVisible: boolean }>[] } {
  const updates: Partial<{ panelVisible: boolean }>[] = [];
  return {
    updates,
    update(partial) {
      updates.push(partial);
    },
  };
}

describe("createShowPanelCommandHandler", () => {
  test("calling the handler updates layoutState with panelVisible: true", async () => {
    const layoutState = createFakeLayoutState();
    const handler = createShowPanelCommandHandler({ layoutState });

    await handler();

    expect(layoutState.updates).toEqual([{ panelVisible: true }]);
  });

  test("calling the handler twice is idempotent — two identical updates, never throws", async () => {
    const layoutState = createFakeLayoutState();
    const handler = createShowPanelCommandHandler({ layoutState });

    await handler();
    await handler();

    expect(layoutState.updates).toEqual([{ panelVisible: true }, { panelVisible: true }]);
  });
});

describe("registerShowPanelCommand", () => {
  test("registers under SHOW_PANEL_COMMAND_ID via registerCore, with a palette title/category", () => {
    const layoutState = createFakeLayoutState();
    const calls: { id: string; meta: unknown }[] = [];
    const fakeCommands = {
      registerCore(id: string, _handler: unknown, meta?: unknown) {
        calls.push({ id, meta });
        return { dispose() {} };
      },
    };

    registerShowPanelCommand(fakeCommands, { layoutState });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(SHOW_PANEL_COMMAND_ID);
    expect(calls[0]?.meta).toEqual({ title: "Show Panel", category: "View" });
  });

  test("the returned Disposable is whatever registerCore returned", () => {
    const layoutState = createFakeLayoutState();
    const sentinel = { dispose() {} };
    const fakeCommands = { registerCore: () => sentinel };

    const result = registerShowPanelCommand(fakeCommands, { layoutState });

    expect(result).toBe(sentinel);
  });
});
