/**
 * Structural/snapshot tests for the minimal common component library
 * (`tecode.ui.List`/`Tree`/`Input`/`Tabs`, Req 10.1, 6.3) — headless via
 * `@opentui/react`'s `testRender` (see `shell.snapshot.test.tsx`'s top-of-file TSDoc
 * for the full "what OpenTUI headless-testing API we use" writeup).
 */

import { describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import type { CapturedFrame, KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ComponentType } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";
import { createContextService } from "../keymap/context";
import { ContextFocusTracker, type FocusableNode } from "./focus";
import { toColorInput } from "./theme";
import {
  List,
  RegisteredView,
  TAB_DIRTY_MARKER,
  Tabs,
  Tree,
  type ListItem,
  type TabItem,
  type TreeNode,
} from "./components";

/** All spans across every row of a captured frame, flattened with their row
 * index (matches `editorView.snapshot.test.tsx`'s own local `flatten` helper) —
 * convenient for "find the span covering this tab's text" assertions
 * without hand-walking `frame.lines`. */
function flattenSpans(
  frame: CapturedFrame,
): Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> {
  const out: Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> = [];
  frame.lines.forEach((line, row) => {
    let col = 0;
    for (const span of line.spans) {
      out.push({ row, col, text: span.text, fg: span.fg, bg: span.bg });
      col += span.width;
    }
  });
  return out;
}

/** A minimal `KeyEvent`-shaped object for driving {@link Tree}'s `onKeyDown`
 * directly (this suite's "keyboard nav" tests) — only `name` matters to
 * `Tree`'s handler, so every other `KeyEvent` field is a harmless dummy. */
function keyEvent(name: string): KeyEvent {
  return { name, ctrl: false, shift: false, option: false, meta: false, sequence: "" } as KeyEvent;
}

describe("List (tecode.ui.List)", () => {
  test("renders every item's label", async () => {
    const items: ListItem[] = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ];
    const { renderOnce, captureCharFrame } = await testRender(<List items={items} />, {
      width: 30,
      height: 20,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
  });
});

describe("Tree (tecode.ui.Tree)", () => {
  test("renders top-level node labels; collapsed children stay hidden", async () => {
    const nodes: TreeNode[] = [
      { id: "root", label: "src", children: [{ id: "child", label: "index.ts" }] },
    ];
    const { renderOnce, captureCharFrame } = await testRender(<Tree nodes={nodes} />, {
      width: 30,
      height: 6,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("src");
    expect(frame).not.toContain("index.ts");
  });

  test("defaultExpanded reveals children immediately", async () => {
    const nodes: TreeNode[] = [
      { id: "root", label: "src", children: [{ id: "child", label: "index.ts" }] },
    ];
    const { renderOnce, captureCharFrame } = await testRender(
      <Tree nodes={nodes} defaultExpanded={["root"]} />,
      { width: 30, height: 6 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("src");
    expect(frame).toContain("index.ts");
  });

  describe("hasChildren override (Task 3.3, Req 11.2 — lazy-loaded directories)", () => {
    test("shows the expand arrow for a node with hasChildren:true but no children array yet", async () => {
      const nodes: TreeNode[] = [{ id: "dir", label: "src", hasChildren: true }];
      const { renderOnce, captureCharFrame } = await testRender(<Tree nodes={nodes} />, {
        width: 30,
        height: 4,
      });
      await renderOnce();
      expect(captureCharFrame()).toContain("▸ src");
    });

    test("expanding a hasChildren:true node with no children yet reveals nothing (not yet loaded) without crashing", async () => {
      const nodes: TreeNode[] = [{ id: "dir", label: "src", hasChildren: true }];
      const { renderOnce, captureCharFrame } = await testRender(
        <Tree nodes={nodes} expandedIds={["dir"]} />,
        { width: 30, height: 4 },
      );
      await renderOnce();
      expect(captureCharFrame()).toContain("▾ src");
    });
  });

  describe("controlled expansion (Task 3.3, Req 11.2)", () => {
    test("expandedIds drives visibility instead of internal state", async () => {
      const nodes: TreeNode[] = [
        { id: "root", label: "src", children: [{ id: "child", label: "index.ts" }] },
      ];
      const { renderOnce, captureCharFrame } = await testRender(
        <Tree nodes={nodes} expandedIds={["root"]} />,
        { width: 30, height: 6 },
      );
      await renderOnce();
      expect(captureCharFrame()).toContain("index.ts");
    });

    test("uncontrolled mode still calls onToggle alongside managing its own state (keyboard-driven)", async () => {
      const nodes: TreeNode[] = [
        { id: "root", label: "src", children: [{ id: "child", label: "index.ts" }] },
      ];
      const toggles: Array<{ id: string; expanding: boolean }> = [];
      let captured: FocusableNode | null = null;
      const { renderOnce, captureCharFrame } = await testRender(
        <Tree
          nodes={nodes}
          selectedId="root"
          onToggle={(id: string, expanding: boolean) => toggles.push({ id, expanding })}
          treeRef={(node: FocusableNode | null) => (captured = node)}
        />,
        { width: 30, height: 6 },
      );
      await renderOnce();
      expect(captured).not.toBeNull();

      await act(() => {
        (captured as unknown as { onKeyDown?: (key: KeyEvent) => void }).onKeyDown?.(keyEvent("right"));
      });
      await renderOnce();

      expect(toggles).toEqual([{ id: "root", expanding: true }]);
      expect(captureCharFrame()).toContain("index.ts");
    });
  });

  describe("width (Issue #104): truncates the label only, never the indent/glyph", () => {
    test("a label wider than the available row budget is truncated with an ellipsis, without wrapping", async () => {
      const nodes: TreeNode[] = [
        { id: "a", label: "a-very-long-file-name-that-would-otherwise-wrap.ts" },
        { id: "b", label: "b.ts" },
      ];
      const { renderOnce, captureCharFrame } = await testRender(<Tree nodes={nodes} width={15} />, {
        width: 15,
        height: 6,
      });
      await renderOnce();
      const lines = captureCharFrame().split("\n");
      expect(lines[0]).toContain("…");
      expect(lines[0]).not.toContain("would-otherwise-wrap");
      // The long label above did NOT wrap onto a second row and push this
      // one down — "b" lands on the very next row, one per node.
      expect(lines[1]).toContain("b.ts");
    });

    test("indentation and the expand/collapse glyph are never truncated — only the label shrinks", async () => {
      const nodes: TreeNode[] = [
        {
          id: "root",
          label: "src",
          hasChildren: true,
          children: [
            {
              id: "child",
              label: "lib",
              hasChildren: true,
              children: [{ id: "grandchild", label: "a-long-enough-label-to-overflow.ts" }],
            },
          ],
        },
      ];
      const { renderOnce, captureCharFrame } = await testRender(
        <Tree nodes={nodes} expandedIds={["root", "child"]} width={5} />,
        { width: 20, height: 6 },
      );
      await renderOnce();
      const lines = captureCharFrame().split("\n");
      // The grandchild is a depth-2 leaf: indent "    " (4 cols) + glyph
      // "  " (2 cols) = 6 fixed prefix columns — already WIDER than the
      // 5-column width passed in. Its own label budget (5 - 2*2 - 2 = -1)
      // is negative, so `truncateToWidth` returns "" outright (this
      // module's TreeProps.width TSDoc) rather than slicing into the
      // indent/glyph to make room for an ellipsis: the row is exactly 6
      // blank columns, no ellipsis, no shortened indent.
      expect(lines[2]!.slice(0, 6)).toBe("      ");
      expect(lines[2]).not.toContain("…");
    });

    test("omitting width preserves the original (wrapping) behavior unchanged", async () => {
      const nodes: TreeNode[] = [
        { id: "a", label: "a-very-long-file-name-that-would-wrap.ts" },
        { id: "b", label: "b.ts" },
      ];
      const { renderOnce, captureCharFrame } = await testRender(<Tree nodes={nodes} />, {
        width: 15,
        height: 6,
      });
      await renderOnce();
      // No width prop: the full, untruncated label is still handed to
      // `<text>` exactly as before #104 — no "…" appears anywhere, and the
      // label, wider than the 15-column terminal, wraps onto extra rows
      // (confirmed here by fragments of it landing on more than one row,
      // and "b.ts" consequently being pushed past row 1 — this module's
      // pre-#104, still-reachable-when-`width`-is-omitted behavior).
      const lines = captureCharFrame().split("\n");
      expect(captureCharFrame()).not.toContain("…");
      expect(lines[0]).toContain("a-very-long-");
      expect(lines[1]).toContain("file-name-that-");
      expect(lines[1]).not.toContain("b.ts");
    });
  });

  describe("keyboard nav while focused (Task 3.3, Req 11.2)", () => {
    const NODES: TreeNode[] = [
      {
        id: "src",
        label: "src",
        children: [
          { id: "a.ts", label: "a.ts" },
          { id: "b.ts", label: "b.ts" },
        ],
      },
      { id: "readme", label: "README.md" },
    ];

    /**
     * Renders `<Tree>` behind a small stateful harness that feeds `onSelect`
     * back into `selectedId` (a real caller — the explorer built-in included
     * — always does this; a test driving MULTIPLE sequential key presses and
     * asserting each one's effect on the NEXT press needs the same
     * round-trip, or `selectedId` would stay frozen at whatever the test
     * passed in initially). `initial.onSelect`/`onToggle`/`onActivate` are
     * still invoked (for assertions) alongside the harness's own bookkeeping.
     */
    async function renderTree(initial: {
      selectedId?: string;
      expandedIds?: string[];
      onSelect?: (id: string) => void;
      onToggle?: (id: string, expanding: boolean) => void;
      onActivate?: (id: string) => void;
    }): Promise<{ press: (name: string) => Promise<void> }> {
      let captured: FocusableNode | null = null;

      function Harness(): ReturnType<typeof Tree> {
        const [selectedId, setSelectedId] = useState(initial.selectedId);
        return (
          <Tree
            nodes={NODES}
            selectedId={selectedId}
            expandedIds={initial.expandedIds}
            treeRef={(node: FocusableNode | null) => (captured = node)}
            onSelect={(id: string) => {
              setSelectedId(id);
              initial.onSelect?.(id);
            }}
            onToggle={initial.onToggle}
            onActivate={initial.onActivate}
          />
        );
      }

      const { renderOnce } = await testRender(<Harness />, { width: 30, height: 10 });
      await renderOnce();
      return {
        press: async (name: string) => {
          await act(() => {
            (captured as unknown as { onKeyDown?: (key: KeyEvent) => void })?.onKeyDown?.(keyEvent(name));
          });
          await renderOnce();
        },
      };
    }

    test("down/up move selection across visible top-level nodes", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({ onSelect: (id) => selected.push(id) });

      await press("down");
      expect(selected).toEqual(["src"]);

      await press("down"); // src has children but is collapsed -> next visible is "readme"
      expect(selected).toEqual(["src", "readme"]);

      await press("up");
      expect(selected).toEqual(["src", "readme", "src"]);
    });

    test("down walks into an expanded branch's children in visible order", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({
        selectedId: "src",
        expandedIds: ["src"],
        onSelect: (id) => selected.push(id),
      });

      await press("down");
      expect(selected).toEqual(["a.ts"]);
    });

    test("right expands a collapsed branch without moving selection", async () => {
      const toggles: Array<{ id: string; expanding: boolean }> = [];
      const { press } = await renderTree({
        selectedId: "src",
        expandedIds: [],
        onToggle: (id, expanding) => toggles.push({ id, expanding }),
      });

      await press("right");
      expect(toggles).toEqual([{ id: "src", expanding: true }]);
    });

    test("right on an already-expanded branch moves selection to its first child", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({
        selectedId: "src",
        expandedIds: ["src"],
        onSelect: (id) => selected.push(id),
      });

      await press("right");
      expect(selected).toEqual(["a.ts"]);
    });

    test("right on a leaf node is a no-op", async () => {
      const selected: string[] = [];
      const toggles: unknown[] = [];
      const { press } = await renderTree({
        selectedId: "readme",
        onSelect: (id) => selected.push(id),
        onToggle: (id, expanding) => toggles.push({ id, expanding }),
      });

      await press("right");
      expect(selected).toEqual([]);
      expect(toggles).toEqual([]);
    });

    test("left collapses an expanded branch without moving selection", async () => {
      const toggles: Array<{ id: string; expanding: boolean }> = [];
      const { press } = await renderTree({
        selectedId: "src",
        expandedIds: ["src"],
        onToggle: (id, expanding) => toggles.push({ id, expanding }),
      });

      await press("left");
      expect(toggles).toEqual([{ id: "src", expanding: false }]);
    });

    test("left on a child node moves selection to its parent", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({
        selectedId: "a.ts",
        expandedIds: ["src"],
        onSelect: (id) => selected.push(id),
      });

      await press("left");
      expect(selected).toEqual(["src"]);
    });

    test("left on a top-level leaf with no parent is a no-op", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({ selectedId: "readme", onSelect: (id) => selected.push(id) });

      await press("left");
      expect(selected).toEqual([]);
    });

    test("return activates the selected leaf node", async () => {
      const activated: string[] = [];
      const { press } = await renderTree({ selectedId: "readme", onActivate: (id) => activated.push(id) });

      await press("return");
      expect(activated).toEqual(["readme"]);
    });

    test("return on a branch node both toggles it and activates it", async () => {
      const activated: string[] = [];
      const toggles: Array<{ id: string; expanding: boolean }> = [];
      const { press } = await renderTree({
        selectedId: "src",
        expandedIds: [],
        onActivate: (id) => activated.push(id),
        onToggle: (id, expanding) => toggles.push({ id, expanding }),
      });

      await press("return");
      expect(toggles).toEqual([{ id: "src", expanding: true }]);
      expect(activated).toEqual(["src"]);
    });

    test("an unrecognized key is a no-op", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({ selectedId: "readme", onSelect: (id) => selected.push(id) });

      await press("a");
      expect(selected).toEqual([]);
    });

    test("down with no current selection lands on the first visible node", async () => {
      const selected: string[] = [];
      const { press } = await renderTree({ onSelect: (id) => selected.push(id) });

      await press("down");
      expect(selected).toEqual(["src"]);
    });
  });

  describe("focusContextKey (Task 3.3, Req 4.6, 11.2)", () => {
    test("reports focus gain/loss on the root box to the given context key", async () => {
      const context = createContextService();
      let captured: FocusableNode | null = null;
      const { renderOnce } = await testRender(
        <ContextFocusTracker context={context}>
          <Tree nodes={[{ id: "a", label: "a" }]} focusContextKey="explorerFocus" treeRef={(n: FocusableNode | null) => (captured = n)} />
        </ContextFocusTracker>,
        { width: 20, height: 5 },
      );
      await renderOnce();

      expect(context.get<boolean>("explorerFocus")).toBeUndefined();
      (captured as unknown as { focus: () => void }).focus();
      expect(context.get<boolean>("explorerFocus")).toBe(true);
      (captured as unknown as { blur: () => void }).blur();
      expect(context.get<boolean>("explorerFocus")).toBe(false);
    });

    test("omitting focusContextKey reports nothing (backward compatible)", async () => {
      const context = createContextService();
      let captured: FocusableNode | null = null;
      const { renderOnce } = await testRender(
        <ContextFocusTracker context={context}>
          <Tree nodes={[{ id: "a", label: "a" }]} treeRef={(n: FocusableNode | null) => (captured = n)} />
        </ContextFocusTracker>,
        { width: 20, height: 5 },
      );
      await renderOnce();

      (captured as unknown as { focus: () => void }).focus();
      expect(context.get<boolean>("explorerFocus")).toBeUndefined();
    });
  });
});

