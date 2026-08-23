import { describe, expect, test } from "bun:test";
import type { DocumentManagerFs } from "../buffer/documentManager";
import { createDocumentManager } from "../buffer/documentManager";
import { pathToUri } from "../buffer/uri";
import { createHostLog } from "../host/errors";
import { createEditorSessionService } from "./editorSession";

function createRecordingSink() {
  return { error() {} };
}

function createInMemoryFs(files: Record<string, string>): DocumentManagerFs {
  return {
    async stat(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: files[path]!.length, mode: 0o644 };
    },
    async readFile(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    async writeFile() {},
    async chmod() {},
    async rename() {},
    async unlink() {},
  };
}

function createHarness(files: Record<string, string> = {}) {
  const documents = createDocumentManager({
    log: createHostLog(),
    sink: createRecordingSink(),
    fs: createInMemoryFs(files),
  });
  return { documents };
}

describe("createEditorSessionService (Task 2.2, ui/editorSession.ts)", () => {
  test("no active document when nothing is open", () => {
    const { documents } = createHarness();
    const session = createEditorSessionService({ documents });
    expect(session.getActiveDocumentUri()).toBeUndefined();
    expect(session.getActiveDocument()).toBeUndefined();
  });

  test("opening the first document makes it active", async () => {
    const { documents } = createHarness({ "/a.ts": "hello" });
    const session = createEditorSessionService({ documents });
    let changes = 0;
    session.onDidChange(() => changes++);

    const doc = await documents.openDocument(pathToUri("/a.ts"));
    expect(session.getActiveDocumentUri()).toBe(doc.uri);
    expect(session.getActiveDocument()).toBe(doc);
    expect(changes).toBe(1);
  });

  test("opening a second document does not steal activation from the first", async () => {
    const { documents } = createHarness({ "/a.ts": "A", "/b.ts": "B" });
    const session = createEditorSessionService({ documents });
    const a = await documents.openDocument(pathToUri("/a.ts"));
    await documents.openDocument(pathToUri("/b.ts"));
    expect(session.getActiveDocumentUri()).toBe(a.uri);
  });

  test("closing the active document falls back to another open one", async () => {
    const { documents } = createHarness({ "/a.ts": "A", "/b.ts": "B" });
    const session = createEditorSessionService({ documents });
    const a = await documents.openDocument(pathToUri("/a.ts"));
    const b = await documents.openDocument(pathToUri("/b.ts"));
    expect(session.getActiveDocumentUri()).toBe(a.uri);

    documents.close(a.uri);
    expect(session.getActiveDocumentUri()).toBe(b.uri);
  });

  test("closing the last open document clears the active uri", async () => {
    const { documents } = createHarness({ "/a.ts": "A" });
    const session = createEditorSessionService({ documents });
    const a = await documents.openDocument(pathToUri("/a.ts"));
    documents.close(a.uri);
    expect(session.getActiveDocumentUri()).toBeUndefined();
    expect(session.getActiveDocument()).toBeUndefined();
  });

  test("setActiveDocumentUri switches the active tab and fires onDidChange", async () => {
    const { documents } = createHarness({ "/a.ts": "A", "/b.ts": "B" });
    const session = createEditorSessionService({ documents });
    await documents.openDocument(pathToUri("/a.ts"));
    const b = await documents.openDocument(pathToUri("/b.ts"));

    let changes = 0;
    session.onDidChange(() => changes++);
    session.setActiveDocumentUri(b.uri);
    expect(session.getActiveDocumentUri()).toBe(b.uri);
    expect(changes).toBe(1);

    // Re-setting the same uri is a no-op: fires no additional event.
    session.setActiveDocumentUri(b.uri);
    expect(changes).toBe(1);
  });

  test("getState returns a fresh initial collapsed-cursor state on first access, then the same object", async () => {
    const { documents } = createHarness({ "/a.ts": "hello" });
    const session = createEditorSessionService({ documents });
    const doc = await documents.openDocument(pathToUri("/a.ts"));

    const first = session.getState(doc.uri);
    expect(first.documentUri).toBe(doc.uri);
    expect(first.selections).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    ]);
    expect(session.getState(doc.uri)).toBe(first);
  });

  test("setState replaces the state and fires onDidChange", async () => {
    const { documents } = createHarness({ "/a.ts": "hello" });
    const session = createEditorSessionService({ documents });
    const doc = await documents.openDocument(pathToUri("/a.ts"));

    let changes = 0;
    session.onDidChange(() => changes++);
    const target = { line: 0, character: 3 };
    const next = {
      documentUri: doc.uri,
      selections: [{ start: target, end: target, anchor: target, active: target }],
      scrollTop: 0,
    };
    session.setState(doc.uri, next);
    expect(session.getState(doc.uri)).toBe(next);
    expect(changes).toBe(1);
  });

  test("closing a document forgets its EditorState", async () => {
    const { documents } = createHarness({ "/a.ts": "hello", "/b.ts": "world" });
    const session = createEditorSessionService({ documents });
    const a = await documents.openDocument(pathToUri("/a.ts"));
    await documents.openDocument(pathToUri("/b.ts"));

    const before = session.getState(a.uri);
    documents.close(a.uri);
    await documents.openDocument(pathToUri("/a.ts"));
    const after = session.getState(a.uri);
    // A fresh open gets a fresh initial state, not the one from before close.
    expect(after).not.toBe(before);
  });

  test("dispose stops firing onDidChange and unsubscribes from documents", async () => {
    const { documents } = createHarness({ "/a.ts": "A" });
    const session = createEditorSessionService({ documents });
    let changes = 0;
    session.onDidChange(() => changes++);

    session.dispose();
    await documents.openDocument(pathToUri("/a.ts"));
    expect(changes).toBe(0);
  });

  test("a listener that throws does not stop other listeners or the caller", async () => {
    const { documents } = createHarness({ "/a.ts": "A" });
    const session = createEditorSessionService({ documents });
    let secondCalled = false;
    session.onDidChange(() => {
      throw new Error("boom");
    });
    session.onDidChange(() => {
      secondCalled = true;
    });

    await documents.openDocument(pathToUri("/a.ts"));
    expect(secondCalled).toBe(true);
  });
});
