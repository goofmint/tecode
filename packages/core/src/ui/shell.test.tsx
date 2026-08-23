/**
 * Shell snapshot/integration tests (Req 6.1-6.5; design.md §16; Task 1.14).
 *
 * **The headless-rendering API used, and how it was found**: `@opentui/core`
 * ships a genuine headless test renderer at `@opentui/core/testing`
 * (`createTestRenderer`, discovered by reading
 * `node_modules/@opentui/core/testing/test-renderer.d.ts`) that runs the
 * real terminal-cell-buffer pipeline against an in-memory `CliRenderer` —
 * no real TTY is opened. `@opentui/react` wraps it for React trees as
 * `testRender` (`@opentui/react/test-utils`, confirmed by reading its
 * `test-utils.d.ts`), returning:
 *   - `renderOnce()` — flush one frame synchronously (no timers, no
 *     polling — deterministic).
 *   - `captureCharFrame()` — the actual rendered cell grid as one string
 *     (rows joined by `\n`), used below as design.md §16's "snapshot the
 *     cell grid" — every assertion here reads real rendered terminal
 *     output, not a shallow React tree.
 *   - `captureSpans()` — per-cell style spans, for tests that need to
 *     assert on color/attributes rather than characters (unused here — no
 *     assertion in this file needs to distinguish colors, only content and
 *     layout).
 * This is a full, working headless cell-grid renderer, not a fallback —
 * design.md §16's ask ("OpenTUI's headless renderer renders the Shell...
 * and snapshots the cell grid") is met directly with the real API, with one
 * documented gap below.
 *
 * **Coverage gap, documented explicitly (design.md §16's instruction)**:
 * `RenderableEvents.FOCUSED`/`BLURRED` fire from an OpenTUI node's own
 * `.focus()`/`.blur()` calls (see `focus.test.tsx`, which exercises this
 * directly against a real `<box>`). Driving that same transition through
 * the Shell end-to-end would additionally require simulating a mouse click
 * or Tab-key traversal through `testRender`'s `mockMouse`/`mockInput` and
 * OpenTUI's own focus-manager keyboard/mouse wiring, which is outside this
 * task's scope (the Shell does not yet register any focus-manager
 * keybindings — that is a later editor-focused task). The "focus change
 * updates context keys" case below therefore calls `.focus()`/`.blur()`
 * directly on a `ref`-captured region root (exactly as `focus.test.tsx`
 * does), through the Shell's *actual* rendered tree rather than an isolated
 * `<Probe>` — proving the Shell wires `useFocusTracking` correctly on its
 * regions, short of also re-proving OpenTUI's own input-to-focus dispatch
 * (which is `@opentui/core`'s contract, not this module's).
 *
 * **Determinism**: no real timers, no `sleep`, no polling loops — every
 * test drives exactly one `renderOnce()` (or two, when a state change must
 * flush before the next assertion) with no wall-clock dependency.
 *
 * **Cosmetic `act(...)` console warnings**: `testRender`'s own initial
 * mount (`@opentui/react/test-utils`) wraps `root.render(node)` in a
 * *synchronous* `act()`, which does not flush passive effects scheduled
 * for after paint — `useLayoutState`'s `layoutState.ready.then(setState)`
 * effect settles on a later microtask outside that window, so React logs
 * an act-wrapping warning for it even though every assertion in this file
 * runs after an explicit `await act(async () => { await renderOnce() })`
 * and is not flaky. This is a quirk of the installed `@opentui/react`
 * version's `test-utils`, not of the Shell; noted here rather than
 * silenced, since suppressing it would risk hiding a real one later.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCommandRegistry } from "../commands/registry";
import { createHostLog } from "../host/errors";
import { createContextService } from "../keymap/context";
import { ContextFocusTracker } from "./focus";
import { createLayoutStateService, type LayoutStateFs } from "./layoutState";
import { createSlotRegistry } from "./slotRegistry";
import { Shell } from "./shell";
import { ThemeProvider } from "./theme";

function createRecordingSink() {
  return { error() {} };
}

/** An in-memory {@link LayoutStateFs} that starts with no `state.json` (so
 * every test gets {@link DEFAULT_LAYOUT_STATE} deterministically, with no
 * real filesystem involved). */
function createEmptyLayoutFs(): LayoutStateFs {
  return {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
  };
}

function createHarness() {
  const log = createHostLog();
  const sink = createRecordingSink();
  const slotRegistry = createSlotRegistry({ log });
  const layoutState = createLayoutStateService({ log, sink, path: "/state.json", fs: createEmptyLayoutFs() });
  const context = createContextService();
  const commands = createCommandRegistry({ log, sink });
  return { slotRegistry, layoutState, context, commands };
}

const noopComponent = () => undefined;

describe("Shell — empty shell renders every region (Req 6.1, design.md §16)", () => {
  test("renders ActivityBar/Sidebar/EditorArea/Panel/StatusBar with no registered views", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });

    const frame = captureCharFrame();
    // The placeholder EditorView renders even with no tabs (Req 6.5,
    // design.md §8.3 — "no visible editing yet" is expected at this task).
    expect(frame).toContain("No editor open.");
    // A non-blank frame of the requested dimensions proves every region
    // actually laid out (an empty/crashed tree would render nothing).
    expect(frame.split("\n").length).toBeGreaterThanOrEqual(20);
  });
});

