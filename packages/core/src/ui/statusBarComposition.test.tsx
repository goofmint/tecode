/**
 * A fully populated status bar, rendered end to end (Task 3.4, Req 11.6;
 * design.md §16's "OpenTUI's headless renderer renders the Shell... and
 * snapshots the cell grid" — no `toMatchSnapshot`, every assertion below
 * reads the real rendered cell grid, matching `shell.test.tsx`'s own
 * top-of-file TSDoc on the `testRender`/`captureCharFrame` API).
 *
 * A single real {@link SlotRegistry} is populated with:
 * - left/right `statusBar.item` entries standing in for the `statusbar`
 *   builtin's own registrations (language/EOL/dirty on the left, cursor/
 *   theme on the right) — registered directly here with `registerView`
 *   rather than through the real `packages/builtin/statusbar` extension,
 *   since `@tecode/core` may not import `@tecode/builtin` (the ESLint
 *   layering rule runs the other direction; `themesVisual.test.tsx`'s own
 *   TSDoc gives the identical reason for living in `packages/cli` instead —
 *   this suite stays in `core` specifically to also exercise the two
 *   CORE-INTERNAL surfaces below, which `packages/builtin` cannot reach at
 *   all).
 * - the real {@link createHostErrorStatusSink} and
 *   {@link createChordPendingIndicator}, driven by a real
 *   {@link createChordStateMachine} — the two "Phase 1 sinks" this task's
 *   plan calls out.
 *
 * `StatusBar` (`shell.tsx`) renders every item as adjacent `<text>` runs
 * with no separator — this suite's fixture item texts are padded with a
 * leading/trailing space precisely so each segment is visually
 * distinguishable in the captured frame, the same convention this task's
 * real `statusbar` builtin (`packages/builtin/statusbar/index.ts`) uses.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createHostLog } from "../host/errors";
import { createBindingTable, type KeymapLayers } from "../keymap/bindingTable";
import { createChordStateMachine } from "../keymap/chords";
import { createContextService } from "../keymap/context";
import { ContextFocusTracker } from "./focus";
import { createChordPendingIndicator } from "./chordPendingIndicator";
import { createHostErrorStatusSink } from "./hostErrorSink";
import { createLayoutStateService, type LayoutStateFs } from "./layoutState";
import { createSlotRegistry } from "./slotRegistry";
import { Shell } from "./shell";
import { ThemeProvider } from "./theme";

/** An in-memory {@link LayoutStateFs} starting with no `state.json`
 * (matches `shell.test.tsx`'s own `createEmptyLayoutFs`), so `Shell` gets
 * `DEFAULT_LAYOUT_STATE` deterministically with no real filesystem
 * involved. */
function createEmptyLayoutFs(): LayoutStateFs {
  return {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
  };
}

function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
  return {
    defaults: partial.defaults ?? [],
    fallback: partial.fallback ?? [],
    extension: partial.extension ?? [],
    user: partial.user ?? [],
  };
}

/** Register the `statusbar` builtin's five items directly against
 * `slotRegistry` (this file's TSDoc on why not the real extension). */
function registerFixtureEditorItems(slotRegistry: ReturnType<typeof createSlotRegistry>): void {
  slotRegistry.registerView("statusBar.item", "tecode.statusbar.language", undefined, {
    title: " typescript ",
    statusBar: { side: "left", priority: 30 },
  });
  slotRegistry.registerView("statusBar.item", "tecode.statusbar.eol", undefined, {
    title: " LF ",
    statusBar: { side: "left", priority: 20 },
  });
  slotRegistry.registerView("statusBar.item", "tecode.statusbar.dirty", undefined, {
    title: " ● ",
    statusBar: { side: "left", priority: 10 },
  });
  slotRegistry.registerView("statusBar.item", "tecode.statusbar.cursor", undefined, {
    title: " Ln 3, Col 7 ",
    statusBar: { side: "right", priority: 20 },
  });
  slotRegistry.registerView("statusBar.item", "tecode.statusbar.theme", undefined, {
    title: " Dark Modern ",
    statusBar: { side: "right", priority: 10 },
  });
}

