/**
 * Tests for `statusbar`'s `activate(ctx)` (Task 3.4, Req 11.6) — a minimal
 * fake `Tecode` (local to this file, `@tecode/api` types only, matching
 * this suite's "no mock libraries, local fakes" house convention — follows
 * `command-palette/index.test.ts`'s `createFakeApi` pattern) stands in for
 * the real core, so `activate` is exercised through the same public
 * surface a real extension would see.
 */

import { describe, expect, test } from "bun:test";
import type {
  Disposable,
  Document,
  DocumentChangeEvent,
  Editor,
  ExtensionContext,
  Listener,
  ResolvedTheme,
  Selection,
  StatusBarItem,
  Tecode,
} from "@tecode/api";
import { activate } from "./index";

/** A tiny real event (Set + snapshot + per-listener try/catch — house
 * convention) shared by every fake namespace below. */
function createEvent<T>(): { fire(value: T): void; on(listener: Listener<T>): Disposable } {
  const listeners = new Set<Listener<T>>();
  return {
    fire(value: T) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(value);
        } catch {
          // Isolate listener failures, matching every real onDidChange.
        }
      }
    },
    on(listener: Listener<T>): Disposable {
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
        },
      };
    },
  };
}

/** A minimal fake `Document` (Task 3.4) — just enough of `@tecode/api`'s
 * `Document` for `statusbar`'s reads: `uri`/`languageId`/`dirty`/
 * `readonly`/`eol`/`onDidChange`. */
function createFakeDocument(overrides: Partial<Document> = {}): Document & { fireChange(): void } {
  const changeEvent = createEvent<DocumentChangeEvent>();
  return {
    uri: "file:///a.ts",
    languageId: "typescript",
    version: 1,
    dirty: false,
    readonly: false,
    eol: "\n",
    applyEdits: () => {},
    transaction: (fn) => fn(),
    undo: () => undefined,
    redo: () => undefined,
    onDidChange: changeEvent.on,
    fireChange: () => changeEvent.fire(undefined as unknown as DocumentChangeEvent),
    ...overrides,
  };
}

function cursorAt(line: number, character: number): Selection {
  const pos = { line, character };
  return { start: pos, end: pos, anchor: pos, active: pos };
}

/** A minimal fake `Tecode` (this file's TSDoc) backing exactly what
 * `statusbar`'s `activate` reads/writes. */
function createFakeApi() {
  const statusBarItems = new Map<string, StatusBarItem>();
  const registerCalls: string[] = [];
  const editorChange = createEvent<void>();
  const themesChange = createEvent<void>();
  const workspaceOpen = createEvent<Document>();
  const workspaceClose = createEvent<Document>();
  const workspaceSave = createEvent<Document>();

  let activeEditor: Editor | undefined;
  let themeLabel = "Dark Modern";

  const api: Tecode = {
    commands: undefined as never,
    workspace: {
      rootUri: "file:///workspace/",
      documents: [],
      fs: undefined as never,
      onDidOpen: workspaceOpen.on,
      onDidClose: workspaceClose.on,
      onDidSave: workspaceSave.on,
      openDocument: async () => {
        throw new Error("not used by this fixture");
      },
      save: async () => {},
    },
    window: {
      get activeEditor() {
        return activeEditor;
      },
      showMessage: () => {},
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      setStatusBarItem: (item: StatusBarItem) => {
        registerCalls.push(item.id);
        statusBarItems.set(item.id, item);
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            // Only remove if this exact registration is still the current
            // one — mirrors the real SlotRegistry's own identity-checked
            // dispose (a stale dispose from a superseded registration must
            // not delete a NEWER registration under the same id).
            if (statusBarItems.get(item.id) === item) statusBarItems.delete(item.id);
          },
        };
      },
    },
    editor: {
      selections: [],
      cursor: { line: 0, character: 0 },
      revealLine: () => {},
      insertSnippet: () => {},
      applyEdits: () => {},
      getLine: () => "",
      lineCount: 0,
      setSelections: () => {},
      find: undefined as never,
      onDidChange: editorChange.on,
    },
    ui: undefined as never,
    config: undefined as never,
    context: undefined as never,
    languages: undefined as never,
    themes: {
      register: () => ({ dispose() {} }),
      current: {} as ResolvedTheme,
      get currentLabel() {
        return themeLabel;
      },
      onDidChange: themesChange.on,
    },
    clipboard: undefined as never,
  };

  return {
    api,
    statusBarItems,
    registerCalls,
    setActiveEditor(document: Document | undefined, selections: Selection[] = [cursorAt(0, 0)]) {
      activeEditor = document ? { document, selections } : undefined;
    },
    fireEditorChange: () => editorChange.fire(undefined),
    fireThemesChange: () => themesChange.fire(undefined),
    fireWorkspaceOpen: (doc: Document) => workspaceOpen.fire(doc),
    fireWorkspaceClose: (doc: Document) => workspaceClose.fire(doc),
    fireWorkspaceSave: (doc: Document) => workspaceSave.fire(doc),
    setThemeLabel: (label: string) => {
      themeLabel = label;
    },
  };
}

