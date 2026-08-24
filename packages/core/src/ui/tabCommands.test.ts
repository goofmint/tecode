/**
 * Tests for {@link createTabCommandHandlers}/{@link createCloseDocumentWithPrompt}/
 * {@link registerTabCommands} (Task 3.5, Req 6.5) — exercised against the
 * REAL `DocumentManager` (a real temp directory, matching
 * `documentManager.test.ts`'s own harness style) and the REAL
 * `EditorSessionService` (`editorSession.ts`), so "next/previous cycle
 * document order", "close prompts and saves for real", and "switching a
 * tab preserves its EditorState" are proven end to end against the actual
 * collaborators, not a hand-rolled stand-in for them. `showQuickPick`
 * itself is the one hand-rolled fake (per house convention — no mock
 * libraries): a small scripted queue of responses, exactly like
 * `themeSelectCommand.test.ts`'s own `showQuickPick: async () => ...`
 * stand-ins.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod as fsChmod, readFile, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickPickItem } from "@tecode/api";
import { createHostLog } from "../host/errors";
import { createDocumentManager, type DocumentManagerFs } from "../buffer/documentManager";
import { pathToUri } from "../buffer/uri";
import { createEditorSessionService } from "./editorSession";
import {
  createCloseDocumentWithPrompt,
  createTabCommandHandlers,
  registerTabCommands,
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
} from "./tabCommands";

function createRecordingSink() {
  return { error() {} };
}

/** A small scripted `showQuickPick` (this module's TSDoc): each call
 * consumes the next queued response, in order; `calls` records every
 * `items` array passed in, so a test can assert how many prompts actually
 * happened (e.g. "closeOthers stopped after the first cancel"). */
