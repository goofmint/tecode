/**
 * `Shell`/`Sidebar`'s sidebar-width resizing tests (Issue #105): the
 * render-site clamp (`Shell`'s own `renderedSidebarWidth`) and the
 * mouse-drag commit/no-commit-mid-drag contract (`Sidebar`'s
 * `onWidthDrag`/`onWidthDragEnd`, `Shell`'s `onSidebarWidthCommit`).
 *
 * **Why mouse events are dispatched via `processMouseEvent` rather than
 * `testRender`'s `mockMouse`**: `mockMouse` drives real ANSI mouse escape
 * sequences through the renderer's own hit-testing/capture pipeline
 * (`@opentui/core`'s `CliRenderer`, verified directly against the vendored
 * `@opentui/core@0.1.107` bundle) — that pipeline is `@opentui/core`'s own
 * contract, not this module's, exactly the same "coverage gap" reasoning
 * `shell.snapshot.test.tsx`'s own TSDoc documents for focus transitions
 * (driven via a captured node's real `.focus()`/`.blur()` rather than a
 * simulated click). Constructing a real `MouseEvent` and calling the
 * Sidebar box's own `processMouseEvent` directly proves `shell.tsx`'s
 * `Sidebar`/`Shell` wiring end-to-end — real handler props receiving real
 * `@opentui/core` `MouseEvent` objects — without re-proving OpenTUI's own
 * ANSI-parsing/hit-testing/drag-capture machinery.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { MouseEvent as OpenTuiMouseEvent, type BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createHostLog } from "../host/errors";
import { createContextService } from "../keymap/context";
import { ContextFocusTracker } from "./focus";
import { createLayoutStateService, DEFAULT_LAYOUT_STATE, type LayoutStateFs } from "./layoutState";
import { createSlotRegistry } from "./slotRegistry";
import { ACTIVITY_BAR_WIDTH, Shell } from "./shell";
import { MIN_EDITOR_WIDTH } from "./sidebarWidth";
import { ThemeProvider } from "./theme";

/** A `StatusSink` stub that records nothing, just swallows every error —
 * these tests assert on `Shell`/`Sidebar`'s own behavior, not on error
 * reporting (Issue #105 nitpick: this was misnamed `createRecordingSink`
 * despite never recording anything). */
function createNoopSink() {
  return { error() {} };
}

/** An in-memory {@link LayoutStateFs} seeded with a fixed `sidebarWidth`
 * (matches `shell.snapshot.test.tsx`'s `createEmptyLayoutFs`, parameterized
 * so these tests can start from a specific persisted width). */
function createLayoutFs(sidebarWidth: number): LayoutStateFs {
  const content = JSON.stringify({ ...DEFAULT_LAYOUT_STATE, sidebarWidth });
  return {
    async readFile() {
      return content;
    },
    async mkdir() {},
    async writeFile() {},
  };
}

function createHarness(sidebarWidth: number) {
  const log = createHostLog();
  const sink = createNoopSink();
  const slotRegistry = createSlotRegistry({ log });
  const layoutState = createLayoutStateService({
    log,
    sink,
    path: "/state.json",
    fs: createLayoutFs(sidebarWidth),
  });
  const context = createContextService();
  return { slotRegistry, layoutState, context };
}

/** Depth-first search for the `<box>` whose resolved `x` matches
 * `ACTIVITY_BAR_WIDTH` — `Sidebar`'s own outer box is the only region that
 * starts there (`ActivityBar` occupies `[0, ACTIVITY_BAR_WIDTH)`,
 * `EditorArea` starts further right) — matches
 * `shell.snapshot.test.tsx`'s `findAllFocusable`/`findTabSelect` "search
 * the real rendered tree, don't reach into React state" idiom. */
function findSidebarBox(node: unknown): BoxRenderable | undefined {
  const candidate = node as { x?: number; width?: number; getChildren?: () => unknown[] };
  if (candidate?.x === ACTIVITY_BAR_WIDTH && typeof candidate.width === "number") {
    return candidate as BoxRenderable;
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findSidebarBox(child);
    if (found) return found;
  }
  return undefined;
}

/** A real `@opentui/core` `MouseEvent` for `processMouseEvent` — every
 * field `RawMouseEvent` requires, `type`/`x` overridden per call. */
function mouseEvent(
  target: BoxRenderable,
  type: "down" | "drag" | "drag-end",
  x: number,
): OpenTuiMouseEvent {
  return new OpenTuiMouseEvent(target, {
    type,
    button: 0,
    x,
    y: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
  });
}

