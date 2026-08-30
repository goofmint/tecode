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

  test("a single-code-point Japanese character inserts (Issue #110 regression guard)", () => {
    // Guards against a regression in the OPPOSITE direction: an
    // over-eager fix for Issue #110 that special-cased "more than one code
    // point" without preserving the single-code-point case.
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "あ", sequence: "あ" }))).toBe(true);
    expect(document.getLine(0)).toBe("aあc");
    expect(session.currentSelections()).toEqual([cursorAt(0, 2)]);
  });

  test("Issue #110: a multi-code-point IME commit inserts as text, with the cursor after it", () => {
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "日本語", sequence: "日本語" }))).toBe(true);
    expect(document.getLine(0)).toBe("a日本語c");
    expect(session.currentSelections()).toEqual([cursorAt(0, 4)]);
  });

  test("Issue #110: an IME commit is applied as ONE document.applyEdits call (one undo entry)", () => {
    const document = createTestDocument("ac");
    let applyEditsCallCount = 0;
    const originalApplyEdits = document.applyEdits.bind(document);
    document.applyEdits = (edits, opts) => {
      applyEditsCallCount++;
      originalApplyEdits(edits, opts);
    };
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    router.routeKeyEvent(keyOf({ name: "日本語", sequence: "日本語" }));

    expect(applyEditsCallCount).toBe(1);
    expect(document.getLine(0)).toBe("a日本語c");

    const restoredSelections = document.undo();
    expect(document.getLine(0)).toBe("ac");
    expect(restoredSelections).toEqual([cursorAt(0, 1)]);
    // A second undo has nothing left to do — the whole IME commit really
    // was ONE undo entry, not one per code point.
    expect(document.undo()).toBeUndefined();
  });

  test("Issue #110: an IME commit at two cursors lands correctly at both", () => {
    const document = createTestDocument("a\nc");
    const session = createFakeSession(document, [cursorAt(0, 1), cursorAt(1, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "日本語", sequence: "日本語" }))).toBe(true);
    expect(document.getLine(0)).toBe("a日本語");
    expect(document.getLine(1)).toBe("c日本語");
    expect(session.currentSelections()).toEqual([cursorAt(0, 4), cursorAt(1, 4)]);
  });

  test("Issue #110: an IME commit in the shape @opentui/core actually produces (name: \"\") inserts", () => {
    // The other Issue #110 tests pass `name: "日本語"`, which is convenient
    // but is NOT what a terminal delivers. Verified against
    // `@opentui/core`'s bundled `parse.keypress.ts`: its `parseKeypress`
    // seeds `{ name: "", sequence: s, raw: s, source: "raw" }` and then
    // assigns `name` only in branches that require a control character, an
    // ESC prefix, or `s.length === 1` (plus a surrogate-pair case). A
    // multi-code-point IME commit matches NONE of them, so it arrives with
    // `name` still the empty string and the whole committed string in
    // `sequence`. That is the exact event the iPad bug report is about, so
    // assert on it directly — otherwise a future guard keyed on `name`
    // (say, requiring a non-empty or single-character name) could reject
    // real IME input while every other test here still passed.
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "", sequence: "日本語" }))).toBe(true);
    expect(document.getLine(0)).toBe("a日本語c");
    expect(session.currentSelections()).toEqual([cursorAt(0, 4)]);
  });

  test("an 8-bit C1 control sequence does not insert (CodeRabbit PR #112 review)", () => {
    // U+009B is CSI, the single-code-point 8-bit form of the `ESC [` that
    // introduces a cursor-key escape, so "\u009b[A" is an 8-bit cursor-up.
    // `@opentui/core`'s `parseKeypress` only recognizes the 7-bit
    // `\x1b`-prefixed forms, so a terminal emitting the 8-bit form matches
    // none of its branches and this arrives with `name` still empty —
    // exactly the shape a real IME commit has, which is why `name` cannot
    // be what distinguishes them and `isPrintableSequence` must reject the
    // C1 range itself.
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "", sequence: "\u009b[A" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("a lone C1 control character does not insert (CodeRabbit PR #112 review)", () => {
    // Guards the range check independently of the multi-code-point path
    // above: a single C1 code point passed the SUPERSEDED single-code-point
    // rule too (it is >= 0x20 and not 0x7f), so this one is a genuinely
    // pre-existing hole that the same fix closes.
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "", sequence: "\u0085" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("U+00A0 and other characters just past the C1 range still insert", () => {
    // Boundary guard: the C1 rejection must stop at 0x9f. U+00A0 (no-break
    // space) and U+00E9 ("é", reachable on many layouts via a dead key or
    // Option) are ordinary printable text and must survive it.
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "", sequence: "\u00a0é" }))).toBe(true);
    expect(document.getLine(0)).toBe("a\u00a0éc");
  });

  test("Issue #110: an arrow key's escape sequence does not insert", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "down", sequence: "\x1b[B" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("Issue #110: a named control key from the blocklist does not insert", () => {
    const document = createTestDocument("abc");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    // "pageup"'s sequence is already ESC-prefixed and so is already
    // rejected by `isPrintableSequence` alone; this test's real target is
    // the `NON_INSERT_KEY_NAMES` guard, so it fabricates a `sequence` that
    // WOULD otherwise look printable to prove the guard — not
    // `isPrintableSequence` — is what stops it.
    expect(router.routeKeyEvent(keyOf({ name: "pageup", sequence: "P" }))).toBe(false);
    expect(document.getLine(0)).toBe("abc");
    expect(session.setStateCallCount()).toBe(0);
  });

  test("Issue #110: an emoji outside the BMP inserts as one code point", () => {
    // "😀" is one Unicode code point but two UTF-16 code units — exercises
    // `isPrintableSequence`'s `Array.from` code-point iteration rather than
    // `.length`/indexing, which would see two (unpaired-surrogate) units.
    const document = createTestDocument("ac");
    const session = createFakeSession(document, [cursorAt(0, 1)]);
    const router = buildRouter({ editorSession: session });

    expect(router.routeKeyEvent(keyOf({ name: "😀", sequence: "😀" }))).toBe(true);
    expect(document.getLine(0)).toBe("a😀c");
    // "😀" is one code point but TWO UTF-16 code units, and `Position.
    // character`/`newText.length` (`positionTransform.ts`) are UTF-16-unit
    // based, so the cursor advances by 2 from its start at character 1, not
    // by 1 — this is what distinguishes "counted as one code point" from
    // "counted as one JS string unit" for THIS assertion.
    expect(session.currentSelections()).toEqual([cursorAt(0, 3)]);
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
