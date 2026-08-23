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