describe("Tabs (tecode.ui.Tabs)", () => {
  test("renders every tab's label", async () => {
    const tabs: TabItem[] = [
      { id: "a", label: "main.ts" },
      { id: "b", label: "utils.ts" },
    ];
    const { renderOnce, captureCharFrame } = await testRender(<Tabs tabs={tabs} />, {
      width: 60,
      height: 3,
    });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("main.ts");
    expect(frame).toContain("utils.ts");
  });

  test("a dirty tab's displayed name carries the dirty marker; a non-dirty tab's does not (Task 3.5, Req 6.5)", async () => {
    const tabs: TabItem[] = [
      { id: "a", label: "main.ts", dirty: true },
      { id: "b", label: "utils.ts", dirty: false },
      { id: "c", label: "readme.md" }, // dirty omitted entirely — same as false.
    ];
    const { renderOnce, captureCharFrame } = await testRender(<Tabs tabs={tabs} />, {
      width: 60,
      height: 3,
    });
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain(`${TAB_DIRTY_MARKER}main.ts`);
    expect(frame).toContain("utils.ts");
    expect(frame).not.toContain(`${TAB_DIRTY_MARKER}utils.ts`);
    expect(frame).toContain("readme.md");
    expect(frame).not.toContain(`${TAB_DIRTY_MARKER}readme.md`);
  });

  test("the active tab (via activeId) carries the theme's selected tab colors; the inactive tab does not", async () => {
    const theme = createBaseTheme();
    const tabs: TabItem[] = [
      { id: "a", label: "main.ts" },
      { id: "b", label: "utils.ts" },
    ];
    const { renderOnce, captureSpans } = await testRender(<Tabs tabs={tabs} activeId="a" />, {
      width: 60,
      height: 3,
    });
    await renderOnce();

    const spans = flattenSpans(captureSpans());
    const activeBg = toColorInput(theme.colors["tab.activeBackground"]);
    const activeFg = toColorInput(theme.colors["tab.activeForeground"]);
    const inactiveBg = toColorInput(theme.colors["tab.inactiveBackground"]);

    const mainSpans = spans.filter((s) => s.text.includes("main.ts"));
    const utilsSpans = spans.filter((s) => s.text.includes("utils.ts"));
    expect(mainSpans.length).toBeGreaterThan(0);
    expect(utilsSpans.length).toBeGreaterThan(0);

    for (const span of mainSpans) {
      expect(JSON.stringify(span.bg)).toBe(JSON.stringify(activeBg));
      expect(JSON.stringify(span.fg)).toBe(JSON.stringify(activeFg));
    }
    for (const span of utilsSpans) {
      expect(JSON.stringify(span.bg)).toBe(JSON.stringify(inactiveBg));
      expect(JSON.stringify(span.bg)).not.toBe(JSON.stringify(activeBg));
    }
  });
});

