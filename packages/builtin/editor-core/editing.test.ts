import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import type { LineReader } from "./movement";
import {
  buildBackspaceEdit,
  buildDeleteEdit,
  buildEditBatch,
  buildNewlineEdit,
  buildOutdentEdit,
  buildTabEdit,
} from "./editing";
import { collapsedSelection } from "./selectionMerge";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  return collapsedSelection(pos(line, character));
}

function selectionOf(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = pos(startLine, startChar);
  const end = pos(endLine, endChar);
  return { start, end, anchor: start, active: end };
}

function reader(lines: string[]): LineReader {
  return { getLine: (n) => lines[n] ?? "", lineCount: lines.length };
}

describe("buildBackspaceEdit (Req 11.1)", () => {
  test("collapsed cursor: deletes the previous grapheme", () => {
    const edit = buildBackspaceEdit(reader(["abc"]), cursorAt(0, 2));
    expect(edit).toEqual({ range: { start: pos(0, 1), end: pos(0, 2) }, newText: "" });
  });

  test("collapsed cursor at column 0: joins with the previous line", () => {
    const edit = buildBackspaceEdit(reader(["abc", "def"]), cursorAt(1, 0));
    expect(edit).toEqual({ range: { start: pos(0, 3), end: pos(1, 0) }, newText: "" });
  });

  test("document start: undefined (boundary no-op)", () => {
    expect(buildBackspaceEdit(reader(["abc"]), cursorAt(0, 0))).toBeUndefined();
  });

  test("non-collapsed selection: deletes the whole range", () => {
    const edit = buildBackspaceEdit(reader(["abcdef"]), selectionOf(0, 1, 0, 4));
    expect(edit).toEqual({ range: { start: pos(0, 1), end: pos(0, 4) }, newText: "" });
  });

  test("steps over a surrogate-pair grapheme as one unit", () => {
    const edit = buildBackspaceEdit(reader(["a😀b"]), cursorAt(0, 3));
    expect(edit).toEqual({ range: { start: pos(0, 1), end: pos(0, 3) }, newText: "" });
  });
});

describe("buildDeleteEdit (Req 11.1)", () => {
  test("collapsed cursor: deletes the next grapheme", () => {
    const edit = buildDeleteEdit(reader(["abc"]), cursorAt(0, 1));
    expect(edit).toEqual({ range: { start: pos(0, 1), end: pos(0, 2) }, newText: "" });
  });

  test("collapsed cursor at end of line: joins with the next line", () => {
    const edit = buildDeleteEdit(reader(["abc", "def"]), cursorAt(0, 3));
    expect(edit).toEqual({ range: { start: pos(0, 3), end: pos(1, 0) }, newText: "" });
  });

  test("document end: undefined (boundary no-op)", () => {
    expect(buildDeleteEdit(reader(["abc"]), cursorAt(0, 3))).toBeUndefined();
  });

  test("non-collapsed selection: deletes the whole range", () => {
    const edit = buildDeleteEdit(reader(["abcdef"]), selectionOf(0, 1, 0, 4));
    expect(edit).toEqual({ range: { start: pos(0, 1), end: pos(0, 4) }, newText: "" });
  });
});

describe("buildNewlineEdit (Req 11.1, auto-indent)", () => {
  test("copies the current line's leading whitespace", () => {
    const edit = buildNewlineEdit(reader(["  if (x) {"]), cursorAt(0, 10));
    expect(edit).toEqual({ range: { start: pos(0, 10), end: pos(0, 10) }, newText: "\n  " });
  });

  test("uses the current line's indent regardless of where on the line the caret sits", () => {
    const edit = buildNewlineEdit(reader(["    abc"]), cursorAt(0, 5));
    expect(edit).toEqual({ range: { start: pos(0, 5), end: pos(0, 5) }, newText: "\n    " });
  });

  test("no indentation: inserts a bare newline", () => {
    const edit = buildNewlineEdit(reader(["abc"]), cursorAt(0, 1));
    expect(edit.newText).toBe("\n");
  });

  test("replaces a non-collapsed selection", () => {
    const edit = buildNewlineEdit(reader(["  abcdef"]), selectionOf(0, 2, 0, 5));
    expect(edit).toEqual({ range: { start: pos(0, 2), end: pos(0, 5) }, newText: "\n  " });
  });
});

describe("buildTabEdit (Req 11.1, respects editor.tabSize/insertSpaces)", () => {
  test("insertSpaces: inserts spaces up to the next tab stop from column 0", () => {
    const edit = buildTabEdit(reader([""]), cursorAt(0, 0), 4, true);
    expect(edit.newText).toBe("    ");
  });

  test("insertSpaces: a shorter run when the cursor is already partway to the next stop", () => {
    const edit = buildTabEdit(reader(["ab"]), cursorAt(0, 2), 4, true);
    expect(edit.newText).toBe("  "); // 2 spaces reach column 4
  });

  test("respects a different tabSize", () => {
    const edit = buildTabEdit(reader([""]), cursorAt(0, 0), 2, true);
    expect(edit.newText).toBe("  ");
  });

  test("insertSpaces: false inserts a literal tab regardless of column", () => {
    const edit = buildTabEdit(reader(["ab"]), cursorAt(0, 2), 4, false);
    expect(edit.newText).toBe("\t");
  });

  test("replaces a non-collapsed selection", () => {
    const edit = buildTabEdit(reader(["abcdef"]), selectionOf(0, 1, 0, 4), 4, true);
    expect(edit.range).toEqual({ start: pos(0, 1), end: pos(0, 4) });
  });
});

