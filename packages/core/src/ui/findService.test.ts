/**
 * `createFindService` tests (Req 11.1, `findService.ts`'s TSDoc): open/
 * close, live-recompute on buffer edits, next/previous wraparound,
 * replace-one/replace-all (including replace-all's single undo step),
 * index clamping, and active-editor-switch resubscription.
 *
 * A small hand-rolled fake `editorSession` (not a mock library — this
 * codebase's own house convention) backed by a real `CoreDocument`
 * (`createDocument`) so `document.applyEdits`/`transaction`/`undo` all
 * exercise the REAL buffer/undo-stack machinery, not a stand-in.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, Listener } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createHostLog } from "../host/errors";
import { createInitialEditorState, type EditorState } from "./editorState";
import { createFindService, type FindService, type FindServiceDeps } from "./findService";

function createRecordingSink() {
  return { error() {} };
}

function createTestDocument(text: string, uri = "file:///a.txt"): CoreDocument {
  return createDocument({
    uri,
    languageId: "plaintext",
    text,
    sink: createRecordingSink(),
    log: createHostLog(),
  });
}

/** A minimal, hand-rolled `editorSession` fake (this file's TSDoc) — just
 * enough of `EditorSessionService`'s shape (`FindServiceDeps.editorSession`)
 * to drive `createFindService` under test, with a `setActive` test-only
 * helper `FindServiceDeps` itself doesn't need. */
function createFakeEditorSession(initialDocument: CoreDocument | undefined) {
  const states = new Map<string, EditorState>();
  let active = initialDocument;
  const listeners = new Set<Listener<void>>();

  function fire(): void {
    for (const listener of Array.from(listeners)) listener(undefined);
  }

  return {
    getActiveDocument: () => active,
    getState: (uri: string): EditorState => {
      let state = states.get(uri);
      if (!state) {
        state = createInitialEditorState(uri);
        states.set(uri, state);
      }
      return state;
    },
    setState: (uri: string, state: EditorState): void => {
      states.set(uri, state);
      fire();
    },
    onDidChange: (listener: Listener<void>): Disposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    /** Test-only: swap the active document and notify, exactly like a real
     * `EditorSessionService.setActiveDocumentUri` would (`editorSession.
     * onDidChange` fires on every active-document switch too). */
    setActive(document: CoreDocument | undefined): void {
      active = document;
      fire();
    },
  };
}

function harness(text = "foo bar foo baz foo") {
  const document = createTestDocument(text);
  const editorSession = createFakeEditorSession(document);
  const deps: FindServiceDeps = { editorSession };
  const service: FindService = createFindService(deps);
  return { document, editorSession, service };
}

describe("createFindService — open/close (Req 11.1)", () => {
  test("open() with no active document is a no-op", () => {
    const editorSession = createFakeEditorSession(undefined);
    const service = createFindService({ editorSession });
    expect(() => service.open()).not.toThrow();
  });

  test("open() sets isOpen true; close() sets it false, keeping the query", () => {
    const { document, editorSession, service } = harness();
    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(document.uri).find?.isOpen).toBe(true);

    service.close();
    const find = editorSession.getState(document.uri).find;
    expect(find?.isOpen).toBe(false);
    expect(find?.query).toBe("foo"); // closing does not clear query/matches
    expect(find?.matches.length).toBe(3);
  });

  test("close() before ever opening is a no-op", () => {
    const { service } = harness();
    expect(() => service.close()).not.toThrow();
  });
});

