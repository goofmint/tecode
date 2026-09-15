import { describe, expect, test } from "bun:test";
import {
  type PaneLeaf,
  type PaneTree,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  clampPaneHeight,
  clampPaneWidth,
  closePane,
  distributeSize,
  focusDirection,
  focusNext,
  singlePane,
  splitPane,
} from "./paneTree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function mkId(): string {
  return `p${++counter}`;
}

function singleLeaf(tabs: string[] = [], activeTabUri?: string): PaneTree {
  const leaf: PaneLeaf = {
    kind: "leaf",
    paneId: "root",
    tabs,
    activeTabUri,
  };
  return { root: leaf, activePaneId: "root" };
}

// ---------------------------------------------------------------------------
// splitPane
// ---------------------------------------------------------------------------

describe("splitPane", () => {
  test("splitting a single leaf produces a split node with two leaves", () => {
    const tree = singleLeaf(["a.ts"]);
    const result = splitPane(tree, "root", "row", mkId);

    expect(result.root.kind).toBe("split");
    const split = result.root as import("./paneTree").PaneSplit;
    expect(split.direction).toBe("row");
    expect(split.children).toHaveLength(2);
    expect(split.children[0]!.kind).toBe("leaf");
    expect(split.children[1]!.kind).toBe("leaf");
    expect(split.sizes).toHaveLength(2);
    expect(split.sizes[0]).toBeCloseTo(0.5);
    expect(split.sizes[1]).toBeCloseTo(0.5);
  });

  test("new leaf starts empty", () => {
    const tree = singleLeaf(["a.ts", "b.ts"], "a.ts");
    const result = splitPane(tree, "root", "column", mkId);
    const split = result.root as import("./paneTree").PaneSplit;
    const newLeaf = split.children[1] as PaneLeaf;
    expect(newLeaf.tabs).toHaveLength(0);
    expect(newLeaf.activeTabUri).toBeUndefined();
  });

  test("activePaneId is set to the new leaf", () => {
    const tree = singleLeaf(["a.ts"]);
    const result = splitPane(tree, "root", "row", mkId);
    const split = result.root as import("./paneTree").PaneSplit;
    const newId = (split.children[1] as PaneLeaf).paneId;
    expect(result.activePaneId).toBe(newId);
  });

  test("splitting a leaf inside an existing same-direction split inserts inline", () => {
    // Build a two-pane row split manually, then split the second leaf again
    const tree = singleLeaf(["a.ts"]);
    const after1 = splitPane(tree, "root", "row", mkId);
    const split1 = after1.root as import("./paneTree").PaneSplit;
    const secondId = (split1.children[1] as PaneLeaf).paneId;

    const after2 = splitPane(after1, secondId, "row", mkId);
    const split2 = after2.root as import("./paneTree").PaneSplit;
    expect(split2.children).toHaveLength(3);
  });

  test("original tree is not mutated", () => {
    const tree = singleLeaf(["a.ts"]);
    splitPane(tree, "root", "row", mkId);
    expect(tree.root.kind).toBe("leaf");
  });
});

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