function createScriptedQuickPick(responses: ReadonlyArray<QuickPickItem | undefined>) {
  const calls: QuickPickItem[][] = [];
  let index = 0;
  return {
    calls,
    showQuickPick: async (items: QuickPickItem[]): Promise<QuickPickItem | undefined> => {
      calls.push(items);
      const response = responses[index];
      index += 1;
      return response;
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-tab-commands-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Builds a real `DocumentManager` + `EditorSessionService` pair (this
 * module's TSDoc). `onLanguageActivation` is threaded through so the
 * "reopen never re-fires onLanguage" test can count real activations. */
function buildHarness(onLanguageActivation?: (id: string) => void) {
  const log = createHostLog();
  const sink = createRecordingSink();
  const documents = createDocumentManager({ log, sink, onLanguageActivation });
  const editorSession = createEditorSessionService({ documents });
  return { log, sink, documents, editorSession };
}

/** Opens `uri` and makes it the active tab — the same two-step sequence
 * `openFileCommand.ts`'s real handler performs (`documents.openDocument`
 * then `editorSession.setActiveDocumentUri`), since plain `openDocument`
 * alone never changes what's active (`editorSession.ts`'s documented
 * policy: opening a new document does not, by itself, refocus it). */
async function openAndFocus(
  documents: ReturnType<typeof createDocumentManager>,
  editorSession: ReturnType<typeof createEditorSessionService>,
  uri: string,
): Promise<void> {
  await documents.openDocument(uri);
  editorSession.setActiveDocumentUri(uri);
}

async function writeFixture(name: string, text = "content"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return pathToUri(path);
}

describe("tab.next / tab.previous (Req 6.5: documents.documents order is tab order, wraps both ends)", () => {
  test("next cycles forward through document order and wraps from the last back to the first", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    const b = await writeFixture("b.txt");
    const c = await writeFixture("c.txt");
    await openAndFocus(documents, editorSession, a);
    await openAndFocus(documents, editorSession, b);
    await openAndFocus(documents, editorSession, c);
    // Active is c (last focused) — documents.documents order is a, b, c.
    editorSession.setActiveDocumentUri(a);

    const { next } = createTabCommandHandlers({
      documents,
      editorSession,
      showQuickPick: async () => undefined,
    });

    await next();
    expect(editorSession.getActiveDocumentUri()).toBe(b);
    await next();
    expect(editorSession.getActiveDocumentUri()).toBe(c);
    await next(); // wraps past the end back to the first.
    expect(editorSession.getActiveDocumentUri()).toBe(a);
  });

  test("previous cycles backward and wraps from the first back to the last", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    const b = await writeFixture("b.txt");
    const c = await writeFixture("c.txt");
    await openAndFocus(documents, editorSession, a);
    await openAndFocus(documents, editorSession, b);
    await openAndFocus(documents, editorSession, c);
    editorSession.setActiveDocumentUri(a);

    const { previous } = createTabCommandHandlers({
      documents,
      editorSession,
      showQuickPick: async () => undefined,
    });

    await previous(); // wraps before the start back to the last.
    expect(editorSession.getActiveDocumentUri()).toBe(c);
    await previous();
    expect(editorSession.getActiveDocumentUri()).toBe(b);
    await previous();
    expect(editorSession.getActiveDocumentUri()).toBe(a);
  });

  test("no-ops with 1 or 0 documents open", async () => {
    const { documents, editorSession } = buildHarness();
    const { next, previous } = createTabCommandHandlers({
      documents,
      editorSession,
      showQuickPick: async () => undefined,
    });

    // Zero documents open.
    await next();
    await previous();
    expect(editorSession.getActiveDocumentUri()).toBeUndefined();

    // Exactly one document open.
    const a = await writeFixture("a.txt");
    await openAndFocus(documents, editorSession, a);
    await next();
    expect(editorSession.getActiveDocumentUri()).toBe(a);
    await previous();
    expect(editorSession.getActiveDocumentUri()).toBe(a);
  });
});

describe("closeDocumentWithPrompt / tab.close (Req 6.5, design.md §14's never-lose-unsaved-data)", () => {
  test("closing a not-dirty document closes it directly, with no prompt", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    await openAndFocus(documents, editorSession, a);

    const { calls, showQuickPick } = createScriptedQuickPick([]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });

    await close();

    expect(documents.documents).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("closing an unknown/not-open uri is a safe no-op", async () => {
    const { documents } = buildHarness();
    const closeWithPrompt = createCloseDocumentWithPrompt({
      documents,
      showQuickPick: async () => undefined,
    });

    const outcome = await closeWithPrompt(pathToUri(join(dir, "missing.txt")));
    expect(outcome).toBe(true);
    expect(documents.documents).toHaveLength(0);
  });

  test("dirty + Save: saves to disk, then closes", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt", "original");
    const doc = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);
    expect(doc.dirty).toBe(true);

    const saved: string[] = [];
    documents.onDidSave((d) => saved.push(d.uri));
    const closed: string[] = [];
    documents.onDidClose((d) => closed.push(d.uri));

    const { showQuickPick } = createScriptedQuickPick([{ label: "Save" }]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });

    await close();

    expect(saved).toEqual([a]);
    expect(closed).toEqual([a]);
    expect(documents.documents).toHaveLength(0);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("modified");
  });

  test("dirty + Discard: closes without writing to disk", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt", "original");
    const doc = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);

    const saved: string[] = [];
    documents.onDidSave((d) => saved.push(d.uri));

    const { showQuickPick } = createScriptedQuickPick([{ label: "Discard" }]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });

    await close();

    expect(saved).toHaveLength(0);
    expect(documents.documents).toHaveLength(0);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("original");
  });

  test("dirty + Cancel: no side effects at all — document stays open and dirty, no onDidClose", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt", "original");
    const doc = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);

    const closed: string[] = [];
    documents.onDidClose((d) => closed.push(d.uri));

    const { showQuickPick } = createScriptedQuickPick([{ label: "Cancel" }]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });

    await close();

    expect(closed).toHaveLength(0);
    expect(documents.documents).toHaveLength(1);
    expect(doc.dirty).toBe(true);
    expect(editorSession.getActiveDocumentUri()).toBe(a);
  });

  test("dirty + Escape (showQuickPick resolves undefined): same as Cancel — no side effects", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt", "original");
    const doc = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);

    const { showQuickPick } = createScriptedQuickPick([undefined]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });

    await close();

    expect(documents.documents).toHaveLength(1);
    expect(doc.dirty).toBe(true);
  });

  test("dirty + showQuickPick throws: treated exactly like Cancel — nothing closes, the failure is logged", async () => {
    const { documents, editorSession, log } = buildHarness();
    const a = await writeFixture("a.txt", "original");
    const doc = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);

    const closed: string[] = [];
    documents.onDidClose((d) => closed.push(d.uri));

    const { close } = createTabCommandHandlers({
      documents,
      editorSession,
      showQuickPick: async () => {
        throw new Error("quick pick exploded");
      },
      log,
    });

    await close();

    expect(closed).toHaveLength(0);
    expect(documents.documents).toHaveLength(1);
    expect(doc.dirty).toBe(true);
    expect(
      log.entries().some((e) => e.level === "error" && e.error.message.includes(TAB_CLOSE_COMMAND)),
    ).toBe(true);
  });

  test("a save that reports failure aborts the close — the document stays open, still dirty, unsaved data preserved", async () => {
    const log = createHostLog();
    const sink = createRecordingSink();
    const path = join(dir, "willfail.txt");
    await writeFile(path, "original", "utf8");
    const failingFs: DocumentManagerFs = {
      stat: (p) => fsStat(p),
      readFile: (p, enc) => readFile(p, enc),
      writeFile: (p, data, opts) => fsWriteFile(p, data, opts),
      chmod: (p, mode) => fsChmod(p, mode),
      rename: async () => {
        throw new Error("simulated rename failure");
      },
      unlink: (p) => fsUnlink(p),
    };
    const documents = createDocumentManager({ log, sink, fs: failingFs });
    const editorSession = createEditorSessionService({ documents });
    const uri = pathToUri(path);
    const doc = await documents.openDocument(uri);
    editorSession.setActiveDocumentUri(uri);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "modified" },
    ]);

    const closed: string[] = [];
    documents.onDidClose((d) => closed.push(d.uri));

    const { showQuickPick } = createScriptedQuickPick([{ label: "Save" }]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick, log });

    await close();

    expect(closed).toHaveLength(0);
    expect(documents.documents).toHaveLength(1);
    expect(doc.dirty).toBe(true);
    // Assert THIS module's own entry, not just "some error was logged": the
    // same `log` is shared with `DocumentManager` (which reports the write
    // failure itself), so a bare level check could pass on its entry alone.
    expect(log.entries().some((e) => e.error.message.includes(`${TAB_CLOSE_COMMAND}: save`))).toBe(true);
  });

  test("closing the active tab lets editorSession pick the next active uri on its own", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    const b = await writeFixture("b.txt");
    const c = await writeFixture("c.txt");
    await openAndFocus(documents, editorSession, a);
    await openAndFocus(documents, editorSession, b);
    await openAndFocus(documents, editorSession, c);
    expect(editorSession.getActiveDocumentUri()).toBe(c);

    const { showQuickPick } = createScriptedQuickPick([]);
    const { close } = createTabCommandHandlers({ documents, editorSession, showQuickPick });
    await close(); // closes c, the active tab — never calls setActiveDocumentUri itself.

    // EditorSessionService's own onDidClose-driven recalculation picks the
    // new active uri (editorSession.ts's syncActiveDocument): falls back
    // to the first still-open document.
    expect(editorSession.getActiveDocumentUri()).toBe(a);
  });
});

