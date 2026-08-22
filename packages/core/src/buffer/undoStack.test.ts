import { describe, expect, test } from "bun:test";
import type { Selection, TextEdit } from "@tecode/api";
import type { Clock } from "./clock";
import {
  createUndoStack,
  TYPING_COALESCE_WINDOW_MS,
  type PushInput,
  type TypingCoalesceHint,
} from "./undoStack";

/** A fake, manually advanceable {@link Clock} — deterministic coalescing
 * tests must never depend on real elapsed time. */
function createFakeClock(startAt = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

function edit(text: string, char = 0, line = 0): TextEdit {
  return {
    range: { start: { line, character: char }, end: { line, character: char } },
    newText: text,
  };
}

const NO_SELECTIONS: Selection[] = [];

function typingHint(char: number, line = 0): TypingCoalesceHint {
  return { line, insertedAt: { line, character: char } };
}

/** Minimal push for a single-character insert at `char` on `line`,
 * treated as typing (no explicit group). */
function pushTyped(
  stack: ReturnType<typeof createUndoStack>,
  char: number,
  line = 0,
  overrides: Partial<PushInput> = {},
): void {
  stack.push({
    inverseEdits: [edit("", char, line)],
    selectionsBefore: NO_SELECTIONS,
    selectionsAfter: NO_SELECTIONS,
    typing: typingHint(char, line),
    ...overrides,
  });
}

describe("createUndoStack — typing coalescing (Req 5.4)", () => {
  test("consecutive single-character inserts on the same line merge into one entry", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0); // types "a" at 0 -> insertedAt 0, positionAfter 1
    clock.advance(10);
    pushTyped(stack, 1); // types "b" at 1 -> continues
    clock.advance(10);
    pushTyped(stack, 2); // types "c" at 2 -> continues

    const entry = stack.undo();
    expect(entry).toBeDefined();
    expect(entry!.inverseEdits).toHaveLength(3);
    // Most-recent-first order, per this module's documented convention.
    expect(entry!.inverseEdits.map((e) => e.range.start.character)).toEqual([2, 1, 0]);
    // Only one entry existed — a second undo() call is empty.
    expect(stack.undo()).toBeUndefined();
  });

  test("breaks coalescing after more than 750 ms elapses", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0);
    clock.advance(TYPING_COALESCE_WINDOW_MS + 1);
    pushTyped(stack, 1);

    // Two distinct entries now on the stack.
    const second = stack.undo();
    expect(second!.inverseEdits).toHaveLength(1);
    const first = stack.undo();
    expect(first!.inverseEdits).toHaveLength(1);
    expect(stack.undo()).toBeUndefined();
  });

  test("merges exactly at the 750 ms boundary (inclusive)", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0);
    clock.advance(TYPING_COALESCE_WINDOW_MS);
    pushTyped(stack, 1);

    const entry = stack.undo();
    expect(entry!.inverseEdits).toHaveLength(2);
  });

  test("breaks coalescing on a newline insert", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0);
    // A newline insert carries no typing hint (Document's job to omit
    // it) — this push is therefore a fresh, non-coalescable entry.
    stack.push({
      inverseEdits: [edit("", 1, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
    });

    const second = stack.undo();
    expect(second!.inverseEdits).toHaveLength(1);
    const first = stack.undo();
    expect(first!.inverseEdits).toHaveLength(1);
  });

  test("breaks coalescing when the cursor moves (non-contiguous position)", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0); // insertedAt 0, positionAfter 1
    pushTyped(stack, 5); // does not continue from 1

    const second = stack.undo();
    expect(second!.inverseEdits).toHaveLength(1);
    expect(second!.inverseEdits[0]!.range.start.character).toBe(5);
    const first = stack.undo();
    expect(first!.inverseEdits).toHaveLength(1);
  });

  test("breaks coalescing across lines even at the same character offset", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 3, 0);
    pushTyped(stack, 3, 1);

    const second = stack.undo();
    expect(second!.inverseEdits[0]!.range.start.line).toBe(1);
    const first = stack.undo();
    expect(first!.inverseEdits[0]!.range.start.line).toBe(0);
  });

  test("a non-typing push (multi-char insert) does not coalesce with a following keystroke", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    // A paste: no typing hint, even though it's a single edit.
    stack.push({
      inverseEdits: [edit("", 5, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
    });
    // A keystroke that would otherwise continue from character 5.
    pushTyped(stack, 5);

    const second = stack.undo();
    expect(second!.inverseEdits).toHaveLength(1);
    const first = stack.undo();
    expect(first!.inverseEdits).toHaveLength(1);
  });
});

