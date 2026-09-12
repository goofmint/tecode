/**
 * Tests for `ui/foldController.ts` (Issue #150) — the fold-gesture policy,
 * exercised against hand-rolled fakes for both of its dependencies (no
 * mock libraries, house convention): a minimal `EditorSessionService` slice
 * holding one `EditorState`, and a minimal `FoldService` slice serving a
 * fixed set of foldable regions.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, FoldRange, Uri } from "@tecode/api";
import { createInitialEditorState, type EditorState } from "./editorState";
import { createFoldController } from "./foldController";

const URI: Uri = "file:///a.ts";

/** A one-document `Pick<EditorSessionService, ...>` — `setState` records
 * the write so a test can assert on the resulting `collapsedFolds`. */
function createFakeSession(initial?: Partial<EditorState>) {
  let state: EditorState = { ...createInitialEditorState(URI), ...initial };
  return {
    getActiveDocument: () => undefined,
    getState: (): EditorState => state,
    setState: (_uri: Uri, next: EditorState): void => {
      state = next;
    },
    current: (): EditorState => state,
    writes: () => state.collapsedFolds ?? [],
  };
}

function createFakeFoldService(ranges: readonly FoldRange[]) {
  return {
    getFoldRanges: (): readonly FoldRange[] => ranges,
    onDidChange: (): Disposable => ({ dispose() {} }),
  };
}

/** Two sibling regions, the second one nested inside a wider outer one —
 * enough shape to tell "innermost" apart from "outermost". */
const RANGES: FoldRange[] = [
  { startLine: 0, endLine: 20 },
  { startLine: 4, endLine: 10 },
  { startLine: 6, endLine: 8 },
];

function build(ranges: readonly FoldRange[] = RANGES, initial?: Partial<EditorState>) {
  const session = createFakeSession(initial);
  const controller = createFoldController({
    editorSession: session,
    foldService: createFakeFoldService(ranges),
  });
  return { session, controller };
}

describe("createFoldController — foldAt (Issue #150)", () => {
  test("a line that starts a region folds THAT region, not its parent", () => {
    const { session, controller } = build();
    controller.foldAt(URI, 4);
    expect(session.writes()).toEqual([{ startLine: 4, endLine: 10 }]);
  });

  test("a line inside a region folds the innermost one containing it", () => {
    const { session, controller } = build();
    controller.foldAt(URI, 7);
    expect(session.writes()).toEqual([{ startLine: 6, endLine: 8 }]);
  });

  test("a line no region covers is a no-op", () => {
    const { session, controller } = build();
    controller.foldAt(URI, 40);
    expect(session.writes()).toEqual([]);
  });

  test("folding the same region twice does not duplicate it", () => {
    const { session, controller } = build();
    controller.foldAt(URI, 4);
    controller.foldAt(URI, 4);
    expect(session.writes()).toEqual([{ startLine: 4, endLine: 10 }]);
  });

  test("regions nest: folding an inner one then an outer one keeps both", () => {
    const { session, controller } = build();
    controller.foldAt(URI, 6);
    controller.foldAt(URI, 0);
    expect(session.writes()).toEqual([
      { startLine: 6, endLine: 8 },
      { startLine: 0, endLine: 20 },
    ]);
  });
});

describe("createFoldController — unfoldAt / toggleAt (Issue #150)", () => {
  test("unfolds the innermost collapsed region containing the line", () => {
    const { session, controller } = build(RANGES, {
      collapsedFolds: [
        { startLine: 0, endLine: 20 },
        { startLine: 6, endLine: 8 },
      ],
    });
    controller.unfoldAt(URI, 7);
    expect(session.writes()).toEqual([{ startLine: 0, endLine: 20 }]);
  });

  test("unfolding where nothing is collapsed is a no-op", () => {
    const { session, controller } = build();
    controller.unfoldAt(URI, 7);
    expect(session.writes()).toEqual([]);
  });

  test("toggle folds, then unfolds, the same region", () => {
    const { session, controller } = build();
    controller.toggleAt(URI, 4);
    expect(session.writes()).toEqual([{ startLine: 4, endLine: 10 }]);
    controller.toggleAt(URI, 4);
    expect(session.writes()).toEqual([]);
  });

  test("unfolds a collapsed region even after the grammar stopped reporting it", () => {
    // A mid-edit reparse can drop a region from `getFoldRanges` while it is
    // still collapsed; without resolving "unfold" against the COLLAPSED set,
    // those rows would be stuck hidden.
    const { session, controller } = build([], { collapsedFolds: [{ startLine: 4, endLine: 10 }] });
    controller.toggleAt(URI, 5);
    expect(session.writes()).toEqual([]);
  });
});

describe("createFoldController — foldAll / unfoldAll (Issue #150)", () => {
  test("foldAll collapses every foldable region", () => {
    const { session, controller } = build();
    controller.foldAll(URI);
    expect(session.writes()).toEqual(RANGES);
  });

  test("foldAll with no foldable regions writes nothing at all", () => {
    const { session, controller } = build([]);
    controller.foldAll(URI);
    expect(session.current().collapsedFolds).toBeUndefined();
  });

  test("unfoldAll clears the collapsed set", () => {
    const { session, controller } = build(RANGES, { collapsedFolds: [{ startLine: 4, endLine: 10 }] });
    controller.unfoldAll(URI);
    expect(session.writes()).toEqual([]);
  });

  test("unfoldAll with nothing collapsed writes nothing at all", () => {
    const { session, controller } = build();
    controller.unfoldAll(URI);
    expect(session.current().collapsedFolds).toBeUndefined();
  });
});

describe("createFoldController — isLineVisible (Issue #150)", () => {
  test("only lines strictly inside a collapsed region are invisible", () => {
    const { controller } = build(RANGES, { collapsedFolds: [{ startLine: 4, endLine: 10 }] });
    expect(controller.isLineVisible(URI, 4)).toBe(true); // the header itself
    expect(controller.isLineVisible(URI, 5)).toBe(false);
    expect(controller.isLineVisible(URI, 10)).toBe(false);
    expect(controller.isLineVisible(URI, 11)).toBe(true);
  });

  test("everything is visible with nothing collapsed", () => {
    const { controller } = build();
    expect(controller.isLineVisible(URI, 7)).toBe(true);
  });
});
