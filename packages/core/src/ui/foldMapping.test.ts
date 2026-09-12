/**
 * Tests for `ui/foldMapping.ts` (Issue #150) — pure display-line/document-
 * line arithmetic, so every case here is plain numbers in, plain numbers
 * out, with no renderer and no services (matching `viewport.test.ts`'s own
 * shape).
 */

import { describe, expect, test } from "bun:test";
import {
  clampFoldsToDocument,
  createFoldMapping,
  foldContainsLine,
  foldStartingAt,
  hasFold,
  innermostFoldAt,
} from "./foldMapping";

describe("createFoldMapping — nothing collapsed (Issue #150)", () => {
  test("is the identity: every display line is its own document line", () => {
    const mapping = createFoldMapping(undefined, 10);
    expect(mapping.visibleLineCount).toBe(10);
    for (let line = 0; line < 10; line++) {
      expect(mapping.toDocumentLine(line)).toBe(line);
      expect(mapping.toDisplayLine(line)).toBe(line);
      expect(mapping.isLineHidden(line)).toBe(false);
    }
  });

  test("an empty collapsed array takes the same identity path", () => {
    const mapping = createFoldMapping([], 4);
    expect(mapping.visibleLineCount).toBe(4);
    expect(mapping.toDocumentLine(3)).toBe(3);
  });

  test("clamps an out-of-range line rather than reporting one the document has no such line for", () => {
    const mapping = createFoldMapping(undefined, 3);
    expect(mapping.toDocumentLine(99)).toBe(2);
    expect(mapping.toDocumentLine(-4)).toBe(0);
    expect(mapping.toDisplayLine(99)).toBe(2);
  });
});

describe("createFoldMapping — one collapsed region (Issue #150)", () => {
  // Lines 0..9; collapsing 2..5 hides 3, 4 and 5 — line 2 is the header
  // and stays visible.
  const mapping = createFoldMapping([{ startLine: 2, endLine: 5 }], 10);

  test("hides every line after the header, up to and including the end line", () => {
    expect([0, 1, 2, 6, 7, 8, 9].every((l) => !mapping.isLineHidden(l))).toBe(true);
    expect([3, 4, 5].every((l) => mapping.isLineHidden(l))).toBe(true);
  });

  test("visibleLineCount drops by exactly the number of hidden lines", () => {
    expect(mapping.visibleLineCount).toBe(7);
  });

  test("display rows resolve to the surviving document lines, in order", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => mapping.toDocumentLine(d))).toEqual([0, 1, 2, 6, 7, 8, 9]);
  });

  test("a visible document line maps back to its own row", () => {
    expect(mapping.toDisplayLine(6)).toBe(3);
    expect(mapping.toDisplayLine(9)).toBe(6);
  });

  test("a HIDDEN document line maps to the row of the fold that swallowed it", () => {
    expect(mapping.toDisplayLine(3)).toBe(2);
    expect(mapping.toDisplayLine(5)).toBe(2);
    expect(mapping.toDocumentLine(mapping.toDisplayLine(4))).toBe(2);
  });
});

describe("createFoldMapping — degenerate and overlapping input (Issue #150)", () => {
  test("nested regions hide the union of their lines, counted once", () => {
    const mapping = createFoldMapping(
      [
        { startLine: 0, endLine: 8 },
        { startLine: 2, endLine: 4 },
      ],
      10,
    );
    expect(mapping.visibleLineCount).toBe(2); // lines 0 and 9
    expect(mapping.toDocumentLine(1)).toBe(9);
  });

  test("a region whose end overruns the document hides only real lines", () => {
    const mapping = createFoldMapping([{ startLine: 1, endLine: 99 }], 4);
    expect(mapping.visibleLineCount).toBe(2); // lines 0 and 1
    expect(mapping.isLineHidden(3)).toBe(true);
  });

  test("a region starting past the document end hides nothing (identity)", () => {
    const mapping = createFoldMapping([{ startLine: 40, endLine: 50 }], 4);
    expect(mapping.visibleLineCount).toBe(4);
    expect(mapping.isLineHidden(3)).toBe(false);
  });

  test("a single-line region hides nothing — its own start line always stays visible", () => {
    const mapping = createFoldMapping([{ startLine: 2, endLine: 2 }], 5);
    expect(mapping.visibleLineCount).toBe(5);
  });

  test("line 0 can never be hidden, whatever is collapsed", () => {
    const mapping = createFoldMapping([{ startLine: 0, endLine: 3 }], 5);
    expect(mapping.isLineHidden(0)).toBe(false);
    expect(mapping.toDocumentLine(0)).toBe(0);
  });
});

describe("fold range helpers (Issue #150)", () => {
  const ranges = [
    { startLine: 0, endLine: 20 },
    { startLine: 4, endLine: 10 },
    { startLine: 4, endLine: 6 },
    { startLine: 12, endLine: 14 },
  ];

  test("foldContainsLine covers the header line and the end line inclusively", () => {
    expect(foldContainsLine({ startLine: 2, endLine: 5 }, 2)).toBe(true);
    expect(foldContainsLine({ startLine: 2, endLine: 5 }, 5)).toBe(true);
    expect(foldContainsLine({ startLine: 2, endLine: 5 }, 6)).toBe(false);
  });

  test("hasFold compares spans, not object identity", () => {
    expect(hasFold(ranges, { startLine: 12, endLine: 14 })).toBe(true);
    expect(hasFold(ranges, { startLine: 12, endLine: 15 })).toBe(false);
  });

  test("innermostFoldAt picks the latest start, then the earliest end", () => {
    expect(innermostFoldAt(ranges, 5)).toEqual({ startLine: 4, endLine: 6 });
    expect(innermostFoldAt(ranges, 8)).toEqual({ startLine: 4, endLine: 10 });
    expect(innermostFoldAt(ranges, 18)).toEqual({ startLine: 0, endLine: 20 });
    expect(innermostFoldAt(ranges, 40)).toBeUndefined();
  });

  test("foldStartingAt picks the WIDEST region that starts on the line", () => {
    expect(foldStartingAt(ranges, 4)).toEqual({ startLine: 4, endLine: 10 });
    expect(foldStartingAt(ranges, 5)).toBeUndefined();
  });
});

describe("clampFoldsToDocument (Issue #150)", () => {
  test("returns the ORIGINAL array when every fold still fits", () => {
    const folds = [{ startLine: 1, endLine: 3 }];
    expect(clampFoldsToDocument(folds, 10)).toBe(folds);
  });

  test("truncates a fold whose end overruns a shrunken document", () => {
    expect(clampFoldsToDocument([{ startLine: 1, endLine: 30 }], 5)).toEqual([
      { startLine: 1, endLine: 4 },
    ]);
  });

  test("drops a fold whose header no longer has a line below it to hide", () => {
    expect(clampFoldsToDocument([{ startLine: 9, endLine: 30 }], 5)).toEqual([]);
    expect(clampFoldsToDocument([{ startLine: 4, endLine: 9 }], 5)).toEqual([]);
  });
});