describe("createFindService — setQuery / computeMatches wiring (Req 11.1)", () => {
  test("setQuery computes matches against the live buffer", () => {
    const { document, editorSession, service } = harness("foo bar foo");
    service.open();
    service.setQuery("foo");
    const find = editorSession.getState(document.uri).find!;
    expect(find.matches.length).toBe(2);
    expect(find.activeMatchIndex).toBe(0);
  });

  test("an empty query yields no matches and activeMatchIndex -1", () => {
    const { document, editorSession, service } = harness("foo bar foo");
    service.open();
    service.setQuery("");
    const find = editorSession.getState(document.uri).find!;
    expect(find.matches).toEqual([]);
    expect(find.activeMatchIndex).toBe(-1);
  });

  test("toggleCaseSensitive recomputes matches", () => {
    const { document, editorSession, service } = harness("Foo FOO foo");
    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(document.uri).find!.matches.length).toBe(3);

    service.toggleCaseSensitive();
    const find = editorSession.getState(document.uri).find!;
    expect(find.caseSensitive).toBe(true);
    expect(find.matches.length).toBe(1);
  });
});

describe("createFindService — next/previous wraparound (Req 11.1)", () => {
  test("next() advances, wrapping past the last match to the first", () => {
    const { document, editorSession, service } = harness("foo bar foo baz foo");
    service.open();
    service.setQuery("foo"); // 3 matches, activeMatchIndex starts at 0
    service.next();
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(1);
    service.next();
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(2);
    service.next(); // wraps
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(0);
  });

  test("previous() retreats, wrapping past the first match to the last", () => {
    const { document, editorSession, service } = harness("foo bar foo baz foo");
    service.open();
    service.setQuery("foo"); // activeMatchIndex starts at 0
    service.previous(); // wraps to the last of 3
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(2);
  });

  test("next()/previous() with no matches is a no-op", () => {
    const { document, editorSession, service } = harness("bar baz");
    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(document.uri).find!.matches).toEqual([]);
    service.next();
    service.previous();
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(-1);
  });
});

