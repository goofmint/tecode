/**
 * Tests for {@link createPanelHeightStepHandler}/
 * {@link registerPanelHeightCommands} (Issue #146), against fake
 * `layoutState`/`settingsWriter` narrowed to exactly the methods
 * `PanelHeightCommandsDeps` declares — matches
 * `sidebarWidthCommands.test.ts`'s own "no real service needed" shape.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createBindingTable } from "../keymap/bindingTable";
import { createChordStateMachine } from "../keymap/chords";
import { createContextService } from "../keymap/context";
import { MIN_PANEL_HEIGHT } from "./panelHeight";
import {
  createPanelHeightStepHandler,
  DECREASE_PANEL_HEIGHT_COMMAND_ID,
  INCREASE_PANEL_HEIGHT_COMMAND_ID,
  PANEL_HEIGHT_DEFAULT_KEYBINDINGS,
  PANEL_HEIGHT_FOCUS_WHEN,
  PANEL_HEIGHT_STEP,
  registerPanelHeightCommands,
  type PanelHeightCommandsDeps,
} from "./panelHeightCommands";

function createFakeDeps(initialHeight: number): PanelHeightCommandsDeps & {
  heights(): number[];
  writes(): number[];
} {
  let height = initialHeight;
  const writes: number[] = [];
  return {
    layoutState: {
      get: () => ({
        sidebarVisible: true,
        sidebarWidth: 30,
        panelVisible: false,
        panelHeight: height,
        activeView: undefined,
      }),
      update(partial) {
        if (partial.panelHeight !== undefined) height = partial.panelHeight;
      },
    },
    settingsWriter: {
      write(next) {
        writes.push(next);
      },
    },
    heights: () => [height],
    writes: () => writes,
  };
}

describe("createPanelHeightStepHandler (Issue #146)", () => {
  test("a positive delta grows by PANEL_HEIGHT_STEP and writes both layoutState and settings", () => {
    const deps = createFakeDeps(20);
    const handler = createPanelHeightStepHandler(deps, PANEL_HEIGHT_STEP);

    handler();

    expect(deps.heights()).toEqual([20 + PANEL_HEIGHT_STEP]);
    expect(deps.writes()).toEqual([20 + PANEL_HEIGHT_STEP]);
  });

  test("a negative delta shrinks by PANEL_HEIGHT_STEP", () => {
    const deps = createFakeDeps(20);
    const handler = createPanelHeightStepHandler(deps, -PANEL_HEIGHT_STEP);

    handler();

    expect(deps.heights()).toEqual([20 - PANEL_HEIGHT_STEP]);
    expect(deps.writes()).toEqual([20 - PANEL_HEIGHT_STEP]);
  });

  test("shrinking below MIN_PANEL_HEIGHT clamps rather than going negative", () => {
    const deps = createFakeDeps(MIN_PANEL_HEIGHT + 1);
    const handler = createPanelHeightStepHandler(deps, -PANEL_HEIGHT_STEP);

    handler();

    expect(deps.heights()).toEqual([MIN_PANEL_HEIGHT]);
    expect(deps.writes()).toEqual([MIN_PANEL_HEIGHT]);
  });

  test("every invocation writes to settings — repeated presses each commit (no debounce skip at this layer)", () => {
    const deps = createFakeDeps(20);
    const handler = createPanelHeightStepHandler(deps, PANEL_HEIGHT_STEP);

    handler();
    handler();
    handler();

    expect(deps.writes()).toEqual([23, 26, 29]);
  });
});

describe("PANEL_HEIGHT_DEFAULT_KEYBINDINGS (Issue #146)", () => {
  test("binds ctrl+k up to increase and ctrl+k down to decrease, both scoped by PANEL_HEIGHT_FOCUS_WHEN", () => {
    expect(PANEL_HEIGHT_DEFAULT_KEYBINDINGS).toEqual([
      { key: "ctrl+k up", command: INCREASE_PANEL_HEIGHT_COMMAND_ID, when: PANEL_HEIGHT_FOCUS_WHEN },
      { key: "ctrl+k down", command: DECREASE_PANEL_HEIGHT_COMMAND_ID, when: PANEL_HEIGHT_FOCUS_WHEN },
    ]);
  });
});

// --- The ctrl+k chord-shadowing hazard (Issue #146, ported from
// `sidebarWidthCommands.test.ts`'s own identically-named describe block).
// `PANEL_HEIGHT_DEFAULT_KEYBINDINGS`'s `when` clause (`PANEL_HEIGHT_FOCUS_
// WHEN`) is what lets ANY hand-bound `ctrl+k` in a user's own
// `keybindings.json` — an Emacs-style kill-line binding being the obvious
// example — resolve directly instead of getting stuck waiting for `up`/
// `down` to complete the panel-resize chord. This describe block presses
// the REAL `BindingTable`/`ChordStateMachine` pair, not just a table
// lookup, so a regression here would show up as an actual stuck keystroke.
describe("the ctrl+k chord-shadowing hazard (Issue #146's own PANEL_HEIGHT_FOCUS_WHEN)", () => {
  function contextOf(values: Record<string, unknown>) {
    return (key: string) => values[key];
  }

  /** A minimal layered table with only `PANEL_HEIGHT_DEFAULT_KEYBINDINGS`
   * in `defaults` plus whatever `user` entries the test supplies — no
   * `builtin` manifests needed (`core` may not import `builtin`), since
   * this hazard is entirely about `PANEL_HEIGHT_DEFAULT_KEYBINDINGS`'s own
   * `when` clause, not about any particular extension's chord. */
  function buildTable(userEntries: Parameters<typeof createBindingTable>[0]["user"]) {
    return createBindingTable(
      { defaults: PANEL_HEIGHT_DEFAULT_KEYBINDINGS, fallback: [], extension: [], user: userEntries },
      { log: createHostLog() },
    );
  }

  test("ctrl+k IS a live chord prefix while the panel/terminal is focused — the positive half of PANEL_HEIGHT_FOCUS_WHEN", () => {
    const table = buildTable([]);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ panelFocus: true }))).toBe(true);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ terminalFocus: true }))).toBe(true);
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
    // dropping PANEL_HEIGHT_FOCUS_WHEN from PANEL_HEIGHT_DEFAULT_
    // KEYBINDINGS) would show up as a `"ctrl+k"` entry in this array
    // (chord-pending, waiting for `up` or `down`) instead of a direct
    // execution.
    expect(pendingStates).toEqual([]);
  });

  test("the panel-resize chord is still reachable via ctrl+k up / ctrl+k down while the panel is focused, even with a user ctrl+k binding present", () => {
    const table = buildTable([
      { key: "ctrl+k", command: "user.killLine", when: "editorTextFocus" },
    ]);
    const context = createContextService();
    context.set("panelFocus", true);

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
    expect(machine.handleStroke("up")).toBe("consumed");
    expect(executed).toEqual([INCREASE_PANEL_HEIGHT_COMMAND_ID]);
  });
});

describe("registerPanelHeightCommands", () => {
  test("registers both commands under registerCore, with palette title/category", () => {
    const deps = createFakeDeps(20);
    const calls: { id: string; meta: unknown }[] = [];
    const fakeCommands = {
      registerCore(id: string, _handler: unknown, meta?: unknown) {
        calls.push({ id, meta });
        return { dispose() {} };
      },
    };

    registerPanelHeightCommands(fakeCommands, deps);

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual([
      INCREASE_PANEL_HEIGHT_COMMAND_ID,
      DECREASE_PANEL_HEIGHT_COMMAND_ID,
    ]);
    expect(calls[0]?.meta).toEqual({ title: "Increase Panel Height", category: "View" });
    expect(calls[1]?.meta).toEqual({ title: "Decrease Panel Height", category: "View" });
  });

  test("dispose() disposes both registrations and is idempotent", () => {
    const deps = createFakeDeps(20);
    let disposeCount = 0;
    const fakeCommands = {
      registerCore: () => ({
        dispose() {
          disposeCount += 1;
        },
      }),
    };

    const result = registerPanelHeightCommands(fakeCommands, deps);
    result.dispose();
    result.dispose();

    expect(disposeCount).toBe(2);
  });
});
