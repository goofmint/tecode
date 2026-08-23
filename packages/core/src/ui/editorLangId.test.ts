import { describe, expect, test } from "bun:test";
import type { Listener } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import { createContextService } from "../keymap/context";
import { wireEditorLangIdContext } from "./editorLangId";

/** A minimal fake `EditorSessionService` slice — only what
 * `wireEditorLangIdContext` depends on (its own `Pick<...>` deps type) —
 * with a directly-triggerable `fire()` standing in for a real active
 * document change. */
function createFakeSession(initialDocument: CoreDocument | undefined) {
  let active = initialDocument;
  const listeners = new Set<Listener<void>>();
  return {
    getActiveDocument: () => active,
    onDidChange: (listener: Listener<void>) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setActive(document: CoreDocument | undefined) {
      active = document;
      for (const listener of listeners) listener(undefined);
    },
  };
}

function fakeDocument(languageId: string): CoreDocument {
  return { languageId } as CoreDocument;
}

describe("wireEditorLangIdContext (Req 4.6, design.md §6.4)", () => {
  test("sets editorLangId to undefined immediately when there is no active document", () => {
    const context = createContextService();
    const session = createFakeSession(undefined);
    wireEditorLangIdContext({ editorSession: session, context });
    expect(context.get<string>("editorLangId")).toBeUndefined();
  });

  test("sets editorLangId to the active document's languageId immediately", () => {
    const context = createContextService();
    const session = createFakeSession(fakeDocument("typescript"));
    wireEditorLangIdContext({ editorSession: session, context });
    expect(context.get<string>("editorLangId")).toBe("typescript");
  });

  test("updates editorLangId when the active document changes", () => {
    const context = createContextService();
    const session = createFakeSession(fakeDocument("typescript"));
    wireEditorLangIdContext({ editorSession: session, context });

    session.setActive(fakeDocument("python"));
    expect(context.get<string>("editorLangId")).toBe("python");
  });

  test("clears editorLangId when the active document closes to none", () => {
    const context = createContextService();
    const session = createFakeSession(fakeDocument("typescript"));
    wireEditorLangIdContext({ editorSession: session, context });

    session.setActive(undefined);
    expect(context.get<string>("editorLangId")).toBeUndefined();
  });

  test("dispose stops further updates", () => {
    const context = createContextService();
    const session = createFakeSession(fakeDocument("typescript"));
    const handle = wireEditorLangIdContext({ editorSession: session, context });

    handle.dispose();
    session.setActive(fakeDocument("python"));
    expect(context.get<string>("editorLangId")).toBe("typescript");
  });

  test("dispose is idempotent", () => {
    const context = createContextService();
    const session = createFakeSession(undefined);
    const handle = wireEditorLangIdContext({ editorSession: session, context });
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });
});