describe("tab.closeOthers (Req 6.5)", () => {
  test("closes every non-active tab, in document order, when nothing is dirty", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    const b = await writeFixture("b.txt");
    const c = await writeFixture("c.txt");
    await openAndFocus(documents, editorSession, a);
    await openAndFocus(documents, editorSession, b);
    await openAndFocus(documents, editorSession, c);
    editorSession.setActiveDocumentUri(b);

    const { showQuickPick } = createScriptedQuickPick([]);
    const { closeOthers } = createTabCommandHandlers({ documents, editorSession, showQuickPick });
    await closeOthers();

    expect(documents.documents.map((d) => d.uri)).toEqual([b]);
    expect(editorSession.getActiveDocumentUri()).toBe(b);
  });

  test("a Cancel on the first other tab aborts the whole sequence — later tabs are left untouched", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt", "original-a");
    const b = await writeFixture("b.txt");
    const c = await writeFixture("c.txt", "original-c");
    const docA = await documents.openDocument(a);
    editorSession.setActiveDocumentUri(a);
    await documents.openDocument(b);
    editorSession.setActiveDocumentUri(b);
    const docC = await documents.openDocument(c);
    editorSession.setActiveDocumentUri(c);
    editorSession.setActiveDocumentUri(b); // b is active; a and c are "others", in that order.

    docA.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }]);
    docC.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }]);

    const { calls, showQuickPick } = createScriptedQuickPick([{ label: "Cancel" }]);
    const { closeOthers } = createTabCommandHandlers({ documents, editorSession, showQuickPick });
    await closeOthers();

    // Only ONE prompt happened (for `a`, the first "other" in document
    // order) — cancelling it aborted before `c` was ever asked about.
    expect(calls).toHaveLength(1);
    expect(documents.documents.map((d) => d.uri)).toEqual([a, b, c]);
    expect(docA.dirty).toBe(true);
    expect(docC.dirty).toBe(true);
  });
});

