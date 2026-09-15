/**
 * Pane tree data model and pure functions for editor pane splitting (Issue
 * #160). The tree has two node kinds: leaf nodes (editor groups, each holding
 * a tab set and active tab id) and split nodes (direction + children + size
 * ratios). All mutation functions return a NEW tree; the input is never
 * modified.
 *
 * Size-clamp helpers follow the same two-tier pattern as `sidebarWidth.ts` /
 * `panelHeight.ts`: an absolute floor applied unconditionally, plus an
 * optional ceiling derived from the live terminal dimension.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A leaf node: one editor group with its own tab list and active tab. */
export interface PaneLeaf {
  readonly kind: "leaf";
  readonly paneId: string;
  /** URIs of open documents, in tab order. */
  readonly tabs: readonly string[];
  /** URI of the currently active tab, or undefined when tabs is empty. */
  readonly activeTabUri: string | undefined;
}

/** A split node: two or more children laid out in a row or column. */
export interface PaneSplit {
  readonly kind: "split";
  /** "row" = side-by-side (horizontal split), "column" = stacked (vertical split). */
  readonly direction: "row" | "column";
  /** Child nodes. Always at least 2. */
  readonly children: readonly PaneNode[];
  /**
   * Fractional sizes for each child (same length as children). Values sum to
   * approximately 1.0; the renderer converts them to flex ratios or pixel
   * sizes. Invariant: same length as children, all positive.
   */
  readonly sizes: readonly number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** The full tree state: the root node plus the id of the focused pane. */
export interface PaneTree {
  readonly root: PaneNode;
  readonly activePaneId: string;
}

// ---------------------------------------------------------------------------
// Size-clamp constants (mirrors sidebarWidth.ts / panelHeight.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Absolute floor for each pane's height (rows). A pane must accommodate at
 * minimum its tab bar (3 rows) plus one content row.
 */
export const MIN_PANE_HEIGHT = 4;

/**
 * Absolute floor for each pane's width (columns). Wide enough for a line
 * number gutter plus a few characters of content.
 */
export const MIN_PANE_WIDTH = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalise(sizes: readonly number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

function findLeaf(node: PaneNode, paneId: string): PaneLeaf | undefined {
  if (node.kind === "leaf") return node.paneId === paneId ? node : undefined;
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return undefined;
}

/** Returns every leaf id in document order. */
function allLeafIds(node: PaneNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return node.children.flatMap((c) => allLeafIds(c));
}

// ---------------------------------------------------------------------------
// splitPane
// ---------------------------------------------------------------------------

/**
 * Split the pane identified by `targetId` in `direction`. The new sibling
 * (a clone of the target with an empty tab list) is placed after the target.
 * Both siblings share the target's original size equally. Returns a new tree
 * with `activePaneId` set to the new sibling's id.
 */
export function splitPane(
  tree: PaneTree,
  targetId: string,
  direction: "row" | "column",
  generateId: () => string,
): PaneTree {
  if (!findLeaf(tree.root, targetId)) return tree;
  const newId = generateId();

  function split(node: PaneNode): PaneNode {
    if (node.kind === "leaf") {
      if (node.paneId !== targetId) return node;
      const newLeaf: PaneLeaf = {
        kind: "leaf",
        paneId: newId,
        tabs: [],
        activeTabUri: undefined,
      };
      return {
        kind: "split",
        direction,
        children: [node, newLeaf],
        sizes: [0.5, 0.5],
      };
    }
    // Split node: try to find target among children
    const idx = node.children.findIndex((c) => findLeaf(c, targetId) !== undefined);
    if (idx === -1) return node;

    // If the child that contains the target IS the target leaf, and the
    // existing split is in the same direction, just insert inline.
    const child = node.children[idx]!;
    if (child.kind === "leaf" && child.paneId === targetId && node.direction === direction) {
      const newLeaf: PaneLeaf = {
        kind: "leaf",
        paneId: newId,
        tabs: [],
        activeTabUri: undefined,
      };
      const oldSize = node.sizes[idx]!;
      const half = oldSize / 2;
      const newSizes = [
        ...node.sizes.slice(0, idx),
        half,
        half,
        ...node.sizes.slice(idx + 1),
      ];
      const newChildren = [
        ...node.children.slice(0, idx + 1),
        newLeaf,
        ...node.children.slice(idx + 1),
      ];
      return { ...node, children: newChildren, sizes: newSizes };
    }

    // Otherwise recurse into the child
    const newChildren = node.children.map((c) => split(c));
    return { ...node, children: newChildren };
  }

  return { root: split(tree.root), activePaneId: newId };
}

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

/**
 * Remove the pane identified by `targetId` (C-x 0 equivalent). Its sibling
 * inherits its size. When closing the last leaf, returns the tree unchanged.
 * `activePaneId` is moved to the nearest remaining leaf.
 */
export function closePane(tree: PaneTree, targetId: string): PaneTree {
  const ids = allLeafIds(tree.root);
  if (ids.length <= 1) return tree;

  function remove(node: PaneNode): PaneNode | null {
    if (node.kind === "leaf") return node.paneId === targetId ? null : node;
    const newChildren: PaneNode[] = [];
    const newSizes: number[] = [];
    let leadingBonus = 0;
    for (let i = 0; i < node.children.length; i++) {
      const result = remove(node.children[i]!);
      if (result !== null) {
        newChildren.push(result);
        newSizes.push(node.sizes[i]! + leadingBonus);
        leadingBonus = 0;
      } else {
        // Distribute removed size to previous sibling if any, else accumulate
        const bonus = node.sizes[i]!;
        if (newChildren.length > 0) {
          newSizes[newSizes.length - 1]! += bonus;
        } else {
          leadingBonus += bonus;
        }
      }
    }
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0]!;
    return { ...node, children: newChildren, sizes: normalise(newSizes) };
  }

  const newRoot = remove(tree.root);
  if (newRoot === null) return tree;

  const remainingIds = allLeafIds(newRoot);
  const newActiveId =
    tree.activePaneId === targetId
      ? (remainingIds[0] ?? tree.activePaneId)
      : tree.activePaneId;

  return { root: newRoot, activePaneId: newActiveId };
}

// ---------------------------------------------------------------------------
// singlePane
// ---------------------------------------------------------------------------

/**
 * Collapse all panes except the active one (C-x 1 equivalent). Returns a new
 * tree whose root is the active leaf with its original tabs preserved.
 */
export function singlePane(tree: PaneTree): PaneTree {
  const activeLeaf = findLeaf(tree.root, tree.activePaneId);
  if (!activeLeaf) return tree;
  return { root: activeLeaf, activePaneId: tree.activePaneId };
}

// ---------------------------------------------------------------------------
// focusDirection helpers
// ---------------------------------------------------------------------------

interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeLeafBounds(node: PaneNode, box: BoundingBox): Map<string, BoundingBox> {
  if (node.kind === "leaf") {
    return new Map([[node.paneId, box]]);
  }
  const result = new Map<string, BoundingBox>();
  const norm = normalise(node.sizes);
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const frac = norm[i]!;
    let childBox: BoundingBox;
    if (node.direction === "row") {
      childBox = { x: box.x + offset * box.w, y: box.y, w: frac * box.w, h: box.h };
    } else {
      childBox = { x: box.x, y: box.y + offset * box.h, w: box.w, h: frac * box.h };
    }
    offset += frac;
    for (const [id, b] of computeLeafBounds(node.children[i]!, childBox)) {
      result.set(id, b);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// focusDirection
// ---------------------------------------------------------------------------

/**
 * Move focus to the nearest pane in `direction` relative to the active pane.
 * Computes each leaf's bounding rectangle from the split tree, then picks the
 * geometrically nearest candidate in the requested direction.
 * If no pane exists in that direction, returns the tree unchanged.
 */
export function focusDirection(
  tree: PaneTree,
  direction: "up" | "down" | "left" | "right",
): PaneTree {
  const bounds = computeLeafBounds(tree.root, { x: 0, y: 0, w: 1, h: 1 });
  const activeBounds = bounds.get(tree.activePaneId);
  if (!activeBounds) return tree;

  let bestId: string | undefined;
  let bestDistance = Infinity;

  for (const [id, box] of bounds) {
    if (id === tree.activePaneId) continue;

    let inDirection: boolean;
    let distance: number;

    if (direction === "right") {
      inDirection = box.x >= activeBounds.x + activeBounds.w - Number.EPSILON;
      distance = box.x - (activeBounds.x + activeBounds.w);
    } else if (direction === "left") {
      inDirection = box.x + box.w <= activeBounds.x + Number.EPSILON;
      distance = activeBounds.x - (box.x + box.w);
    } else if (direction === "down") {
      inDirection = box.y >= activeBounds.y + activeBounds.h - Number.EPSILON;
      distance = box.y - (activeBounds.y + activeBounds.h);
    } else {
      inDirection = box.y + box.h <= activeBounds.y + Number.EPSILON;
      distance = activeBounds.y - (box.y + box.h);
    }

    if (inDirection && distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }

  if (bestId === undefined) return tree;
  return { ...tree, activePaneId: bestId };
}

// ---------------------------------------------------------------------------
// focusNext
// ---------------------------------------------------------------------------

/**
 * Cycle focus to the next pane in document order (wraps around).
 */
export function focusNext(tree: PaneTree): PaneTree {
  const ids = allLeafIds(tree.root);
  if (ids.length <= 1) return tree;
  const idx = ids.indexOf(tree.activePaneId);
  const nextIdx = (idx + 1) % ids.length;
  return { ...tree, activePaneId: ids[nextIdx]! };
}

// ---------------------------------------------------------------------------
// Size clamping
// ---------------------------------------------------------------------------

/**
 * Clamp a pane height: always at least `MIN_PANE_HEIGHT`. When
 * `availableHeight` is provided, also capped so it does not exceed available
 * space (minus the floor for the companion pane). Non-finite input falls back
 * to the floor.
 */
export function clampPaneHeight(desired: number, availableHeight?: number): number {
  const safeDesired = Number.isFinite(desired) ? Math.trunc(desired) : MIN_PANE_HEIGHT;
  let h = Math.max(MIN_PANE_HEIGHT, safeDesired);
  if (availableHeight !== undefined && Number.isFinite(availableHeight)) {
    const ceiling = Math.max(MIN_PANE_HEIGHT, Math.trunc(availableHeight) - MIN_PANE_HEIGHT);
    h = Math.min(h, ceiling);
  }
  return h;
}

/**
 * Clamp a pane width: always at least `MIN_PANE_WIDTH`. When `availableWidth`
 * is provided, also capped so it does not exceed available space minus the
 * companion pane floor. Non-finite input falls back to the floor.
 */
export function clampPaneWidth(desired: number, availableWidth?: number): number {
  const safeDesired = Number.isFinite(desired) ? Math.trunc(desired) : MIN_PANE_WIDTH;
  let w = Math.max(MIN_PANE_WIDTH, safeDesired);
  if (availableWidth !== undefined && Number.isFinite(availableWidth)) {
    const ceiling = Math.max(MIN_PANE_WIDTH, Math.trunc(availableWidth) - MIN_PANE_WIDTH);
    w = Math.min(w, ceiling);
  }
  return w;
}

/**
 * Given a split node's children sizes (ratios) and a total pixel budget,
 * distribute pixels ensuring each pane receives at least its floor. Returns
 * integer pixel sizes. If the budget is too small to honour all floors, the
 * first pane wins its floor and remaining space is distributed.
 *
 * Used by the renderer (Phase 2) to translate ratios into concrete heights /
 * widths. Exported here so Phase 2 can import without a circular dependency.
 */
export function distributeSize(
  sizes: readonly number[],
  total: number,
  floor: number,
): number[] {
  const safeTotal = Math.max(0, Math.trunc(total));
  const n = sizes.length;
  if (n === 0) return [];
  // Insufficient-budget branch: total cannot honour all floors.
  // First pane gets floor; second pane gets any remaining budget; rest get 0.
  if (safeTotal < n * floor) {
    const result: number[] = [];
    let remaining = safeTotal;
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        const allocation = Math.min(floor, remaining);
        result.push(allocation);
        remaining -= allocation;
      } else if (i === 1 && remaining > 0) {
        result.push(remaining);
        remaining = 0;
      } else {
        result.push(0);
      }
    }
    return result;
  }
  const normalised = normalise(sizes);
  // First pass: proportional allocation
  const raw = normalised.map((r) => Math.max(floor, Math.round(r * safeTotal)));
  // Adjust sum to match safeTotal
  let sum = raw.reduce((a, b) => a + b, 0);
  // Trim from largest panes when over budget (no early-break: insufficient
  // cases are handled by the branch above)
  while (sum > safeTotal) {
    const maxIdx = raw.reduce((best, v, i) => (v > raw[best]! ? i : best), 0);
    raw[maxIdx]!--;
    sum--;
  }
  // Grow the smallest pane when under budget
  while (sum < safeTotal) {
    const minIdx = raw.reduce((best, v, i) => (v < raw[best]! ? i : best), 0);
    raw[minIdx]!++;
    sum++;
  }
  return raw;
}
