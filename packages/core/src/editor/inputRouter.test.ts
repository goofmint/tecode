import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createHostLog, createNoopStatusSink } from "../host/errors";
import { createContextService, type ContextService } from "../keymap/context";
import type { KeyEventLike } from "../keymap/keyEvent";
import { createEditorInputRouter, type EditorInputRouterDeps } from "./inputRouter";

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  const p = pos(line, character);
  return { start: p, end: p, anchor: p, active: p };
}

function keyOf(partial: Partial<KeyEventLike> & { name: string }): KeyEventLike {
  return {
    ctrl: false,
    shift: false,
    option: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    ...partial,
  };
}

function createTestDocument(text: string, opts: { readonly?: boolean } = {}): CoreDocument {
  return createDocument({
    uri: "file:///test.txt",
    languageId: "plaintext",
    text,
    readonly: opts.readonly,
    sink: createNoopStatusSink(),
    log: createHostLog(),
  });
}

/** A minimal, directly-inspectable fake editor session — only the three
 * methods `EditorInputRouterDeps.editorSession` narrows to (this module's
 * `Pick<...>` injection, matching `keymap/chords.ts`'s pattern). */
function createFakeSession(document: CoreDocument | undefined, selections: Selection[]) {
  let state = { documentUri: document?.uri ?? "file:///unused", selections, scrollTop: 0 };
  const setStateCalls: Selection[][] = [];
  return {
    getActiveDocument: () => document,
    getState: () => state,
    setState: (_uri: string, next: typeof state) => {
      state = next;
      setStateCalls.push(next.selections);
    },
    currentSelections: () => state.selections,
    setStateCallCount: () => setStateCalls.length,
  };
}

function buildRouter(deps: {
  context?: Pick<ContextService, "get">;
  editorSession: EditorInputRouterDeps["editorSession"];
}) {
  const context = deps.context ?? (() => {
    const c = createContextService();
    c.set("editorTextFocus", true);
    return c;
  })();
  return createEditorInputRouter({ context, editorSession: deps.editorSession });
}