describe("createUndoStack — explicit transaction grouping", () => {
  test("multiple pushes sharing a groupId merge into a single entry", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    stack.push({
      inverseEdits: [edit("first", 0, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
      groupId: "txn-1",
    });
    stack.push({
      inverseEdits: [edit("second", 0, 1)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
      groupId: "txn-1",
    });

    const entry = stack.undo();
    expect(entry!.inverseEdits).toHaveLength(2);
    // Later edit's inverse is prepended.
    expect(entry!.inverseEdits[0]!.newText).toBe("second");
    expect(entry!.inverseEdits[1]!.newText).toBe("first");
    expect(stack.undo()).toBeUndefined();
  });

  test("a transaction-grouped entry never coalesces with a following keystroke", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    stack.push({
      inverseEdits: [edit("", 0, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
      groupId: "txn-1",
    });
    // Would continue from position 1 if the transaction entry were
    // coalescable — it must not be.
    pushTyped(stack, 1);

    const second = stack.undo();
    expect(second!.inverseEdits).toHaveLength(1);
    const first = stack.undo();
    expect(first!.groupId).toBe("txn-1");
  });

  test("a different groupId opens a new entry rather than merging", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    stack.push({
      inverseEdits: [edit("a", 0, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
      groupId: "txn-1",
    });
    stack.push({
      inverseEdits: [edit("b", 0, 0)],
      selectionsBefore: NO_SELECTIONS,
      selectionsAfter: NO_SELECTIONS,
      groupId: "txn-2",
    });

    expect(stack.undo()!.groupId).toBe("txn-2");
    expect(stack.undo()!.groupId).toBe("txn-1");
  });
});

describe("createUndoStack — redo stack lifecycle", () => {
  test("a new push clears the redo stack", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0);
    const entry = stack.undo()!;
    stack.recordRedo(entry);
    expect(stack.redo()).toBeDefined();
    stack.recordUndo(entry); // put it back so we have something to clear

    pushTyped(stack, 10);
    expect(stack.redo()).toBeUndefined();
  });

  test("moving an entry between stacks during undo/redo does not clear the redo stack", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    pushTyped(stack, 0);
    pushTyped(stack, 20); // deliberately non-contiguous: two separate entries

    const topUndo = stack.undo()!;
    stack.recordRedo(topUndo);
    // A second undo()/recordRedo() cycle must not wipe the redo entry
    // just recorded.
    const nextUndo = stack.undo()!;
    stack.recordRedo(nextUndo);

    expect(stack.redo()).toBeDefined();
    expect(stack.redo()).toBeDefined();
    expect(stack.redo()).toBeUndefined();
  });
});

describe("createUndoStack — undo/redo cycle consistency", () => {
  test("undo -> redo -> undo returns consistent edits and selection payloads", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });

    const before: Selection[] = [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    ];
    const after: Selection[] = [
      { start: { line: 0, character: 1 }, end: { line: 0, character: 1 }, anchor: { line: 0, character: 1 }, active: { line: 0, character: 1 } },
    ];

    stack.push({
      inverseEdits: [edit("", 0, 0)],
      selectionsBefore: before,
      selectionsAfter: after,
    });

    // undo
    const undone = stack.undo()!;
    expect(undone.selectionsBefore).toEqual(before);
    expect(undone.selectionsAfter).toEqual(after);
    // Document would recompute the redo batch from re-applying
    // undone.inverseEdits through the LineBuffer; here we simulate that
    // with a stand-in "redo edit" and record it.
    const redoBatch: TextEdit[] = [edit("x", 0, 0)];
    stack.recordRedo({
      inverseEdits: redoBatch,
      selectionsBefore: undone.selectionsBefore,
      selectionsAfter: undone.selectionsAfter,
      groupId: undone.groupId,
    });

    // redo
    const redone = stack.redo()!;
    expect(redone.inverseEdits).toEqual(redoBatch);
    expect(redone.selectionsBefore).toEqual(before);
    expect(redone.selectionsAfter).toEqual(after);
    const undoBatch: TextEdit[] = [edit("", 0, 0)];
    stack.recordUndo({
      inverseEdits: undoBatch,
      selectionsBefore: redone.selectionsBefore,
      selectionsAfter: redone.selectionsAfter,
      groupId: redone.groupId,
    });

    // undo again — full round trip.
    const undoneAgain = stack.undo()!;
    expect(undoneAgain.inverseEdits).toEqual(undoBatch);
    expect(undoneAgain.selectionsBefore).toEqual(before);
    expect(undoneAgain.selectionsAfter).toEqual(after);
    expect(stack.undo()).toBeUndefined();
  });
});

describe("createUndoStack — empty stacks are silent no-ops", () => {
  test("undo() and redo() on an empty stack return undefined without throwing", () => {
    const clock = createFakeClock();
    const stack = createUndoStack({ clock });
    expect(() => stack.undo()).not.toThrow();
    expect(stack.undo()).toBeUndefined();
    expect(() => stack.redo()).not.toThrow();
    expect(stack.redo()).toBeUndefined();
  });
});