describe("Switching tabs preserves and restores per-tab selections and scroll position (real EditorSessionService)", () => {
  test("a tab's EditorState round-trips through selections and scrollTop across a next/next cycle", async () => {
    const { documents, editorSession } = buildHarness();
    const a = await writeFixture("a.txt");
    const b = await writeFixture("b.txt");
    await openAndFocus(documents, editorSession, a);
    await openAndFocus(documents, editorSession, b);
    editorSession.setActiveDocumentUri(a);

    const posA = { line: 3, character: 5 };
    editorSession.setState(a, {
      documentUri: a,
      selections: [{ start: posA, end: posA, anchor: posA, active: posA }],
      scrollTop: 42,
    });
    const posB = { line: 1, character: 2 };
    editorSession.setState(b, {
      documentUri: b,
      selections: [{ start: posB, end: posB, anchor: posB, active: posB }],
      scrollTop: 7,
    });

    const { next } = createTabCommandHandlers({
      documents,
      editorSession,
      showQuickPick: async () => undefined,
    });

    await next(); // a -> b
    expect(editorSession.getActiveDocumentUri()).toBe(b);
    expect(editorSession.getState(b).scrollTop).toBe(7);
    expect(editorSession.getState(b).selections[0]!.active).toEqual(posB);

    await next(); // b -> a (wraps, only 2 documents)
    expect(editorSession.getActiveDocumentUri()).toBe(a);
    expect(editorSession.getState(a).scrollTop).toBe(42);
    expect(editorSession.getState(a).selections[0]!.active).toEqual(posA);
  });
});

describe("Re-opening an already-open file focuses the existing tab, no duplicate, onLanguage fires once", () => {
  test("reopening the same uri reuses the tab and does not re-fire onLanguage activation", async () => {
    const activations: string[] = [];
    const { documents, editorSession } = buildHarness((id) => activations.push(id));
    const a = await writeFixture("a.txt");

    await openAndFocus(documents, editorSession, a);
    expect(documents.documents).toHaveLength(1);
    expect(activations).toEqual(["plaintext"]);

    const b = await writeFixture("b.txt");
    await openAndFocus(documents, editorSession, b);
    expect(editorSession.getActiveDocumentUri()).toBe(b);

    // "Reopen" a — the same sequence `workbench.action.files.openUri`
    // (`openFileCommand.ts`) performs.
    await openAndFocus(documents, editorSession, a);

    expect(documents.documents).toHaveLength(2); // no duplicate.
    expect(editorSession.getActiveDocumentUri()).toBe(a); // focuses the existing tab.
    expect(activations).toEqual(["plaintext", "plaintext"]); // once per NEW document, not per reopen.
  });
});

describe("registerTabCommands (Task 3.5)", () => {
  test("registers all 4 commands with title/category, and dispose() is idempotent", async () => {
    const registered: Array<{ id: string; meta?: { title?: string; category?: string } }> = [];
    const fakeRegistry = {
      register(id: string, _handler: unknown, meta?: { title?: string; category?: string }) {
        registered.push({ id, meta });
        let disposed = false;
        return {
          dispose() {
            disposed = true;
          },
          get disposed() {
            return disposed;
          },
        };
      },
    };
    const { documents, editorSession } = buildHarness();

    const disposable = registerTabCommands(fakeRegistry, {
      documents,
      editorSession,
      showQuickPick: async () => undefined,
    });

    const ids = registered.map((r) => r.id).sort();
    expect(ids).toEqual(
      [TAB_NEXT_COMMAND, TAB_PREVIOUS_COMMAND, TAB_CLOSE_COMMAND, TAB_CLOSE_OTHERS_COMMAND].sort(),
    );
    for (const entry of registered) {
      expect(entry.meta?.title).toBeTruthy();
      expect(entry.meta?.category).toBe("View");
    }

    // dispose() twice must not throw and must be a genuine no-op the
    // second time (every Disposable in this codebase is idempotent).
    disposable.dispose();
    disposable.dispose();
  });
});