function activateFixture() {
  const fake = createFakeApi();
  const ctx: ExtensionContext = {
    api: fake.api,
    extensionUri: "<builtin>/tecode.statusbar",
    subscriptions: [],
    storagePath: "/tmp/fake-statusbar-storage",
  };
  activate(ctx);
  return { ...fake, ctx };
}

function text(fake: ReturnType<typeof createFakeApi>, id: string): string | undefined {
  return fake.statusBarItems.get(id)?.text.trim();
}

const LANGUAGE_ID = "tecode.statusbar.language";
const EOL_ID = "tecode.statusbar.eol";
const READONLY_ID = "tecode.statusbar.readonly";
const DIRTY_ID = "tecode.statusbar.dirty";
const CURSOR_ID = "tecode.statusbar.cursor";
const THEME_ID = "tecode.statusbar.theme";

describe("statusbar activate() — no active editor (Task 3.4, Req 11.6)", () => {
  test("only the theme item is shown; every per-document/cursor item is absent", () => {
    const fake = activateFixture();
    expect(text(fake, THEME_ID)).toBe("Dark Modern");
    expect(fake.statusBarItems.has(LANGUAGE_ID)).toBe(false);
    expect(fake.statusBarItems.has(EOL_ID)).toBe(false);
    expect(fake.statusBarItems.has(READONLY_ID)).toBe(false);
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);
    expect(fake.statusBarItems.has(CURSOR_ID)).toBe(false);
  });
});

