/**
 * Structural/snapshot tests for the minimal common component library
 * (`tecode.ui.List`/`Tree`/`Input`/`Tabs`, Req 10.1, 6.3) — headless via
 * `@opentui/react`'s `testRender` (see `shell.test.tsx`'s top-of-file TSDoc
 * for the full "what OpenTUI headless-testing API we use" writeup).
 */

import { describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ComponentType } from "@tecode/api";
import { List, RegisteredView, Tabs, Tree, type ListItem, type TabItem, type TreeNode } from "./components";

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
