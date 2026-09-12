/**
 * Tests for `ui/foldController.ts` (Issue #150) — the fold-gesture policy,
 * exercised against hand-rolled fakes for both of its dependencies (no
 * mock libraries, house convention): a minimal `EditorSessionService` slice
 * holding one `EditorState`, and a minimal `FoldService` slice serving a
 * fixed set of foldable regions.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, FoldRange, Selection, Uri } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createHostLog } from "../host/errors";
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
    // No active document in this fake, so the controller's retrack
    // subscription never attaches to anything — these tests drive the
    // gesture methods directly.
    onDidChange: (): Disposable => ({ dispose() {} }),
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

describe("createFoldController — overlapping folds sharing a start line (CodeRabbit, PR #155)", () => {
  // The regression this pins: `foldAt` collapses the WIDEST region starting
  // on a line, so unfolding there has to expand that same one. Picking the
  // innermost instead would remove `{4, 6}` and leave `{4, 10}` hiding the
  // very same rows — a toggle that visibly does nothing.
  const OVERLAPPING: FoldRange[] = [
    { startLine: 4, endLine: 10 },
    { startLine: 4, endLine: 6 },
  ];

  test("after foldAll, one click on the shared start line reveals the rows again", () => {
    const { session, controller } = build(OVERLAPPING);
    controller.foldAll(URI);
    expect(session.writes()).toEqual(OVERLAPPING);

    controller.toggleAt(URI, 4);

    // The widest region is gone, so line 7 (which only `{4, 10}` hid) is
    // drawn again — the user-visible point of the click.
    expect(controller.isLineVisible(URI, 7)).toBe(true);
    expect(session.writes()).toEqual([{ startLine: 4, endLine: 6 }]);
  });

  test("fold then unfold on the same line is an exact round trip", () => {
    const { session, controller } = build(OVERLAPPING);
    controller.foldAt(URI, 4);
    expect(session.writes()).toEqual([{ startLine: 4, endLine: 10 }]);

    controller.unfoldAt(URI, 4);
    expect(session.writes()).toEqual([]);
  });
});

describe("createFoldController — the caret never stays inside a collapsed region (CodeRabbit, PR #155)", () => {
  function cursorAt(line: number): Selection {
    const position = { line, character: 3 };
    return { start: position, end: position, anchor: position, active: position };
  }

  test("folding from inside a region pulls the caret up to its header", () => {
    const { session, controller } = build(RANGES, { selections: [cursorAt(7)] });
    controller.foldAt(URI, 7);

    const header = { line: 6, character: 0 };
    expect(session.current().selections).toEqual([
      { start: header, end: header, anchor: header, active: header },
    ]);
  });

  test("a caret already on the header is left untouched", () => {
    const before = [cursorAt(4)];
    const { session, controller } = build(RANGES, { selections: before });
    controller.foldAt(URI, 4);

    // Same array identity: nothing moved, so no new selections were written.
    expect(session.current().selections).toBe(before);
  });

  test("foldAll lifts a buried caret out to the outermost visible header", () => {
    const { session, controller } = build(RANGES, { selections: [cursorAt(7)] });
    controller.foldAll(URI);

    // Every region collapses at once, so line 7's header (6) is itself
    // hidden by {4, 10}, whose header is hidden in turn by {0, 20} — the
    // caret has to walk all the way out to line 0.
    expect(session.current().selections[0]!.active).toEqual({ line: 0, character: 0 });
  });

  test("every caret ends up on a line the mapping actually draws", () => {
    const { session, controller } = build(RANGES, { selections: [cursorAt(7), cursorAt(9)] });
    controller.foldAll(URI);

    for (const selection of session.current().selections) {
      expect(controller.isLineVisible(URI, selection.active.line)).toBe(true);
    }
  });
});

describe("createFoldController — collapsed folds follow document edits (CodeRabbit, PR #155)", () => {
  /** A fake session with a REAL `CoreDocument` as its active document, so
   * the controller's own `document.onDidChange` subscription runs against
   * genuine `TextEdit` batches rather than fabricated ones. */
  function createLiveSession(document: CoreDocument, collapsedFolds: FoldRange[]) {
    let state: EditorState = { ...createInitialEditorState(document.uri), collapsedFolds };
    const listeners = new Set<() => void>();
    return {
      getActiveDocument: (): CoreDocument => document,
      getState: (): EditorState => state,
      setState: (_uri: Uri, next: EditorState): void => {
        state = next;
        for (const listener of Array.from(listeners)) listener();
      },
      onDidChange: (listener: () => void): Disposable => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      folds: (): readonly FoldRange[] => state.collapsedFolds ?? [],
    };
  }

  function buildLive(text: string, collapsedFolds: FoldRange[], ranges: readonly FoldRange[] = []) {
    const document = createDocument({
      uri: "file:///live.ts",
      languageId: "plaintext",
      text,
      sink: { error() {} },
      log: createHostLog(),
    });
    const session = createLiveSession(document, collapsedFolds);
    const controller = createFoldController({
      editorSession: session,
      foldService: createFakeFoldService(ranges),
    });
    return { document, session, controller };
  }

  const TEXT = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");

  test("an insertion ABOVE a collapsed region shifts the whole region down", () => {
    const { document, session } = buildLive(TEXT, [{ startLine: 4, endLine: 10 }]);

    document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "new\n" },
    ]);

    expect(session.folds()).toEqual([{ startLine: 5, endLine: 11 }]);
  });

  test("a deletion ABOVE a collapsed region shifts it back up", () => {
    const { document, session } = buildLive(TEXT, [{ startLine: 4, endLine: 10 }]);

    document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "" },
    ]);

    expect(session.folds()).toEqual([{ startLine: 3, endLine: 9 }]);
  });

  test("an insertion INSIDE a collapsed region grows it without moving its header", () => {
    const { document, session } = buildLive(TEXT, [{ startLine: 4, endLine: 10 }]);

    document.applyEdits([
      { range: { start: { line: 6, character: 0 }, end: { line: 6, character: 0 } }, newText: "extra\n" },
    ]);

    expect(session.folds()).toEqual([{ startLine: 4, endLine: 11 }]);
  });

  test("an edit BELOW a collapsed region leaves it exactly as it was", () => {
    const before = [{ startLine: 4, endLine: 10 }];
    const { document, session } = buildLive(TEXT, before);

    document.applyEdits([
      { range: { start: { line: 11, character: 0 }, end: { line: 11, character: 0 } }, newText: "tail\n" },
    ]);

    // Same array identity: no remap, and therefore no `setState` at all.
    expect(session.folds()).toBe(before);
  });

  test("a same-line edit inside a region changes nothing — no line delta, no write", () => {
    const before = [{ startLine: 4, endLine: 10 }];
    const { document, session } = buildLive(TEXT, before);

    document.applyEdits([
      { range: { start: { line: 6, character: 1 }, end: { line: 6, character: 1 } }, newText: "x" },
    ]);

    expect(session.folds()).toBe(before);
  });

  test("an edit STRADDLING the region's header drops the fold, revealing its rows", () => {
    const { document, session } = buildLive(TEXT, [{ startLine: 4, endLine: 10 }]);

    // Deletes lines 3..5, i.e. across the header — the region's own
    // boundaries are exactly what this puts in doubt.
    document.applyEdits([
      { range: { start: { line: 3, character: 0 }, end: { line: 6, character: 0 } }, newText: "" },
    ]);

    expect(session.folds()).toEqual([]);
  });

  test("a document with nothing collapsed is never written to on an edit", () => {
    const { document, session } = buildLive(TEXT, []);
    let writes = 0;
    const sub = session.onDidChange(() => {
      writes += 1;
    });

    document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "a\n" },
    ]);
    sub.dispose();

    // The zero-collapsed-folds early return keeps folding entirely off the
    // typing hot path (Req 13.1).
    expect(writes).toBe(0);
  });

  test("dispose stops remapping", () => {
    const before = [{ startLine: 4, endLine: 10 }];
    const { document, session, controller } = buildLive(TEXT, before);
    controller.dispose();

    document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "new\n" },
    ]);

    expect(session.folds()).toBe(before);
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