describe("Shell — sidebar width render-site clamp (Issue #105)", () => {
  test("a persisted width wider than the live terminal allows is capped at render time", async () => {
    // Wide enough to be entirely reasonable on its own, but wider than a
    // 40-column terminal can afford once ActivityBar + a usable editor
    // area are reserved (`sidebarWidth.ts`'s TSDoc) — a mutated
    // `clampSidebarWidth` that returns `desired` unchanged would render
    // this at the full 80, not capped.
    const { slotRegistry, layoutState, context } = createHarness(80);
    await layoutState.ready;

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 40, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    const sidebarBox = findSidebarBox(renderer.root);
    expect(sidebarBox).toBeDefined();
    // Assert the EXACT capped width `clampSidebarWidth` computes (derived
    // from `ACTIVITY_BAR_WIDTH`/`MIN_EDITOR_WIDTH`, `sidebarWidth.ts`'s own
    // terminal-aware ceiling), not just two loose `toBeLessThan`s — a
    // drift in either constant is caught here instead of silently passing
    // as long as SOME shrinkage happened.
    const expectedWidth = 40 - ACTIVITY_BAR_WIDTH - MIN_EDITOR_WIDTH;
    expect(sidebarBox!.width).toBe(expectedWidth);
  });

  test("a persisted width that already fits the terminal is left unchanged", async () => {
    const { slotRegistry, layoutState, context } = createHarness(20);
    await layoutState.ready;

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 200, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    const sidebarBox = findSidebarBox(renderer.root);
    expect(sidebarBox!.width).toBe(20);
  });
});

describe("Shell — sidebar border drag (Issue #105)", () => {
  test("dragging the border live-resizes the sidebar without committing, drag-end commits exactly once", async () => {
    const { slotRegistry, layoutState, context } = createHarness(30);
    await layoutState.ready;

    let commitCount = 0;
    let lastCommitted: number | undefined;

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            onSidebarWidthCommit={(width) => {
              commitCount += 1;
              lastCommitted = width;
            }}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    const sidebarBox = findSidebarBox(renderer.root);
    expect(sidebarBox).toBeDefined();
    const box = sidebarBox!;
    // Captured BEFORE any drag event: `box` is the SAME live `BoxRenderable`
    // instance across every render below (React mutates its `width`
    // property in place rather than swapping instances), so reading
    // `box.width` again after the drag starts would reflect whatever the
    // drag has already resized it to, not the width the drag started from.
    const originalWidth = box.width;
    // The border column `Sidebar`'s own TSDoc computes: the box's last
    // column, `ACTIVITY_BAR_WIDTH + width - 1`.
    const borderColumn = ACTIVITY_BAR_WIDTH + originalWidth - 1;

    box.processMouseEvent(mouseEvent(box, "down", borderColumn));

    // Several intermediate drag ticks — a real drag reports many of these
    // per gesture. None of them should commit (`onSidebarWidthCommit` must
    // stay at 0 through every one of these): a mutation that fires the
    // settings write-back on every update instead of only on commit would
    // show up here as `commitCount > 0` before drag-end ever happens.
    //
    // Live progress is asserted against `layoutState.get().sidebarWidth`
    // directly, not the rendered box's own `.width` — the headless
    // renderer's Yoga layout pass resolves a CHANGED `width` style one
    // `renderOnce()` frame later than the React commit that set it (verified
    // empirically: `layoutState` already reads the new value the instant
    // `updateLayout` runs, while `box.width` still reports the PREVIOUS
    // tick's value until one more frame renders) — asserting on the real
    // application state sidesteps that rendering-pipeline timing detail
    // entirely, which is not what this test is about.
    for (const x of [borderColumn + 2, borderColumn + 5, borderColumn + 8]) {
      box.processMouseEvent(mouseEvent(box, "drag", x));
      await act(async () => {
        await renderOnce();
      });
      expect(commitCount).toBe(0);
    }
    expect(layoutState.get().sidebarWidth).toBeGreaterThan(originalWidth);

    const finalX = borderColumn + 10;
    box.processMouseEvent(mouseEvent(box, "drag-end", finalX));
    await act(async () => {
      await renderOnce();
    });

    // Exactly one commit, for the final width only.
    expect(commitCount).toBe(1);
    expect(lastCommitted).toBe(originalWidth + 10);
    expect(layoutState.get().sidebarWidth).toBe(originalWidth + 10);

    // One more frame for Yoga's layout pass to catch up (this test's own
    // TSDoc above) — proves the commit actually reaches the real rendered
    // box, not just `LayoutStateService`'s in-memory value.
    await act(async () => {
      await renderOnce();
    });
    const finalBox = findSidebarBox(renderer.root)!;
    expect(finalBox.width).toBe(lastCommitted as number);
  });

  test("a press that does not start on the border column never triggers a resize", async () => {
    const { slotRegistry, layoutState, context } = createHarness(30);
    await layoutState.ready;

    let commitCount = 0;

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            onSidebarWidthCommit={() => {
              commitCount += 1;
            }}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    const box = findSidebarBox(renderer.root)!;
    const originalWidth = box.width;
    const notTheBorder = ACTIVITY_BAR_WIDTH + 1; // well inside the content area

    box.processMouseEvent(mouseEvent(box, "down", notTheBorder));
    box.processMouseEvent(mouseEvent(box, "drag", notTheBorder + 5));
    box.processMouseEvent(mouseEvent(box, "drag-end", notTheBorder + 5));
    await act(async () => {
      await renderOnce();
    });

    expect(commitCount).toBe(0);
    expect(findSidebarBox(renderer.root)!.width).toBe(originalWidth);
  });
});