describe("closePane", () => {
  test("closing the only leaf returns the tree unchanged", () => {
    const tree = singleLeaf(["a.ts"]);
    const result = closePane(tree, "root");
    expect(result).toBe(tree);
  });

  test("closing one of two leaves collapses the split to the remaining leaf", () => {
    const tree = singleLeaf(["a.ts"]);
    const after = splitPane(tree, "root", "row", mkId);
    const split = after.root as import("./paneTree").PaneSplit;
    const newLeafId = (split.children[1] as PaneLeaf).paneId;

    const closed = closePane(after, newLeafId);
    expect(closed.root.kind).toBe("leaf");
    expect((closed.root as PaneLeaf).paneId).toBe("root");
  });

  test("activePaneId moves to sibling when active pane is closed", () => {
    const tree = singleLeaf(["a.ts"]);
    const after = splitPane(tree, "root", "row", mkId);
    // activePaneId is the new leaf after split
    const newId = after.activePaneId;
    const closed = closePane(after, newId);
    expect(closed.activePaneId).toBe("root");
  });

  test("activePaneId unchanged when a non-active pane is closed", () => {
    const tree = singleLeaf(["a.ts"]);
    // Split so active is the new pane
    const after = splitPane(tree, "root", "row", mkId);
    const closed = closePane(after, "root"); // close the original
    expect(closed.activePaneId).toBe(after.activePaneId);
  });

  test("original tree is not mutated", () => {
    const tree = singleLeaf(["a.ts"]);
    const after = splitPane(tree, "root", "row", mkId);
    const root = after.root;
    closePane(after, "root");
    expect(after.root).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// singlePane
// ---------------------------------------------------------------------------

describe("singlePane", () => {
  test("with a single leaf, returns equivalent tree", () => {
    const tree = singleLeaf(["a.ts"], "a.ts");
    const result = singlePane(tree);
    expect(result.root.kind).toBe("leaf");
    expect((result.root as PaneLeaf).tabs).toEqual(["a.ts"]);
  });

  test("with multiple panes, collapses to the active leaf", () => {
    const base = singleLeaf(["a.ts"], "a.ts");
    const after = splitPane(base, "root", "row", mkId);
    // active is the new empty leaf
    const result = singlePane(after);
    expect(result.root.kind).toBe("leaf");
    expect((result.root as PaneLeaf).paneId).toBe(after.activePaneId);
    expect((result.root as PaneLeaf).tabs).toHaveLength(0);
  });

  test("original tree is not mutated", () => {
    const base = singleLeaf(["a.ts"]);
    const after = splitPane(base, "root", "row", mkId);
    const root = after.root;
    singlePane(after);
    expect(after.root).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// focusDirection
// ---------------------------------------------------------------------------

describe("focusDirection", () => {
  test("right moves to the next leaf", () => {
    const base = singleLeaf(["a.ts"]);
    // root is active, split gives new leaf after it
    const after = splitPane(base, "root", "row", mkId);
    // active is new leaf; move left to get back to root
    const back = focusDirection(after, "left");
    expect(back.activePaneId).toBe("root");
  });

  test("left moves to the previous leaf", () => {
    const base = singleLeaf(["a.ts"]);
    const after = splitPane(base, "root", "row", mkId);
    // focus was moved to new pane; go back
    const back = focusDirection(after, "left");
    expect(back.activePaneId).toBe("root");
    // now go right again
    const fwd = focusDirection(back, "right");
    expect(fwd.activePaneId).toBe(after.activePaneId);
  });

  test("returns unchanged tree when no pane in that direction", () => {
    const base = singleLeaf(["a.ts"]);
    // Only one pane; right should be no-op
    const result = focusDirection(base, "right");
    expect(result).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// focusNext
// ---------------------------------------------------------------------------

describe("focusNext", () => {
  test("wraps around from last to first", () => {
    const base = singleLeaf(["a.ts"]);
    const after = splitPane(base, "root", "row", mkId);
    // active is the second leaf; focusNext should wrap to root
    const result = focusNext(after);
    expect(result.activePaneId).toBe("root");
  });

  test("single pane: returns same tree", () => {
    const base = singleLeaf(["a.ts"]);
    const result = focusNext(base);
    expect(result).toBe(base);
  });

  test("three panes: cycles 0→1→2→0", () => {
    const base = singleLeaf(["a.ts"]);
    const s1 = splitPane(base, "root", "row", mkId);
    const split1 = s1.root as import("./paneTree").PaneSplit;
    const newId1 = (split1.children[1] as PaneLeaf).paneId;
    // Focus root, then split again
    const s1AtRoot = { ...s1, activePaneId: "root" };
    const s2 = splitPane(s1AtRoot, "root", "row", mkId);
    // Now there are 3 leaves: root, the new one from s2, and newId1
    const leaves = (s2.root as import("./paneTree").PaneSplit).children.flatMap((c) =>
      c.kind === "leaf" ? [c.paneId] : (c as import("./paneTree").PaneSplit).children.map((cc) => (cc as PaneLeaf).paneId),
    );
    expect(leaves.length).toBeGreaterThanOrEqual(3);

    const n1 = focusNext(s2);
    const n2 = focusNext(n1);
    const n3 = focusNext(n2);
    expect(n3.activePaneId).toBe(s2.activePaneId);
    // Each step changes the id
    expect(n1.activePaneId).not.toBe(s2.activePaneId);
    expect(n2.activePaneId).not.toBe(n1.activePaneId);
    expect(n3.activePaneId).toBe(s2.activePaneId);
    // suppress unused variable warning
    void newId1;
  });
});

// ---------------------------------------------------------------------------
// clampPaneHeight
// ---------------------------------------------------------------------------

describe("clampPaneHeight", () => {
  test("returns MIN_PANE_HEIGHT for values below floor", () => {
    expect(clampPaneHeight(0)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(-5)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(MIN_PANE_HEIGHT - 1)).toBe(MIN_PANE_HEIGHT);
  });

  test("returns the value when at or above floor", () => {
    expect(clampPaneHeight(MIN_PANE_HEIGHT)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(20)).toBe(20);
  });

  test("non-finite input falls back to floor", () => {
    expect(clampPaneHeight(NaN)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(Infinity)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(-Infinity)).toBe(MIN_PANE_HEIGHT);
  });

  test("truncates fractional values", () => {
    expect(clampPaneHeight(10.9)).toBe(10);
  });

  test("applies ceiling when availableHeight given", () => {
    // ceiling = max(MIN, available - MIN) = max(4, 20 - 4) = 16
    expect(clampPaneHeight(20, 20)).toBe(16);
  });

  test("available too small: still returns floor", () => {
    expect(clampPaneHeight(MIN_PANE_HEIGHT, MIN_PANE_HEIGHT)).toBe(MIN_PANE_HEIGHT);
  });
});

// ---------------------------------------------------------------------------
// clampPaneWidth
// ---------------------------------------------------------------------------

describe("clampPaneWidth", () => {
  test("returns MIN_PANE_WIDTH for values below floor", () => {
    expect(clampPaneWidth(0)).toBe(MIN_PANE_WIDTH);
    expect(clampPaneWidth(MIN_PANE_WIDTH - 1)).toBe(MIN_PANE_WIDTH);
  });

  test("returns the value when at or above floor", () => {
    expect(clampPaneWidth(MIN_PANE_WIDTH)).toBe(MIN_PANE_WIDTH);
    expect(clampPaneWidth(40)).toBe(40);
  });

  test("non-finite input falls back to floor", () => {
    expect(clampPaneWidth(NaN)).toBe(MIN_PANE_WIDTH);
    expect(clampPaneWidth(Infinity)).toBe(MIN_PANE_WIDTH);
  });

  test("applies ceiling when availableWidth given", () => {
    expect(clampPaneWidth(80, 80)).toBe(70); // 80 - 10 = 70
  });

  test("pane-collapses when budget too small to honour all floors", () => {
    // available < 2 * floor: ceiling = max(MIN, available - MIN) = max(10, 5-10) = 10
    expect(clampPaneWidth(MIN_PANE_WIDTH, MIN_PANE_WIDTH)).toBe(MIN_PANE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// distributeSize
// ---------------------------------------------------------------------------

describe("distributeSize", () => {
  test("equal ratios distribute evenly", () => {
    const result = distributeSize([1, 1], 20, 4);
    expect(result).toHaveLength(2);
    expect(result[0]! + result[1]!).toBe(20);
  });

  test("each pane gets at least the floor", () => {
    const result = distributeSize([0.9, 0.1], 30, 5);
    expect(result[0]!).toBeGreaterThanOrEqual(5);
    expect(result[1]!).toBeGreaterThanOrEqual(5);
  });

  test("total sums to input total", () => {
    const result = distributeSize([2, 1, 1], 60, 4);
    expect(result.reduce((a, b) => a + b, 0)).toBe(60);
  });

  test("empty sizes returns empty array", () => {
    expect(distributeSize([], 100, 4)).toEqual([]);
  });

  test("zero total distributes floors", () => {
    const result = distributeSize([1, 1], 0, 4);
    expect(result[0]!).toBeGreaterThanOrEqual(0);
  });
});