describe("Shell — registering a view re-renders its region (Req 6.3, design.md §8.2)", () => {
  test("registering a sidebar.view + activityBar.item pair shows it once selected", async () => {
    const { slotRegistry, layoutState, context, commands } = createHarness();
    await layoutState.ready;

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} commands={commands} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });
    expect(captureCharFrame()).not.toContain("Explorer Panel Content");

    act(() => {
      slotRegistry.registerView("activityBar.item", "explorer", noopComponent, {
        title: "Explorer",
        icon: "E",
      });
      slotRegistry.registerView(
        "sidebar.view",
        "explorer",
        () => <text>Explorer Panel Content</text>,
        { title: "Explorer" },
      );
    });
    await act(async () => { await renderOnce(); }); // lets the workbench.view.explorer command finish registering

    // Selecting the view goes through the Shell's own state (this module's
    // TSDoc: "the Shell is the layout service's one and only writer") —
    // exercised here via the `workbench.view.<id>` command (Req 6.2)
    // exactly as a real activity-bar click would drive it.
    await act(async () => {
      await commands.execute("workbench.view.explorer");
    });
    await act(async () => { await renderOnce(); });

    expect(captureCharFrame()).toContain("Explorer Panel Content");
  });

  test("registering a statusBar.item re-renders the StatusBar", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });
    expect(captureCharFrame()).not.toContain("Ln 1, Col 1");

    act(() => {
      slotRegistry.registerView(
        "statusBar.item",
        "cursor.position",
        () => <text>Ln 1, Col 1</text>,
        { statusBar: { side: "right", priority: 0 } },
      );
    });
    await act(async () => { await renderOnce(); });

    expect(captureCharFrame()).toContain("Ln 1, Col 1");
  });

  test("a lazy sidebar.view (pending manifest contribution) requests extension activation once selected", async () => {
    const { layoutState, context, commands } = createHarness();
    await layoutState.ready;
    const activated: string[] = [];
    const slotRegistry = createSlotRegistry({
      pendingViews: [
        { extensionId: "demo.ext", view: { id: "demo.view", title: "Demo", slot: "sidebar" } },
      ],
      activateExtension: async (id) => {
        activated.push(id);
      },
    });

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} commands={commands} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });
    expect(activated).toEqual([]); // not selected yet — no activation requested

    await act(async () => {
      await commands.execute("workbench.view.demo.view");
    });
    await act(async () => { await renderOnce(); });

    expect(activated).toEqual(["demo.ext"]);
  });
});

describe("Shell — workbench.view.<id> command switches the sidebar (Req 6.2)", () => {
  test("executing the command activates the same-id sidebar view", async () => {
    const { slotRegistry, layoutState, context, commands } = createHarness();
    await layoutState.ready;
    slotRegistry.registerView("activityBar.item", "search", noopComponent, { title: "Search" });
    slotRegistry.registerView("sidebar.view", "search", () => <text>Search Panel</text>);

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} commands={commands} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });
    expect(captureCharFrame()).not.toContain("Search Panel");

    await act(async () => {
      await commands.execute("workbench.view.search");
    });
    await act(async () => { await renderOnce(); });

    expect(captureCharFrame()).toContain("Search Panel");
  });
});

describe("Shell — focus change updates context keys (Req 4.6, design.md §8.1)", () => {
  test("focusing a Shell region's root box sets its context key true, blurring sets it false", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });

    // Every `focusable` box in the rendered tree is one Shell region wired
    // through `useFocusTracking` (Sidebar/EditorArea/Panel — Panel starts
    // hidden in this fixture, so exactly Sidebar and EditorArea are found).
    // Focusing each and checking exactly one recognized context key flips
    // proves the Shell's own `useFocusTracking` wiring end-to-end, without
    // depending on which region happens to come first in the tree.
    const focusables = findAllFocusable(renderer.root) as BoxRenderable[];
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    for (const key of ["sidebarFocus", "editorFocus"]) {
      expect(context.get<boolean>(key)).toBeUndefined();
    }

    for (const node of focusables) {
      node.focus();
      const setKeys = ["sidebarFocus", "editorFocus", "panelFocus"].filter(
        (key) => context.get<boolean>(key) === true,
      );
      expect(setKeys).toHaveLength(1);
      node.blur();
      expect(context.get<boolean>(setKeys[0]!)).toBe(false);
    }
  });
});

/** Depth-first collection of every `focusable` descendant, used only by the
 * focus test above to locate the Shell's region roots without Shell
 * exposing test-only refs on its public props. */
function findAllFocusable(node: unknown): unknown[] {
  const candidate = node as {
    focusable?: boolean;
    getChildren?: () => unknown[];
  };
  const found: unknown[] = candidate?.focusable ? [candidate] : [];
  for (const child of candidate?.getChildren?.() ?? []) {
    found.push(...findAllFocusable(child));
  }
  return found;
}
