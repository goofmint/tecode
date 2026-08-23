/**
 * Structural/snapshot tests for the minimal common component library
 * (`tecode.ui.List`/`Tree`/`Input`/`Tabs`, Req 10.1, 6.3) — headless via
 * `@opentui/react`'s `testRender` (see `shell.test.tsx`'s top-of-file TSDoc
 * for the full "what OpenTUI headless-testing API we use" writeup).
 */

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
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
    expect(seen).toEqual([{ label: "hello from extension" }]);
  });
});
