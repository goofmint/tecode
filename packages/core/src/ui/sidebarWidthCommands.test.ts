/**
 * Tests for {@link createSidebarWidthStepHandler}/
 * {@link registerSidebarWidthCommands} (Issue #105), against fake
 * `layoutState`/`settingsWriter` narrowed to exactly the methods
 * `SidebarWidthCommandsDeps` declares — matches `panelCommands.test.ts`'s
 * own "no real service needed" shape.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createBindingTable } from "../keymap/bindingTable";
import { createChordStateMachine } from "../keymap/chords";
import { createContextService } from "../keymap/context";
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

// --- The ctrl+k chord-shadowing hazard (Issue #105, ported from Issue
// #115's now-removed `keybindingPresets.test.ts`, which originally proved
// this against the bundled Emacs preset's own `ctrl+k` -> deleteLine
// binding). The guarantee outlives the presets: `SIDEBAR_WIDTH_
// DEFAULT_KEYBINDINGS`'s `when` clause (`SIDEBAR_WIDTH_FOCUS_WHEN`) is
// what lets ANY hand-bound `ctrl+k` in a user's own `keybindings.json` —
// an Emacs-style kill-line binding being the obvious example,
// `samples/keybindings.emacs.json` — resolve directly instead of getting
// stuck waiting for `[`/`]` to complete the sidebar-resize chord. This
// describe block presses the REAL `BindingTable`/`ChordStateMachine`
// pair, not just a table lookup, so a regression here would show up as an
// actual stuck keystroke.
describe("the ctrl+k chord-shadowing hazard (Issue #105's own SIDEBAR_WIDTH_FOCUS_WHEN)", () => {
  function contextOf(values: Record<string, unknown>) {
    return (key: string) => values[key];
  }

  /** A minimal layered table with only `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS`
   * in `defaults` plus whatever `user` entries the test supplies — no
   * `builtin` manifests needed (`core` may not import `builtin`), since
   * this hazard is entirely about `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS`'s
   * own `when` clause, not about any particular extension's chord. */
  function buildTable(userEntries: Parameters<typeof createBindingTable>[0]["user"]) {
    return createBindingTable(
      { defaults: SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS, fallback: [], extension: [], user: userEntries },
      { log: createHostLog() },
    );
  }

  test("ctrl+k IS a live chord prefix while the sidebar/explorer is focused — the positive half of SIDEBAR_WIDTH_FOCUS_WHEN", () => {
    const table = buildTable([]);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ sidebarFocus: true }))).toBe(true);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ explorerFocus: true }))).toBe(true);
  });

  test("ctrl+k is NOT a live chord prefix under editorTextFocus — this is what keeps a hand-bound ctrl+k reachable", () => {
    const table = buildTable([]);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ editorTextFocus: true }))).toBe(false);
  });

  test("a user's own ctrl+k binding (e.g. an Emacs-style kill-line entry in keybindings.json) resolves DIRECTLY under editorTextFocus — not a pending chord", () => {
    const table = buildTable([
      { key: "ctrl+k", command: "editor.action.deleteLine", when: "editorTextFocus" },
    ]);
    const context = createContextService();
    context.set("editorTextFocus", true);

    const executed: string[] = [];
    const pendingStates: Array<string | undefined> = [];
    const machine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
      },
      getContext: (key) => context.get(key),
      log: createHostLog(),
    });
    machine.onDidChangePending((prefix) => pendingStates.push(prefix));

    const result = machine.handleStroke("ctrl+k");

    expect(result).toBe("consumed");
    expect(executed).toEqual(["editor.action.deleteLine"]);
    // Never entered pending state at all — a regression here (e.g.
    // dropping SIDEBAR_WIDTH_FOCUS_WHEN from SIDEBAR_WIDTH_DEFAULT_
    // KEYBINDINGS) would show up as a `"ctrl+k"` entry in this array
    // (chord-pending, waiting for `[` or `]`) instead of a direct
    // execution.
    expect(pendingStates).toEqual([]);
  });

  test("the sidebar-resize chord is still reachable via ctrl+k [ / ctrl+k ] while the sidebar is focused, even with a user ctrl+k binding present", () => {
    const table = buildTable([
      { key: "ctrl+k", command: "user.killLine", when: "editorTextFocus" },
    ]);
    const context = createContextService();
    context.set("sidebarFocus", true);

    const executed: string[] = [];
    const machine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
      },
      getContext: (key) => context.get(key),
      log: createHostLog(),
    });

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("[")).toBe("consumed");
    expect(executed).toEqual([DECREASE_SIDEBAR_WIDTH_COMMAND_ID]);
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