describe("statusbar activate() — active editor (Task 3.4, Req 11.6)", () => {
  test("registers language/EOL/cursor for a clean, non-readonly document", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ languageId: "typescript", eol: "\n", dirty: false, readonly: false });
    fake.setActiveEditor(doc, [cursorAt(2, 6)]);
    fake.fireEditorChange();

    expect(text(fake, LANGUAGE_ID)).toBe("typescript");
    expect(text(fake, EOL_ID)).toBe("LF");
    expect(text(fake, CURSOR_ID)).toBe("Ln 3, Col 7");
    expect(fake.statusBarItems.has(READONLY_ID)).toBe(false);
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);
  });

  test("CRLF documents show CRLF", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ eol: "\r\n" });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(text(fake, EOL_ID)).toBe("CRLF");
  });

  test("a dirty document shows the dirty indicator", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ dirty: true });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(true);
    expect(fake.statusBarItems.has(READONLY_ID)).toBe(false);
  });

  test("a readonly document (Req 5.5, >10MB) shows the read-only indicator, never dirty", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ readonly: true, dirty: false });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(text(fake, READONLY_ID)).toBe("Read-Only");
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);
  });

  test("cursor move (editor.onDidChange) updates the cursor item without re-touching unrelated ones", () => {
    const fake = activateFixture();
    const doc = createFakeDocument();
    fake.setActiveEditor(doc, [cursorAt(0, 0)]);
    fake.fireEditorChange();
    expect(text(fake, CURSOR_ID)).toBe("Ln 1, Col 1");

    fake.setActiveEditor(doc, [cursorAt(9, 3)]);
    fake.fireEditorChange();
    expect(text(fake, CURSOR_ID)).toBe("Ln 10, Col 4");
  });

  test("switching the active document re-subscribes to the NEW document's onDidChange (dirty toggling on the new doc updates the bar)", () => {
    const fake = activateFixture();
    const docA = createFakeDocument({ uri: "file:///a.ts", languageId: "typescript", dirty: false });
    const docB = createFakeDocument({ uri: "file:///b.py", languageId: "python", dirty: false });

    fake.setActiveEditor(docA);
    fake.fireEditorChange();
    expect(text(fake, LANGUAGE_ID)).toBe("typescript");

    fake.setActiveEditor(docB);
    fake.fireEditorChange();
    expect(text(fake, LANGUAGE_ID)).toBe("python");

    // A plain text edit on the NEWLY active document (docB) — no
    // editor.onDidChange fires, only docB's own onDidChange — must still
    // redraw (dirty flips true).
    (docB as unknown as { dirty: boolean }).dirty = true;
    docB.fireChange();
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(true);

    // The OLD document (docA)'s onDidChange must no longer be listened to
    // — flipping its dirty flag and firing must not resurrect anything
    // (it's not even the active document any more).
    (docA as unknown as { dirty: boolean }).dirty = true;
    docA.fireChange();
    // Still reflects docB, unaffected by docA's own (irrelevant) change.
    expect(text(fake, LANGUAGE_ID)).toBe("python");
  });

  test("a plain text edit (document.onDidChange, no cursor move) updates the dirty indicator", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ dirty: false });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);

    (doc as unknown as { dirty: boolean }).dirty = true;
    doc.fireChange();
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(true);
  });

  test("theme changes update the theme item without needing an active editor", () => {
    const fake = activateFixture();
    expect(text(fake, THEME_ID)).toBe("Dark Modern");
    fake.setThemeLabel("Light Modern");
    fake.fireThemesChange();
    expect(text(fake, THEME_ID)).toBe("Light Modern");
  });

  test("workspace.onDidOpen/onDidClose/onDidSave each trigger a redraw", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ dirty: true });
    fake.setActiveEditor(doc);
    fake.fireWorkspaceOpen(doc);
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(true);

    (doc as unknown as { dirty: boolean }).dirty = false;
    fake.fireWorkspaceSave(doc);
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);

    fake.setActiveEditor(undefined);
    fake.fireWorkspaceClose(doc);
    expect(fake.statusBarItems.has(LANGUAGE_ID)).toBe(false);
  });

  test("going from an active editor back to none removes every per-document/cursor item", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ dirty: true, readonly: false });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(fake.statusBarItems.has(LANGUAGE_ID)).toBe(true);

    fake.setActiveEditor(undefined);
    fake.fireEditorChange();
    expect(fake.statusBarItems.has(LANGUAGE_ID)).toBe(false);
    expect(fake.statusBarItems.has(EOL_ID)).toBe(false);
    expect(fake.statusBarItems.has(DIRTY_ID)).toBe(false);
    expect(fake.statusBarItems.has(CURSOR_ID)).toBe(false);
    // Theme item is global — stays.
    expect(fake.statusBarItems.has(THEME_ID)).toBe(true);
  });

  test("update mechanics: re-rendering the same item disposes the previous registration before registering the new one (no duplicate registrations)", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ languageId: "typescript" });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    const firstCallCount = fake.registerCalls.filter((id) => id === LANGUAGE_ID).length;

    (doc as unknown as { languageId: string }).languageId = "javascript";
    doc.fireChange();

    expect(fake.registerCalls.filter((id) => id === LANGUAGE_ID).length).toBe(firstCallCount + 1);
    // Only one entry lives in the registry at a time — the old one was
    // disposed, not left stacked alongside the new one.
    expect(text(fake, LANGUAGE_ID)).toBe("javascript");
  });

  test("disposing every ctx.subscription removes all registered items", () => {
    const fake = activateFixture();
    const doc = createFakeDocument({ dirty: true });
    fake.setActiveEditor(doc);
    fake.fireEditorChange();
    expect(fake.statusBarItems.size).toBeGreaterThan(0);

    for (let i = fake.ctx.subscriptions.length - 1; i >= 0; i--) {
      fake.ctx.subscriptions[i]?.dispose();
    }
    expect(fake.statusBarItems.size).toBe(0);
  });
});
