/**
 * `cursorPosition.ts` unit tests (Issue #123, Req 6.6, 13.1; design.md
 * §8.3): the hardware-cursor coordinate math itself, isolated from
 * `EditorView`/OpenTUI entirely. Fixture conventions (CJK width, tab stops)
 * match `cellWidth.test.ts`'s own — this module's column math is a thin
 * wrapper over the exact same {@link cellWidthUpTo} that file tests
 * directly.
 */

import { describe, expect, test } from "bun:test";
import { computeHardwareCursorPosition, cursorCellColumn } from "./cursorPosition";

describe("cursorCellColumn (moved from editorView.tsx, Issue #123 — unchanged behavior)", () => {
  test("plain ASCII: one column per character", () => {
    expect(cursorCellColumn("hello", 3)).toBe(3);
  });

  test("a full-width CJK character advances the column by 2 cells, not 1", () => {
    const line = "a古b";
    expect(cursorCellColumn(line, 0)).toBe(0); // before "a"
    expect(cursorCellColumn(line, 1)).toBe(1); // after "a", before "古"
    expect(cursorCellColumn(line, 2)).toBe(3); // after "古" (1 + 2), before "b"
    expect(cursorCellColumn(line, 3)).toBe(4); // after "b"
  });

  test("a tab advances to the next tab-stop boundary", () => {
    expect(cursorCellColumn("\tx", 1)).toBe(4); // default tabSize 4
    expect(cursorCellColumn("\tx", 1, 2)).toBe(2); // custom tabSize
  });
});

/** A `HardwareCursorPositionInput` with every field defaulted to "caret at
 * document/screen origin, one full viewport of visible lines" — each test
 * below overrides only the fields it's actually exercising. */
function baseInput(
  overrides: Partial<Parameters<typeof computeHardwareCursorPosition>[0]> = {},
): Parameters<typeof computeHardwareCursorPosition>[0] {
  return {
    screenX: 0,
    screenY: 0,
    gutterWidth: 0,
    cursorLine: 0,
    scrollTop: 0,
    endLine: 20,
    lineText: "",
    character: 0,
    ...overrides,
  };
}

describe("computeHardwareCursorPosition (Issue #123)", () => {
  test("caret at document/screen origin: 1-based x/y start at (1, 1), not (0, 0)", () => {
    // `EditBufferRenderable.renderCursor`'s own `screenX + visualCol + 1`
    // convention (`cursorPosition.ts`'s top-of-file TSDoc) — verified
    // against the vendored `@opentui/core` compiled output.
    const result = computeHardwareCursorPosition(baseInput());
    expect(result).toEqual({ x: 1, y: 1, visible: true });
  });

  test("screenX/screenY offset (the text plane's own on-screen position) shifts x/y by exactly that much", () => {
    const result = computeHardwareCursorPosition(baseInput({ screenX: 10, screenY: 3 }));
    expect(result.x).toBe(11);
    expect(result.y).toBe(4);
  });

  test("gutterWidth pushes the caret's column right by exactly its width", () => {
    const withoutGutter = computeHardwareCursorPosition(baseInput({ character: 2, lineText: "abcdef" }));
    const withGutter = computeHardwareCursorPosition(
      baseInput({ character: 2, lineText: "abcdef", gutterWidth: 4 }),
    );
    expect(withGutter.x).toBe(withoutGutter.x + 4);
  });

  test("a full-width CJK character before the caret advances the column by 2 cells, not 1 (cellWidthUpTo)", () => {
    const line = "a古b";
    // Caret after "a" (character 1): only the 1-cell "a" precedes it.
    const afterA = computeHardwareCursorPosition(baseInput({ lineText: line, character: 1 }));
    expect(afterA.x).toBe(1 /* base offset */ + 1);
    // Caret after "古" (character 2): "a" (1 cell) + "古" (2 cells) precede
    // it — the column must jump by 2, not 1, or a caret placed after a CJK
    // character would land one cell short of where it renders.
    const afterKanji = computeHardwareCursorPosition(baseInput({ lineText: line, character: 2 }));
    expect(afterKanji.x).toBe(1 + 3);
    expect(afterKanji.x - afterA.x).toBe(2);
  });

  test("a tab before the caret advances the column to the next tab stop, reflecting tabSize", () => {
    const defaultTabSize = computeHardwareCursorPosition(baseInput({ lineText: "\tx", character: 1 }));
    expect(defaultTabSize.x).toBe(1 + 4); // default tabSize 4
    const customTabSize = computeHardwareCursorPosition(
      baseInput({ lineText: "\tx", character: 1, tabSize: 2 }),
    );
    expect(customTabSize.x).toBe(1 + 2);
  });

  test("a non-zero scrollTop offsets y by exactly (cursorLine - scrollTop)", () => {
    const result = computeHardwareCursorPosition(
      baseInput({ screenY: 5, cursorLine: 12, scrollTop: 10, endLine: 30 }),
    );
    // y = screenY + (cursorLine - scrollTop) + 1 = 5 + 2 + 1
    expect(result.y).toBe(8);
    expect(result.visible).toBe(true);
  });

  test("scrollTop does not affect x at all", () => {
    const atScrollTop0 = computeHardwareCursorPosition(baseInput({ character: 3, lineText: "abcdef" }));
    const atScrollTop10 = computeHardwareCursorPosition(
      baseInput({ character: 3, lineText: "abcdef", cursorLine: 10, scrollTop: 10, endLine: 30 }),
    );
    expect(atScrollTop10.x).toBe(atScrollTop0.x);
  });

  test("the caret's line above the visible window (scrolled past it) reports visible: false", () => {
    const result = computeHardwareCursorPosition(baseInput({ cursorLine: 4, scrollTop: 5, endLine: 25 }));
    expect(result.visible).toBe(false);
  });

  test("the caret's line at or below the visible window's end reports visible: false", () => {
    const atEnd = computeHardwareCursorPosition(baseInput({ cursorLine: 20, scrollTop: 0, endLine: 20 }));
    expect(atEnd.visible).toBe(false); // endLine is exclusive
    const pastEnd = computeHardwareCursorPosition(baseInput({ cursorLine: 25, scrollTop: 0, endLine: 20 }));
    expect(pastEnd.visible).toBe(false);
  });

  test("the caret's line exactly at scrollTop (the first visible row) reports visible: true", () => {
    const result = computeHardwareCursorPosition(baseInput({ cursorLine: 7, scrollTop: 7, endLine: 27 }));
    expect(result.visible).toBe(true);
    expect(result.y).toBe(1); // screenY 0 + (7 - 7) + 1
  });

  test("the caret's line exactly at endLine - 1 (the last visible row) reports visible: true", () => {
    const result = computeHardwareCursorPosition(baseInput({ cursorLine: 19, scrollTop: 0, endLine: 20 }));
    expect(result.visible).toBe(true);
  });
});