describe("RegisteredView (bridging @tecode/api's ComponentType)", () => {
  test("invokes the registered component with the given props", async () => {
    const seen: Record<string, unknown>[] = [];
    const component = (props: Record<string, unknown>) => {
      seen.push(props);
      return <text>{String(props["label"])}</text>;
    };
    const { renderOnce, captureCharFrame } = await testRender(
      <RegisteredView component={component} viewProps={{ label: "hello from extension" }} />,
      { width: 40, height: 3 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("hello from extension");
    // Rendering as a real element (rather than calling `component` inline —
    // see components.tsx's TSDoc) means React itself decides how many
    // times the underlying component body runs; asserting "at least once,
    // with the right props" is what actually matters here, not an exact
    // render count React's own scheduling is free to change.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ label: "hello from extension" });
  });

  test("swaps cleanly between registered views with different hook counts at the same position, with no state bleed", async () => {
    // Reproduces the exact scenario components.tsx's TSDoc warns about:
    // calling `component(props)` directly inside RegisteredView's own
    // render body would attach `ComponentA`'s `useState` to RegisteredView's
    // *own* hook state, so swapping to a zero-hook `ComponentB` at the same
    // JSX position would throw "Rendered fewer hooks than expected".
    // Rendering as `<Component .../>` instead gives each registered
    // component its own fiber, so the swap must render fine both ways and
    // never leak state across the swap.
    let setActive: ((id: "a" | "b") => void) | undefined;

    const ComponentA: ComponentType = () => {
      const [count, setCount] = useState(0);
      // Mutates its own state once after mount so a later remount is
      // provably starting fresh (0, then bumped to 1) rather than
      // resuming some stale, shared fiber's state.
      useEffect(() => {
        setCount(1);
      }, []);
      return <text>{`A:${count}`}</text>;
    };
    const ComponentB: ComponentType = () => <text>B (no hooks)</text>;

    function Harness() {
      const [active, setActiveState] = useState<"a" | "b">("a");
      setActive = setActiveState;
      return <RegisteredView component={active === "a" ? ComponentA : ComponentB} />;
    }

    const { renderOnce, captureCharFrame } = await testRender(<Harness />, { width: 40, height: 3 });
    await act(async () => {
      await renderOnce();
    });
    await act(async () => {
      await renderOnce();
    }); // flushes ComponentA's mount effect (count 0 -> 1)
    expect(captureCharFrame()).toContain("A:1");

    // Swap to the zero-hook component — must not throw.
    expect(() => {
      act(() => setActive?.("b"));
    }).not.toThrow();
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("B (no hooks)");

    // Swap back to A: a fresh mount runs its `useState(0)` + mount effect
    // from scratch, landing on the same "A:1" a first mount would — not
    // some other value a shared/stale fiber might have carried over,
    // proving no state bled through the swap.
    act(() => setActive?.("a"));
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("A:1");
  });
});
