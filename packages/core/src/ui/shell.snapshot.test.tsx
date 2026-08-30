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
import { TabSelectRenderable, type BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager, type DocumentManagerFs } from "../buffer/documentManager";
import { pathToUri } from "../buffer/uri";
import { createEditorInputRouter } from "../editor/inputRouter";
import { createHostLog } from "../host/errors";
import { createContextService } from "../keymap/context";
import { Tree } from "./components";
import { createEditorSessionService } from "./editorSession";
import { createFindService } from "./findService";
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

  test("re-registering a sidebar.view with a new title updates the header without a restart (Issue #103, Req 6.2)", async () => {
    // The generic mechanism `explorer`'s "show the open folder's name"
    // (Issue #103) is built on: a view publishes a live title via
    // `registerView`'s `options.title`, and `Sidebar` (this module) picks
    // it up reactively — through the SAME `SlotRegistry.onDidChange`
    // subscription `useSidebarPairs` already holds, no separate channel,
    // no remounting the Shell or the view's own component.
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

    act(() => {
      slotRegistry.registerView("activityBar.item", "explorer", noopComponent, {
        title: "Explorer",
        icon: "E",
      });
      slotRegistry.registerView("sidebar.view", "explorer", noopComponent, { title: "Explorer" });
    });
    await act(async () => {
      await commands.execute("workbench.view.explorer");
    });
    await act(async () => { await renderOnce(); });

    expect(captureCharFrame()).toContain("Explorer");
    expect(captureCharFrame()).not.toContain("my-project");

    // Same (slot, id) pair, a new title, no unregister/re-register of the
    // component itself — exactly the "call registerView again" update path
    // `@tecode/api`'s `RegisterViewOptions.title` TSDoc documents.
    act(() => {
      slotRegistry.registerView("sidebar.view", "explorer", noopComponent, { title: "my-project" });
    });
    await act(async () => { await renderOnce(); });

    expect(captureCharFrame()).toContain("my-project");
    expect(captureCharFrame()).not.toContain("Explorer");
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

describe("Shell — Sidebar forwards its real content width to the registered view (Issue #104 Phase 3)", () => {
  test("a Tree-rendering sidebar view truncates a label wider than the sidebar, using Sidebar's own viewProps width", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    // sidebarWidth 15 — Sidebar's own `border={["right"]}` (1 column)
    // leaves a 14-column content width, which is what should reach `Tree`
    // below via `viewProps={{ width }}` (`shell.tsx`'s `Sidebar` TSDoc).
    layoutState.update({ activeView: "explorer", sidebarWidth: 15 });

    slotRegistry.registerView("activityBar.item", "explorer", noopComponent, { title: "Explorer" });
    // Stands in for `packages/builtin/explorer`'s real `ExplorerView` —
    // forwards whatever `width` it's rendered with straight into the REAL
    // `Tree` (no fake/duck-typed stand-in needed here: this test lives in
    // `@tecode/core` itself, so it can use `Tree` directly), proving the
    // actual `Sidebar` -> `RegisteredView` -> `viewProps` -> `Tree` wiring
    // end to end rather than a builtin-side approximation of it.
    slotRegistry.registerView("sidebar.view", "explorer", (rawProps: Record<string, unknown>) => {
      const width = typeof rawProps["width"] === "number" ? rawProps["width"] : undefined;
      return (
        <Tree
          nodes={[{ id: "a", label: "a-very-long-file-name-that-would-otherwise-wrap.ts" }]}
          width={width}
        />
      );
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });

    const lines = captureCharFrame().split("\n");
    expect(lines[0]).toContain("…");
    expect(lines[0]).not.toContain("would-otherwise-wrap");
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

/** An in-memory {@link DocumentManagerFs} — every named file's content is
 * fixed at construction, and every other operation (`save`'s write/rename,
 * `stat`'s mode) is a harmless no-op/stub; these tests only ever open
 * documents, never save them (matches `documentManager.test.ts`'s own
 * `DocumentManagerFs` fakes in spirit, scoped down to just what "open a
 * document into the Shell" needs). */
function createInMemoryFs(files: Record<string, string>): DocumentManagerFs {
  return {
    async stat(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: files[path]!.length, mode: 0o644 };
    },
    async readFile(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    async writeFile() {},
    async chmod() {},
    async rename() {},
    async unlink() {},
  };
}

describe("Shell — EditorArea wired to a DocumentManager (Req 6.5, 6.6, design.md §8.1)", () => {
  test("opening a document renders it via EditorView, with a tab for its filename", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;\nconsole.log(x);" }),
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("No editor open.");

    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/hello.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    expect(frame).toContain("hello.ts"); // tab label
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain("console.log(x);");
    expect(frame).not.toContain("No editor open.");
  });

  test("a terminal taller than the old hardcoded 20-row default shows more than 20 lines (Issue #92 regression)", async () => {
    // Before this fix, `EditorView`'s `viewportHeight` was never threaded
    // from a live measurement at all (`editorView.tsx`'s pre-fix "Scope
    // note on `viewportHeight`"): `EditorArea` rendered `<EditorView>` with
    // no `viewportHeight` prop, so it always fell back to its own
    // `DEFAULT_VIEWPORT_HEIGHT` constant (20) no matter how tall the real
    // terminal was. This is the test that would have caught it: a document
    // with 60 lines, rendered into a terminal comfortably taller than 20
    // rows, must show lines well past index 20.
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const bigFile = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/big.ts": bigFile }),
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      // 50 rows total; one open tab (3-row tab bar) + the always-on 1-row
      // status bar is the only chrome in this fixture (no find widget, no
      // panel — `panelVisible` defaults `false`), leaving 46 rows for the
      // text plane (`viewport.test.ts`'s `computeEditorViewportHeight`
      // covers that arithmetic in isolation; this test proves it actually
      // reaches `EditorView` through `EditorArea`/`Shell`'s wiring).
      { width: 60, height: 50 },
    );
    await act(async () => {
      await renderOnce();
    });

    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/big.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    expect(frame).toContain("line0");
    // Line index 20 (the 21st line) is exactly one past the old hardcoded
    // cap — the pre-fix render could never show it no matter how tall the
    // terminal was.
    expect(frame).toContain("line20");
    // Line index 40 is well within the ~46-row viewport this fixture's
    // chrome leaves available, and nowhere near reachable under the old
    // fixed 20-row viewport.
    expect(frame).toContain("line40");
  });

  test("the tab bar shows the dirty marker the instant a document is edited, and drops it once saved (Task 3.5, Req 6.5)", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;" }),
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );

    let document!: Awaited<ReturnType<typeof documents.openDocument>>;
    await act(async () => {
      document = await documents.openDocument(pathToUri("/workspace/hello.ts"));
    });
    await act(async () => {
      await renderOnce();
    });
    // Not dirty yet — no marker.
    expect(captureCharFrame()).not.toContain("●");

    await act(async () => {
      document.applyEdits([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });
    // `document.onDidChange` fired -> useDocumentDirtyTick re-rendered the
    // Shell with no explicit `documents`-level event needed.
    expect(captureCharFrame()).toContain("●");

    await act(async () => {
      await documents.save(pathToUri("/workspace/hello.ts"));
    });
    await act(async () => {
      await renderOnce();
    });
    // `documents.onDidSave` fired (document.markSaved() itself fires no
    // onDidChange — this module's `useDocumentDirtyTick` TSDoc) -> the
    // marker is gone again.
    expect(captureCharFrame()).not.toContain("●");
  });

  test("closing the active document falls back to another open document", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({
        "/workspace/a.ts": "FIRST_FILE_CONTENT",
        "/workspace/b.ts": "SECOND_FILE_CONTENT",
      }),
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/a.ts"));
      await documents.openDocument(pathToUri("/workspace/b.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    // The most recently opened document is not necessarily active by
    // default (the first-opened document stays active until the user
    // switches) — only assert the first file's content shows.
    expect(captureCharFrame()).toContain("FIRST_FILE_CONTENT");

    act(() => {
      documents.close(pathToUri("/workspace/a.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    // Closing the active document falls back to another still-open one.
    expect(captureCharFrame()).toContain("SECOND_FILE_CONTENT");
  });

  test("selecting the second tab switches the active document's content", async () => {
    // Unlike the "closing the active document" test above, this one
    // actually drives the tab-selection path: `Tabs`' `<tab-select>`
    // (`components.tsx`) -> `EditorArea`'s `onSelectTab` ->
    // `Shell`'s `onSelectEditorTab`/`setActiveDocumentUri` (shell.tsx).
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({
        "/workspace/a.ts": "FIRST_FILE_CONTENT",
        "/workspace/b.ts": "SECOND_FILE_CONTENT",
      }),
    });

    const { renderOnce, renderer, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/a.ts"));
      await documents.openDocument(pathToUri("/workspace/b.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    // Both documents are open, but "a.ts" (opened first) is still active.
    expect(captureCharFrame()).toContain("FIRST_FILE_CONTENT");

    // Drive the real `<tab-select>` renderable exactly as a right-arrow +
    // enter keypress would (`TabSelectRenderable.handleKeyPress`'s own
    // `move-right`/`select-current` bindings): move off the first tab, then
    // fire the selection this component's `onSelect` prop listens for
    // (`components.tsx`'s `Tabs`) — not a direct call to `Shell`'s
    // `setActiveDocumentUri`, which would bypass the component wiring this
    // test exists to cover.
    const tabSelect = findTabSelect(renderer.root);
    expect(tabSelect).toBeDefined();
    act(() => {
      tabSelect?.moveRight();
      tabSelect?.selectCurrent();
    });
    await act(async () => {
      await renderOnce();
    });

    expect(captureCharFrame()).toContain("SECOND_FILE_CONTENT");
    expect(captureCharFrame()).not.toContain("FIRST_FILE_CONTENT");
  });

  test("no open documents keeps the 'No editor open.' placeholder", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({ log: createHostLog(), sink: createRecordingSink() });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} documents={documents} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(captureCharFrame()).toContain("No editor open.");
  });
});

describe("Shell — EditorArea's onTextPlaneNode stays stable across re-renders (CodeRabbit PR #59 Finding 5)", () => {
  test("editorTextFocus survives an editorSession.setState-driven re-render, and a subsequent routed key still edits the buffer", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;" }),
    });
    const editorSession = createEditorSessionService({ documents });

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    const document = await documents.openDocument(pathToUri("/workspace/hello.ts"));
    await act(async () => {
      await renderOnce();
    });

    // Find the text plane's own focusable box (`editorView.tsx`'s
    // `textPlaneRef`, distinct from `EditorArea`'s OWN outer focusable box)
    // by focusing each focusable descendant and keeping the one that sets
    // `editorTextFocus` specifically — the same "focus each, check exactly
    // one recognized key" idiom the focus-context-keys test above uses.
    const focusables = findAllFocusable(renderer.root) as BoxRenderable[];
    let textPlaneNode: BoxRenderable | undefined;
    for (const node of focusables) {
      node.focus();
      if (context.get<boolean>("editorTextFocus") === true) {
        textPlaneNode = node;
        break;
      }
      node.blur();
    }
    expect(textPlaneNode).toBeDefined();
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    // Simulate exactly what `editor/inputRouter.ts`'s `routeKeyEvent` does
    // after applying an edit: an `editorSession.setState` write-back, which
    // fires `onDidChange` and forces `Shell` (and therefore `EditorArea`)
    // to re-render.
    const state = editorSession.getState(document.uri);
    await act(async () => {
      editorSession.setState(document.uri, { ...state });
    });
    await act(async () => {
      await renderOnce();
    });

    // Before Finding 5's fix, `EditorArea`'s inline `onTextPlaneNode`
    // callback got a new function identity every render, so `EditorView`'s
    // `textPlaneRef` `useCallback` (deps include `onTextPlaneNode`) detached
    // and reattached its ref on the SAME underlying node — and `focus.tsx`'s
    // "detaching a still-focused node" fix (this same PR) force-reports
    // `editorTextFocus` FALSE on that detach, with no new `FOCUSED` event
    // ever firing to set it back true (the node's own internal focus flag
    // never actually changed). `editorTextFocus` must stay true across this
    // re-render.
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    // And the REAL-WORLD consequence: a subsequent routed keystroke must
    // still reach the buffer — `routeKeyEvent` gates entirely on
    // `editorTextFocus` (`inputRouter.ts`'s own TSDoc), so a spuriously
    // cleared key here would silently discard this insert.
    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent({
      name: "a",
      sequence: "a",
      ctrl: false,
      shift: false,
      option: false,
      meta: false,
    });
    expect(handled).toBe(true);
    expect(document.getLine(0)).toBe("aconst x = 1;");
  });
});

describe("Shell — FindWidget wiring (Req 11.1, design.md §13)", () => {
  test("opening find renders the widget and focuses it; closing hides it and returns focus to the text", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;\nconsole.log(x);" }),
    });
    const editorSession = createEditorSessionService({ documents });
    const findService = createFindService({ editorSession });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
            findService={findService}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/hello.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    // Not open yet: no widget in the frame, no findWidgetFocus.
    expect(captureCharFrame()).not.toContain("Replace");
    expect(context.get<boolean>("findWidgetFocus")).toBeUndefined();

    await act(async () => {
      findService.open();
    });
    await act(async () => {
      await renderOnce();
    });

    // Open: the widget renders (its "Replace" placeholder is a reliable,
    // unambiguous marker distinct from the buffer's own text) and its query
    // input is focused (Req 11.1's "ctrl+f opens focused").
    expect(captureCharFrame()).toContain("Replace");
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);

    await act(async () => {
      findService.close();
    });
    await act(async () => {
      await renderOnce();
    });

    // Closed: the widget is gone, findWidgetFocus is no longer stuck true
    // (the `focus.tsx` fix for a still-focused node detaching), and focus
    // returned to the editor's text plane (Req 11.1's "Escape closes
    // returning focus to the text").
    expect(captureCharFrame()).not.toContain("Replace");
    expect(context.get<boolean>("findWidgetFocus")).toBe(false);
    expect(context.get<boolean>("editorTextFocus")).toBe(true);
  });

  test("closing find still returns focus to the text when the REPLACE input (not the query input) held focus (CodeRabbit PR #59 Finding 4)", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;\nconsole.log(x);" }),
    });
    const editorSession = createEditorSessionService({ documents });
    const findService = createFindService({ editorSession });

    const { renderOnce, renderer, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
            findService={findService}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await act(async () => {
      await documents.openDocument(pathToUri("/workspace/hello.ts"));
    });
    await act(async () => {
      await renderOnce();
    });

    await act(async () => {
      findService.open();
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);

    // Move OpenTUI's real focus pointer onto the REPLACE input — before
    // Finding 4's fix, only the query input tracked `findWidgetFocus`, so
    // this transition would have left the key stuck `false`, and the
    // `escape` keybinding (`when: "findWidgetFocus"`) would never have
    // resolved to `editor.action.findClose` at all: pressing Escape while
    // typing in the replace field would silently do nothing.
    const replaceInput = findInputByPlaceholder(renderer.root, "Replace");
    expect(replaceInput).toBeDefined();
    replaceInput!.focus();
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);

    // Simulates exactly what the `escape` keybinding does once the keymap
    // resolves it (`ctx.api.editor.find.close()`) — the context-key
    // resolution itself is asserted above; this proves the CLOSE side
    // effect (widget unmounts, focus returns to the text) still fires
    // correctly when triggered while the replace input, not the query
    // input, held focus.
    await act(async () => {
      findService.close();
    });
    await act(async () => {
      await renderOnce();
    });

    expect(captureCharFrame()).not.toContain("Replace");
    expect(context.get<boolean>("findWidgetFocus")).toBe(false);
    expect(context.get<boolean>("editorTextFocus")).toBe(true);
  });

  test("typing while the find widget is focused updates the query, not the buffer", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "const x = 1;" }),
    });
    const editorSession = createEditorSessionService({ documents });
    const findService = createFindService({ editorSession });

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
            findService={findService}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    const document = await documents.openDocument(pathToUri("/workspace/hello.ts"));
    await act(async () => {
      findService.open();
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);
    // With `findWidgetFocus` true, the buffer's own `editorTextFocus` is
    // NOT set — `editor/inputRouter.ts` gates every insert on that key, so
    // a keystroke reaching the buffer at all requires it to be true. Typed
    // characters go through `findService.setQuery` (`findWidget.tsx`'s
    // `Input onChange`), never through `document.applyEdits`.
    expect(context.get<boolean>("editorTextFocus")).toBeFalsy();

    await act(async () => {
      findService.setQuery("const");
    });
    await act(async () => {
      await renderOnce();
    });

    expect(document.getLine(0)).toBe("const x = 1;"); // buffer unchanged
    expect(captureCharFrame()).toContain("1/1"); // one match found
  });
});