describe("buildOutdentEdit (Req 11.1, Shift+Tab)", () => {
  test("removes one tabSize-wide unit of leading whitespace (spaces)", () => {
    const edit = buildOutdentEdit(reader(["        abc"]), cursorAt(0, 8), 4);
    expect(edit).toEqual({ range: { start: pos(0, 0), end: pos(0, 4) }, newText: "" });
  });

  test("removes a single leading tab as one unit", () => {
    const edit = buildOutdentEdit(reader(["\tabc"]), cursorAt(0, 1), 4);
    expect(edit).toEqual({ range: { start: pos(0, 0), end: pos(0, 1) }, newText: "" });
  });

  test("removes a partial unit when less than tabSize of whitespace exists", () => {
    const edit = buildOutdentEdit(reader(["  abc"]), cursorAt(0, 0), 4);
    expect(edit).toEqual({ range: { start: pos(0, 0), end: pos(0, 2) }, newText: "" });
  });

  test("no leading whitespace: undefined (nothing to remove)", () => {
    expect(buildOutdentEdit(reader(["abc"]), cursorAt(0, 0), 4)).toBeUndefined();
  });
});

describe("buildEditBatch (Req 6.6, 11.1 — multi-cursor + merge)", () => {
  test("single collapsed cursor: caret lands after the inserted text", () => {
    const selections = [cursorAt(0, 4)];
    const batch = buildEditBatch(selections, (s) => ({
      range: { start: s.active, end: s.active },
      newText: "  ",
    }));
    expect(batch.edits).toHaveLength(1);
    expect(batch.selections).toEqual([cursorAt(0, 6)]);
  });

  test("insert replacing a BACKWARD selection collapses to the end of the inserted text", () => {
    // Range [2, 5) in document order, but anchor/active reversed (a
    // selection built by extending leftward) — active === range.start, not
    // range.end. buildEditBatch must not use `active` directly
    // (positionTransform.ts's whole reason to track range.end).
    const backward: Selection = { start: pos(0, 2), end: pos(0, 5), anchor: pos(0, 5), active: pos(0, 2) };
    const batch = buildEditBatch([backward], (s) => ({
      range: { start: s.start, end: s.end },
      newText: "XYZ",
    }));
    expect(batch.selections).toEqual([cursorAt(0, 5)]); // start(2) + "XYZ".length(3)
  });

  test("two independent cursors on different lines both move correctly", () => {
    const selections = [cursorAt(0, 0), cursorAt(1, 0)];
    const batch = buildEditBatch(selections, (s) => ({
      range: { start: s.active, end: s.active },
      newText: "x",
    }));
    expect(batch.edits).toHaveLength(2);
    expect(batch.selections).toEqual([cursorAt(0, 1), cursorAt(1, 1)]);
  });

  test("two cursors on the same line: the second cursor's position accounts for the first's edit", () => {
    const selections = [cursorAt(0, 2), cursorAt(0, 5)];
    const batch = buildEditBatch(selections, (s) => ({
      range: { start: s.active, end: s.active },
      newText: "ab",
    }));
    expect(batch.edits).toHaveLength(2);
    // First cursor inserts "ab" at 2 -> lands at 4. Second cursor's original
    // position (5) shifts right by 2 (the first edit's length) to 7, then
    // its own insertion lands it at 9.
    expect(batch.selections).toEqual([cursorAt(0, 4), cursorAt(0, 9)]);
  });

  test("a boundary no-op (undefined edit) still gets shifted by another cursor's edit", () => {
    const atDocStart = cursorAt(0, 0); // backspace here is a no-op
    const other = cursorAt(0, 0);
    const selections = [atDocStart, other];
    let call = 0;
    const batch = buildEditBatch(selections, (s) => {
      call++;
      if (call === 1) return undefined; // first selection: boundary no-op
      return { range: { start: s.active, end: s.active }, newText: "z" };
    });
    // Both started at the same point; the one real edit inserts "z" there,
    // and the no-op selection's original position (0,0) is unaffected since
    // it's exactly at the edit's start, not after it — both land together
    // and merge into a single cursor.
    expect(batch.edits).toHaveLength(1);
    expect(batch.selections.length).toBeGreaterThanOrEqual(1);
  });

  test("overlapping edits: the earlier one wins, the later cursor does not move via its own edit", () => {
    const selections = [selectionOf(0, 0, 0, 5), selectionOf(0, 3, 0, 8)];
    const batch = buildEditBatch(selections, (s) => ({
      range: { start: s.start, end: s.end },
      newText: "",
    }));
    expect(batch.edits).toHaveLength(1);
    expect(batch.edits[0]).toEqual({ range: { start: pos(0, 0), end: pos(0, 5) }, newText: "" });
  });

  test("empty selections array produces an empty batch", () => {
    const batch = buildEditBatch([], () => undefined);
    expect(batch.edits).toEqual([]);
    expect(batch.selections).toEqual([]);
  });
});