describe("A fully populated status bar (Task 3.4, Req 11.6)", () => {
  test("renders editor items, the host-error sink, and the chord-pending indicator in priority order", async () => {
    const slotRegistry = createSlotRegistry();
    const context = createContextService();
    const layoutState = createLayoutStateService({
      log: createHostLog(),
      sink: { error() {} },
      path: "/state.json",
      fs: createEmptyLayoutFs(),
    });
    await layoutState.ready;
    registerFixtureEditorItems(slotRegistry);

    const hostErrorSink = createHostErrorStatusSink({ slotRegistry, setTimeout: () => 0, clearTimeout: () => {} });
    const chordMachine = createChordStateMachine({
      table: createBindingTable(
        layersOf({ user: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }] }),
        { log: createHostLog() },
      ),
      execute: () => {},
      getContext: () => undefined,
      scheduler: { set: () => 0, clear: () => {} },
    });
    const chordPendingIndicator = createChordPendingIndicator({ chordMachine, slotRegistry });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    // Everything registered before the first render is already visible.
    let frame = captureCharFrame();
    expect(frame).toContain("typescript");
    expect(frame).toContain("LF");
    expect(frame).toContain("●");
    expect(frame).toContain("Ln 3, Col 7");
    expect(frame).toContain("Dark Modern");

    // Left-to-right order on each side follows descending priority
    // (design.md §8.2): language (30) before EOL (20) before dirty (10);
    // cursor (20) before theme (10) — read off the STATUS BAR ROW
    // specifically (its own text is unique enough not to collide with any
    // other on-screen row at this viewport size).
    const statusBarLine = frame.split("\n").find((line) => line.includes("typescript"));
    expect(statusBarLine).toBeDefined();
    const line = statusBarLine!;
    expect(line.indexOf("typescript")).toBeLessThan(line.indexOf("LF"));
    expect(line.indexOf("LF")).toBeLessThan(line.indexOf("●"));
    expect(line.indexOf("Ln 3, Col 7")).toBeLessThan(line.indexOf("Dark Modern"));

    // No host error or chord-pending indicator yet.
    expect(frame).not.toContain("(ctrl+k)");

    // Fire a state change on each Phase 1 sink and assert the frame updates.
    act(() => {
      hostErrorSink.error({ message: "Unknown command: bogus.command" });
    });
    await act(async () => {
      await renderOnce();
    });
    frame = captureCharFrame();
    expect(frame).toContain("Unknown command: bogus.command");
    // Renders leftmost — before every other left-side item, including the
    // fixture's own `language` item (this file's fixture doesn't register
    // any window-message item, so the host error is the only "attention"
    // item present).
    const errorLine = frame.split("\n").find((l) => l.includes("Unknown command"))!;
    expect(errorLine.indexOf("Unknown command")).toBeLessThan(errorLine.indexOf("typescript"));

    act(() => {
      chordMachine.handleStroke("ctrl+k");
    });
    await act(async () => {
      await renderOnce();
    });
    frame = captureCharFrame();
    expect(frame).toContain("(ctrl+k)");
    // Between the host error (highest left priority) and the ordinary
    // editor items (language tops out at 30).
    const chordLine = frame.split("\n").find((l) => l.includes("(ctrl+k)"))!;
    expect(chordLine.indexOf("Unknown command")).toBeLessThan(chordLine.indexOf("(ctrl+k)"));
    expect(chordLine.indexOf("(ctrl+k)")).toBeLessThan(chordLine.indexOf("typescript"));

    // Completing the chord clears its indicator; the host error is
    // untouched (independent lifecycles/ids).
    act(() => {
      chordMachine.handleStroke("ctrl+s");
    });
    await act(async () => {
      await renderOnce();
    });
    frame = captureCharFrame();
    expect(frame).not.toContain("(ctrl+k)");
    expect(frame).toContain("Unknown command: bogus.command");

    chordPendingIndicator.dispose();
    hostErrorSink.dispose();
  });
});