describe("createFindService — live recompute as the buffer changes (Req 11.1)", () => {
  test("editing the document while find is open recomputes matches", () => {
    const { document, editorSession, service } = harness("foo bar");
    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(document.uri).find!.matches.length).toBe(1);

    document.applyEdits([
      { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, newText: " foo" },
    ]);

    expect(editorSession.getState(document.uri).find!.matches.length).toBe(2);
  });

  test("activeMatchIndex clamps down when an edit removes matches out from under it", () => {
    const { document, editorSession, service } = harness("foo foo foo");
    service.open();
    service.setQuery("foo");
    service.next();
    service.next(); // activeMatchIndex = 2 (the last of 3)
    expect(editorSession.getState(document.uri).find!.activeMatchIndex).toBe(2);

    // Delete everything after (and including) the last match, dropping the
    // match count to 2 — index 2 is now out of range and must re-clamp.
    document.applyEdits([
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "" },
    ]);

    const find = editorSession.getState(document.uri).find!;
    expect(find.matches.length).toBe(2);
    expect(find.activeMatchIndex).toBeLessThan(2);
    expect(find.activeMatchIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("createFindService — replaceCurrent (Req 11.1)", () => {
  test("replaces the active match and recomputes+advances in one call", () => {
    const { document, editorSession, service } = harness("foo bar foo baz foo");
    service.open();
    service.setQuery("foo"); // matches at 0, 8, 16; activeMatchIndex 0
    service.setReplaceQuery("X");

    service.replaceCurrent();

    expect(document.getLine(0)).toBe("X bar foo baz foo");
    const find = editorSession.getState(document.uri).find!;
    // The removed match shifted the remaining two left by one slot each;
    // re-clamping index 0 onto the shrunken 2-match array lands on what was
    // previously index 1 — the NEXT match in document order.
    expect(find.matches.length).toBe(2);
    expect(find.activeMatchIndex).toBe(0);
    expect(find.matches[0]).toEqual({ start: { line: 0, character: 6 }, end: { line: 0, character: 9 } });
  });

  test("replaceCurrent is a single undo step", () => {
    const { document, service } = harness("foo bar");
    service.open();
    service.setQuery("foo");
    service.setReplaceQuery("XYZ");
    service.replaceCurrent();
    expect(document.getLine(0)).toBe("XYZ bar");

    document.undo();
    expect(document.getLine(0)).toBe("foo bar");
  });

  test("replaceCurrent with no active match is a no-op", () => {
    const { document, service } = harness("bar baz");
    service.open();
    service.setQuery("foo"); // no matches
    service.replaceCurrent();
    expect(document.getLine(0)).toBe("bar baz");
  });

  test("replaceCurrent on a readonly document is a no-op", () => {
    const document = createDocument({
      uri: "file:///ro.txt",
      languageId: "plaintext",
      text: "foo bar",
      sink: createRecordingSink(),
      log: createHostLog(),
      readonly: true,
    });
    const editorSession = createFakeEditorSession(document);
    const service = createFindService({ editorSession });
    service.open();
    service.setQuery("foo");
    service.setReplaceQuery("X");
    service.replaceCurrent();
    expect(document.getLine(0)).toBe("foo bar");
  });
});

describe("createFindService — replaceAll (Req 11.1)", () => {
  test("replaces every match", () => {
    const { document, service } = harness("foo bar foo baz foo");
    service.open();
    service.setQuery("foo");
    service.setReplaceQuery("X");

    service.replaceAll();

    expect(document.getLine(0)).toBe("X bar X baz X");
  });

  test("replaceAll is ONE undo step — undo restores the original buffer in one call", () => {
    const { document, service } = harness("foo bar foo baz foo");
    service.open();
    service.setQuery("foo");
    service.setReplaceQuery("X");
    service.replaceAll();
    expect(document.getLine(0)).toBe("X bar X baz X");

    const selectionsBeforeUndo = document.undo();
    expect(selectionsBeforeUndo).toBeDefined(); // something WAS undone
    expect(document.getLine(0)).toBe("foo bar foo baz foo"); // fully restored in one undo
  });

  test("replaceAll with no matches is a no-op", () => {
    const { document, service } = harness("bar baz");
    service.open();
    service.setQuery("foo");
    service.replaceAll();
    expect(document.getLine(0)).toBe("bar baz");
  });

  test("replaceAll on a readonly document is a no-op", () => {
    const document = createDocument({
      uri: "file:///ro2.txt",
      languageId: "plaintext",
      text: "foo foo",
      sink: createRecordingSink(),
      log: createHostLog(),
      readonly: true,
    });
    const editorSession = createFakeEditorSession(document);
    const service = createFindService({ editorSession });
    service.open();
    service.setQuery("foo");
    service.setReplaceQuery("X");
    service.replaceAll();
    expect(document.getLine(0)).toBe("foo foo");
  });
});

describe("createFindService — active-editor switch resubscription (Req 11.1)", () => {
  test("switching the active document re-points live recompute at the new one", () => {
    const documentA = createTestDocument("foo bar", "file:///a.txt");
    const documentB = createTestDocument("foo foo foo", "file:///b.txt");
    const editorSession = createFakeEditorSession(documentA);
    const service = createFindService({ editorSession });

    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(documentA.uri).find!.matches.length).toBe(1);

    editorSession.setActive(documentB);
    service.open();
    service.setQuery("foo");
    expect(editorSession.getState(documentB.uri).find!.matches.length).toBe(3);

    // Editing the now-inactive documentA must not touch documentB's find
    // state, and editing documentB must recompute documentB's (not
    // documentA's, which is no longer subscribed to).
    documentB.applyEdits([
      { range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } }, newText: " foo" },
    ]);
    expect(editorSession.getState(documentB.uri).find!.matches.length).toBe(4);

    documentA.applyEdits([
      { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, newText: " foo" },
    ]);
    // documentA is no longer tracked (it's not active) — its find state is
    // whatever it was left at, not silently recomputed behind the scenes.
    expect(editorSession.getState(documentA.uri).find!.matches.length).toBe(1);
  });

  test("dispose() stops the document subscription", () => {
    const { document, editorSession, service } = harness("foo bar");
    service.open();
    service.setQuery("foo");
    service.dispose();

    document.applyEdits([
      { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, newText: " foo" },
    ]);
    // No longer recomputed after dispose — matches whatever it was before.
    expect(editorSession.getState(document.uri).find!.matches.length).toBe(1);
  });
});