describe("createEditorInputRouter (Task 2.2, Req 4.6, 6.6, design.md §6.1, §8.3)", () => {
  test("no-op when editorTextFocus is falsy", () => {
    const document = createTestDocument("hello");
    const session = createFakeSession(document, [cursorAt(0, 0)]);
    const context = createContextService(); // editorTextFocus never set
    const router = buildRouter({ context, editorSession: session });

    const handled = router.routeKeyEvent(keyOf({ name: "a" }));
    expect(handled).toBe(false);
    expect(document.getLine(0)).toBe("hello");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("no-op when there is no active document", () => {
    const session = createFakeSession(undefined, [cursorAt(0, 0)]);
    const router = buildRouter({ editorSession: session });
    expect(router.routeKeyEvent(keyOf({ name: "a" }))).toBe(false);
  });

  test("a single cursor typing inserts the character and advances the cursor", () => {
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "b", sequence: "b" }))).toBe(true);
    expect(document.getLine(0)).toBe("abc");
    expect(session.currentSelections()).toEqual([cursorAt(0, 2)]);
  });

  test("two cursors on different lines both insert and both advance", () => {
    const document = createTestDocument("a\nc");
    const session = createFakeSession(document, [cursorAt(0, 1), cursorAt(1, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "x", sequence: "x" }))).toBe(true);
    expect(document.getLine(0)).toBe("ax");
    expect(document.getLine(1)).toBe("cx");
    expect(session.currentSelections()).toEqual([cursorAt(0, 2), cursorAt(1, 2)]);
  });

  test("two cursors on the SAME line both insert and both advance correctly", () => {
    // "abcdef" with cursors after 'b' (index 2) and after 'e' (index 5).
    const document = createTestDocument("abcdef");
    const session = createFakeSession(document, [cursorAt(0, 2), cursorAt(0, 5)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "X", sequence: "X" }))).toBe(true);
    expect(document.getLine(0)).toBe("abXcdeXf");
    // First cursor: inserted at 2 -> advances to 3.
    // Second cursor: originally at 5, shifted right by 1 from the first
    // insert, then its own insert advances it by 1 more -> 7.
    expect(session.currentSelections()).toEqual([cursorAt(0, 3), cursorAt(0, 7)]);
  });

  test("backspace at a single cursor deletes the character before it", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 2)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "backspace" }))).toBe(true);
    expect(document.getLine(0)).toBe("ac");
    expect(session.currentSelections()).toEqual([cursorAt(0, 1)]);
  });

  test("backspace at document start (0,0) is a no-op for that cursor", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 0)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "backspace" }))).toBe(true);
    expect(document.getLine(0)).toBe("abc");
    expect(session.currentSelections()).toEqual([cursorAt(0, 0)]);
  });

  test("backspace at a line start joins it to the end of the previous line", () => {
    const document = createTestDocument("abc\ndef");
    const session = createFakeSession(document, [cursorAt(1, 0)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "backspace" }))).toBe(true);
    expect(document.lineCount).toBe(1);
    expect(document.getLine(0)).toBe("abcdef");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
  });

  test("delete at a single cursor removes the character after it", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "delete" }))).toBe(true);
    expect(document.getLine(0)).toBe("ac");
    // Forward-delete does not move the cursor.
    expect(session.currentSelections()).toEqual([cursorAt(0, 1)]);
  });

  test("delete at document end is a no-op for that cursor", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 3)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "delete" }))).toBe(true);
    expect(document.getLine(0)).toBe("abc");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
  });

  test("delete at a line end joins the next line onto it", () => {
    const document = createTestDocument("abc\ndef");
    const session = createFakeSession(document, [cursorAt(0, 3)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "delete" }))).toBe(true);
    expect(document.lineCount).toBe(1);
    expect(document.getLine(0)).toBe("abcdef");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
  });

  test("two colliding cursors (same position) merge into one before editing", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1), cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "x", sequence: "x" }))).toBe(true);
    // Only one 'x' was inserted — the duplicate cursor did not double-type.
    expect(document.getLine(0)).toBe("axbc");
    expect(session.currentSelections()).toEqual([cursorAt(0, 2)]);
  });

  test("two adjacent cursors backspacing into the same position merge afterwards", () => {
    // Cursors after 'a' (1) and after 'b' (2) in "abc"; both backspace.
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1), cursorAt(0, 2)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "backspace" }))).toBe(true);
    expect(document.getLine(0)).toBe("c");
    // Both cursors land at column 0 — merged into a single selection.
    expect(session.currentSelections()).toEqual([cursorAt(0, 0)]);
  });

  test("a readonly document ignores the edit and leaves selections untouched", () => {
    const document = createTestDocument("abc", { readonly: true });
    const original = [cursorAt(0, 1)];
    const session = createFakeSession(document, original);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "x", sequence: "x" }))).toBe(true);
    expect(document.getLine(0)).toBe("abc");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("arrow keys and other unhandled keys are not routed", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "left" }))).toBe(false);
    expect(router.routeKeyEvent(keyOf({ name: "tab", sequence: "\t" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
  });

  test("ctrl/meta combinations are not treated as insertable text", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "s", ctrl: true, sequence: "" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
  });

  test("one keystroke across N cursors is a single undo entry", () => {
    const document = createTestDocument("a\nc");
    const original = [cursorAt(0, 1), cursorAt(1, 1)];
    const session = createFakeSession(document, original);
    const router = buildRouter({ editorSession: session });

    router.routeKeyEvent(keyOf({ name: "x", sequence: "x" }));
    expect(document.getLine(0)).toBe("ax");
    expect(document.getLine(1)).toBe("cx");

    const restoredSelections = document.undo();
    expect(document.getLine(0)).toBe("a");
    expect(document.getLine(1)).toBe("c");
    expect(restoredSelections).toEqual(original);

    // A second undo has nothing left to do — proving the whole multi-cursor
    // batch really was ONE undo entry, not two.
    expect(document.undo()).toBeUndefined();
  });
});

