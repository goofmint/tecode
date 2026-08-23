/**
 * Tests for {@link createEditorNamespace} (Req 6.5, 6.6, 11.1) — a fake
 * `EditorSessionService` slice (matching `editor/inputRouter.test.ts`'s own
 * fake-session pattern) stands in for the real service so these stay unit
 * tests, not an integration suite.
 */

import { describe, expect, test } from "bun:test";
import type { Selection } from "@tecode/api";
import type { HostError } from "../host/errors";
import type { CoreDocument } from "../buffer/document";
import type { EditorState } from "../ui/editorState";
import { createEditorNamespace, type EditorNamespaceDeps } from "./editorNamespace";

function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

function cursorAt(line: number, character: number): Selection {
  const pos = { line, character };
  return { start: pos, end: pos, anchor: pos, active: pos };
}

/** A minimal `CoreDocument` fake — just enough of its surface for
 * `createEditorNamespace` (`uri`, `lineCount`, `getLine`, `applyEdits`). */
function createFakeDocument(lines: string[]): CoreDocument & { appliedEdits: unknown[] } {
  const appliedEdits: unknown[] = [];
  return {
    uri: "file:///fake.txt",
    languageId: "plaintext",
    version: 0,
    dirty: false,
    readonly: false,
    eol: "\n",
    onDidChange: () => ({ dispose() {} }),
    transaction: (fn) => fn(),
    undo: () => undefined,
    redo: () => undefined,
    getText: () => lines.join("\n"),
    markSaved: () => {},
    lineCount: lines.length,
    getLine: (n: number) => {
      const line = lines[n];
      if (line === undefined) throw new RangeError(`line ${n} out of bounds`);
      return line;
    },
    applyEdits: (edits) => {
      appliedEdits.push(edits);
    },
    appliedEdits,
  };
}

/** A fake `EditorSessionService` slice — `activeDocument` is `undefined`
 * until `setActive` is called, matching a fresh session with nothing open. */
function createFakeSession(): EditorNamespaceDeps["editorSession"] & {
  setActive(document: CoreDocument | undefined, state?: EditorState): void;
} {
  let activeDocument: CoreDocument | undefined;
  const states = new Map<string, EditorState>();

  return {
    getActiveDocument: () => activeDocument,
    getState: (uri) => {
      let state = states.get(uri);
      if (!state) {
        state = { documentUri: uri, selections: [cursorAt(0, 0)], scrollTop: 0 };
        states.set(uri, state);
      }
      return state;
    },
    setState: (uri, state) => {
      states.set(uri, state);
    },
    setActive(document, state) {
      activeDocument = document;
      if (document && state) states.set(document.uri, state);
    },
  };
}

describe("createEditorNamespace — no active document (Req 11.1)", () => {
  test("reads report the same defaults as the stub", () => {
    const { sink } = createRecordingSink();
    const session = createFakeSession();
    const editor = createEditorNamespace({ sink, editorSession: session });

    expect(editor.selections).toEqual([]);
    expect(editor.cursor).toEqual({ line: 0, character: 0 });
    expect(editor.getLine(0)).toBe("");
    expect(editor.lineCount).toBe(0);
  });

  test("mutating calls notify through the sink rather than throwing", () => {
    const { errors, sink } = createRecordingSink();
    const session = createFakeSession();
    const editor = createEditorNamespace({ sink, editorSession: session });

    editor.revealLine(3);
    editor.insertSnippet("x");
    editor.applyEdits([]);
    editor.setSelections([cursorAt(1, 1)]); // no-op, no error (documented no-op, not a notice)

    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.message.startsWith("No active editor"))).toBe(true);
  });
});

describe("createEditorNamespace — active document (Req 6.5, 6.6, 11.1)", () => {
  function setup() {
    const { errors, sink } = createRecordingSink();
    const session = createFakeSession();
    const document = createFakeDocument(["hello world", "second line", ""]);
    session.setActive(document, {
      documentUri: document.uri,
      selections: [cursorAt(0, 5)],
      scrollTop: 0,
    });
    const editor = createEditorNamespace({ sink, editorSession: session });
    return { errors, session, document, editor };
  }

  test("selections/cursor read the active document's EditorState", () => {
    const { editor } = setup();
    expect(editor.selections).toEqual([cursorAt(0, 5)]);
    expect(editor.cursor).toEqual({ line: 0, character: 5 });
  });

  test("getLine/lineCount read the active document", () => {
    const { editor } = setup();
    expect(editor.getLine(0)).toBe("hello world");
    expect(editor.getLine(1)).toBe("second line");
    expect(editor.lineCount).toBe(3);
  });

  test("getLine out of bounds reports '' rather than throwing", () => {
    const { editor } = setup();
    expect(editor.getLine(99)).toBe("");
  });

  test("setSelections writes through the session and is visible on the next read", () => {
    const { editor } = setup();
    editor.setSelections([cursorAt(2, 0)]);
    expect(editor.selections).toEqual([cursorAt(2, 0)]);
  });

  test("setSelections([]) is a documented no-op (never clears to zero selections)", () => {
    const { editor } = setup();
    editor.setSelections([]);
    expect(editor.selections).toEqual([cursorAt(0, 5)]);
  });

  test("applyEdits forwards to the active document", () => {
    const { editor, document } = setup();
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" };
    editor.applyEdits([edit]);
    expect(document.appliedEdits).toEqual([[edit]]);
  });

  test("Finding 2: mutating a returned selection does not affect subsequent reads/state", () => {
    const { editor, session, document } = setup();
    const selection = editor.selections[0]!;
    selection.start.character = 999;
    selection.end.line = 999;
    selection.anchor.character = 999;
    selection.active.character = 999;

    expect(editor.selections).toEqual([cursorAt(0, 5)]);
    expect(editor.cursor).toEqual({ line: 0, character: 5 });
    expect(session.getState(document.uri).selections).toEqual([cursorAt(0, 5)]);
  });

  test("Finding 2: mutating the returned cursor position does not affect subsequent reads", () => {
    const { editor } = setup();
    const cursor = editor.cursor;
    cursor.character = 999;
    expect(editor.cursor).toEqual({ line: 0, character: 5 });
  });

  test("Finding 2: mutating an array passed to setSelections afterward does not affect stored state", () => {
    const { editor, session, document } = setup();
    const pos = { line: 2, character: 0 };
    const input: Selection[] = [{ start: pos, end: pos, anchor: pos, active: pos }];
    editor.setSelections(input);
    pos.character = 999; // mutate the shared object after handing it over
    expect(session.getState(document.uri).selections).toEqual([cursorAt(2, 0)]);
    expect(editor.selections).toEqual([cursorAt(2, 0)]);
  });

  test("no error is reported for mutating calls once an editor is active", () => {
    const { editor, errors } = setup();
    editor.revealLine(1);
    editor.applyEdits([]);
    editor.setSelections([cursorAt(1, 0)]);
    expect(errors).toHaveLength(0);
  });
});