describe("Shell — layoutState.onDidChange keeps React in sync with external writers (Issue #101)", () => {
  test("layoutState.update({ panelVisible: true }) called from outside Shell makes the panel visible immediately", async () => {
    // This is the regression test for Issue #101: `useLayoutState` used to
    // keep its own optimistic `useState` copy in sync only because the
    // Shell was assumed to be `layoutState`'s one and only writer
    // (`shell.tsx`'s TSDoc). `panelCommands.ts`'s `workbench.action.showPanel`
    // handler (Issue #98) broke that assumption — it holds only
    // `layoutState` and calls `update()` directly, with no Shell handler
    // anywhere in the loop — so before this fix, running that command left
    // `panelVisible: true` persisted to disk while the *running* Shell kept
    // rendering the panel hidden until the next restart re-seeded
    // `useState` from `ready`. This test drives exactly that shape: an
    // `update()` call from outside `Shell` entirely, asserted against the
    // real rendered frame rather than an internal prop.
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    slotRegistry.registerView(
      "panel.tab",
      "demo.terminal",
      () => <text>Demo Terminal Content</text>,
      { title: "Terminal" },
    );

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 60, height: 20 },
    );
    await act(async () => { await renderOnce(); });
    // `panelVisible` defaults `false` (`DEFAULT_LAYOUT_STATE`) — the panel,
    // and therefore its tab's content, is not rendered yet.
    expect(captureCharFrame()).not.toContain("Demo Terminal Content");

    // The external write — no Shell prop, handler, or command dispatch
    // involved, exactly like `panelCommands.ts`'s handler.
    act(() => {
      layoutState.update({ panelVisible: true });
    });
    await act(async () => {
      await renderOnce();
    });

    expect(captureCharFrame()).toContain("Demo Terminal Content");
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

/** Depth-first search for an OpenTUI `<input>` renderable by its
 * `placeholder` text (matches `findAllFocusable`/`findTabSelect`'s idiom
 * above) — used only by the find-widget focus test to drive the real
 * query/replace `Renderable.focus()` without `FindWidget`/`Shell` exposing
 * test-only refs on their public props. */
function findInputByPlaceholder(node: unknown, placeholder: string): { focus(): void } | undefined {
  const candidate = node as { placeholder?: string; focus?: () => void; getChildren?: () => unknown[] };
  if (candidate?.placeholder === placeholder && candidate.focus) {
    return candidate as { focus(): void };
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findInputByPlaceholder(child, placeholder);
    if (found) return found;
  }
  return undefined;
}

/** Depth-first search for the `<tab-select>` renderable `Tabs`
 * (`components.tsx`) mounts — used only by the tab-selection test above to
 * drive the real `TabSelectRenderable.moveRight`/`selectCurrent` methods
 * (the same pair `handleKeyPress`'s `move-right`/`select-current`
 * keybindings call), rather than reaching into `Shell`'s state directly. */
function findTabSelect(node: unknown): TabSelectRenderable | undefined {
  if (node instanceof TabSelectRenderable) return node;
  const candidate = node as { getChildren?: () => unknown[] };
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findTabSelect(child);
    if (found) return found;
  }
  return undefined;
}