describe("EditorInputRouter.insertText (Issue #91's paste path, Req 6.6)", () => {
  test("no-op when editorTextFocus is falsy", () => {
    const document = createTestDocument("hello");
    const session = createFakeSession(document, [cursorAt(0, 0)]);
    const context = createContextService(); // editorTextFocus never set
    const router = buildRouter({ context, editorSession: session });

    router.insertText("X");
    expect(document.getLine(0)).toBe("hello");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("no-op when there is no active document", () => {
    const session = createFakeSession(undefined, [cursorAt(0, 0)]);
    const router = buildRouter({ editorSession: session });
    expect(() => router.insertText("X")).not.toThrow();
    expect(session.setStateCallCount()).toBe(0);
  });

  test("no-op on a readonly document", () => {
    const document = createTestDocument("hello", { readonly: true });
    const session = createFakeSession(document, [cursorAt(0, 0)]);
    const router = buildRouter({ editorSession: session });

    router.insertText("X");
    expect(document.getLine(0)).toBe("hello");
  });

  test("a single cursor: multi-line text lands as ONE document.applyEdits call, not one per line", () => {
    // The mutation this test is built to catch: an implementation that
    // loops `document.applyEdits(...)` once per line of the pasted text
    // (instead of building one `TextEdit[]` batch and calling `applyEdits`
    // exactly once) would still leave the BUFFER content correct — the
    // assertions below on `getLine` alone would not catch it — but would
    // call through `applyEdits` more than once. Wrapping the real
    // `CoreDocument.applyEdits` to count invocations is what actually
    // proves the "one call" contract (this module's `EditorInputRouter.
    // insertText` TSDoc, Req 6.6).
    const document = createTestDocument("ac");
    let applyEditsCallCount = 0;
    const originalApplyEdits = document.applyEdits.bind(document);
    document.applyEdits = (edits, opts) => {
      applyEditsCallCount++;
      originalApplyEdits(edits, opts);
    };
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    router.insertText("line1\nline2\nline3");

    expect(applyEditsCallCount).toBe(1);
    expect(document.getLine(0)).toBe("aline1");
    expect(document.getLine(1)).toBe("line2");
    expect(document.getLine(2)).toBe("line3c");
    expect(session.currentSelections()).toEqual([cursorAt(2, 5)]);
  });

  test("a multi-line paste across multiple cursors is a SINGLE undo entry", () => {
    const document = createTestDocument("a\nc");
    const original = [cursorAt(0, 1), cursorAt(1, 1)];
    const session = createFakeSession(document, original);
    const router = buildRouter({ editorSession: session });

    router.insertText("X\nY");
    // Original text "a\nc" with "X\nY" inserted after 'a' (offset 1) AND
    // after 'c' (offset 3, the buffer's end) — both in ONE batch, computed
    // against the ORIGINAL (pre-batch) coordinates: "aX\nY\ncX\nY".
    expect(document.getLine(0)).toBe("aX");
    expect(document.getLine(1)).toBe("Y");
    expect(document.getLine(2)).toBe("cX");
    expect(document.getLine(3)).toBe("Y");

    const restoredSelections = document.undo();
    expect(document.getLine(0)).toBe("a");
    expect(document.getLine(1)).toBe("c");
    expect(restoredSelections).toEqual(original);

    // A second undo has nothing left to do — the whole multi-cursor,
    // multi-line paste really was ONE undo entry, not one per cursor/line.
    expect(document.undo()).toBeUndefined();
  });

  test("replaces a non-collapsed FORWARD selection and lands the cursor after the inserted text", () => {
    const document = createTestDocument("abcdef");
    const start = pos(0, 1);
    const end = pos(0, 4);
    const selection: Selection = { start, end, anchor: start, active: end };
    const session = createFakeSession(document, [selection]);
    const router = buildRouter({ editorSession: session });

    router.insertText("XY");
    expect(document.getLine(0)).toBe("aXYef");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
  });

  test("replaces a non-collapsed BACKWARD selection (active at the start) and still lands after the inserted text", () => {
    const document = createTestDocument("abcdef");
    const start = pos(0, 1);
    const end = pos(0, 4);
    // Backward selection: anchor at the far end, active at the near end —
    // `range.start`/`range.end` are still `[1, 4)` (Selection extends
    // Range), but `active` is `start`, not `end`. This is exactly the case
    // `buildInsertTextBatch`'s TSDoc explains: tracking `active` directly
    // would land the cursor at the WRONG end of the inserted text.
    const selection: Selection = { start, end, anchor: end, active: start };
    const session = createFakeSession(document, [selection]);
    const router = buildRouter({ editorSession: session });

    router.insertText("XY");
    expect(document.getLine(0)).toBe("aXYef");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
  });

  test("two cursors on the same line both insert and both advance correctly", () => {
    const document = createTestDocument("abcdef");
    const session = createFakeSession(document, [cursorAt(0, 2), cursorAt(0, 5)]);
    const router = buildRouter({ editorSession: session });

    router.insertText("Z");
    expect(document.getLine(0)).toBe("abZcdeZf");
    expect(session.currentSelections()).toEqual([cursorAt(0, 3), cursorAt(0, 7)]);
  });

  test("bypasses the single-code-point restriction: a multi-character sequence is not rejected", () => {
    // `routeKeyEvent`'s own `classifyKeyEvent`/`isPrintableSequence` would
    // reject any `sequence` longer than one code point outright — proving
    // `insertText` never goes through that path at all.
    const document = createTestDocument("");
    const session = createFakeSession(document, [cursorAt(0, 0)]);
    const router = buildRouter({ editorSession: session });

    router.insertText("hello world");
    expect(document.getLine(0)).toBe("hello world");
  });
});
