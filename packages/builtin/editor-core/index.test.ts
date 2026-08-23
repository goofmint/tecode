/**
 * Integration-ish tests for `editor-core`'s `activate(ctx)` (Req 11.1) — a
 * minimal fake `Tecode` (local to this file, `@tecode/api` types only,
 * matching this suite's "no mock libraries, local fakes" house convention)
 * stands in for the real core, so `activate` is exercised through the same
 * public surface a real extension would see, without depending on
 * `@tecode/core` (the ESLint layering rule this whole package exists to
 * respect).
 */

import { describe, expect, test } from "bun:test";
import type {
  CommandHandler,
  ConfigChangeEvent,
  Disposable,
  Document,
  Editor,
  ExtensionContext,
  Selection,
  Tecode,
  TextEdit,
} from "@tecode/api";
import { activate } from "./index";

function pos(line: number, character: number) {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  const p = pos(line, character);
  return { start: p, end: p, anchor: p, active: p };
}

/** A minimal fake `Tecode`, backing exactly what `editor-core`'s
 * `activate` reads/writes: `commands`, `config`, `editor`, `window`,
 * `workspace.save`. Everything else on the interface is left `undefined`/
 * throwing, since `activate` never touches it. */
function createFakeApi(initialLines: string[]) {
  const lines = [...initialLines];
  let selections: Selection[] = [cursorAt(0, 0)];
  const appliedEdits: TextEdit[][] = [];
  const commandHandlers = new Map<string, CommandHandler>();
  const configValues = new Map<string, unknown>([
    ["editor.tabSize", 4],
    ["editor.insertSpaces", true],
  ]);
  const configListeners = new Set<(e: ConfigChangeEvent) => void>();
  const savedUris: string[] = [];

  function applyEditsToLines(edits: TextEdit[]): void {
    // Apply in reverse document order so earlier edits' ranges stay valid
    // (mirrors how a real LineBuffer applies a validated, non-overlapping
    // batch — this fake only needs to be correct for the batches
    // `editing.ts` actually produces).
    const sorted = [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
    for (const edit of sorted) {
      const { start, end } = edit.range;
      const before = lines[start.line]!.slice(0, start.character);
      const after = lines[end.line]!.slice(end.character);
      const replacementLines = edit.newText.split("\n");
      const newLines = [before + replacementLines[0], ...replacementLines.slice(1)];
      newLines[newLines.length - 1] += after;
      lines.splice(start.line, end.line - start.line + 1, ...newLines);
    }
  }

  const document: Document = {
    uri: "file:///fake.txt",
    languageId: "plaintext",
    version: 0,
    dirty: false,
    readonly: false,
    eol: "\n",
    applyEdits(edits: TextEdit[]) {
      appliedEdits.push(edits);
      applyEditsToLines(edits);
    },
    transaction(fn: () => void) {
      fn();
    },
    onDidChange: () => ({ dispose() {} }),
  };

  const editor: Editor = { document, selections };

  const api = {
    commands: {
      register(id: string, handler: CommandHandler): Disposable {
        commandHandlers.set(id, handler);
        return { dispose: () => commandHandlers.delete(id) };
      },
      execute: async (id: string, ...args: unknown[]) => commandHandlers.get(id)?.(...args),
      list: () => [],
    },
    workspace: {
      rootUri: undefined,
      openDocument: async () => document,
      documents: [document],
      fs: undefined as never,
      onDidOpen: () => ({ dispose() {} }),
      onDidClose: () => ({ dispose() {} }),
      onDidSave: () => ({ dispose() {} }),
      save: async (uri: string) => {
        savedUris.push(uri);
      },
    },
    window: {
      get activeEditor() {
        return editor;
      },
      showMessage: () => {},
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      setStatusBarItem: () => ({ dispose() {} }),
    },
    editor: {
      get selections() {
        return selections;
      },
      get cursor() {
        return selections[0]!.active;
      },
      revealLine: () => {},
      insertSnippet: () => {},
      applyEdits: (edits: TextEdit[]) => document.applyEdits(edits),
      getLine: (n: number) => lines[n] ?? "",
      get lineCount() {
        return lines.length;
      },
      setSelections: (next: readonly Selection[]) => {
        if (next.length === 0) return;
        selections = [...next];
      },
    },
    ui: undefined as never,
    config: {
      get: <T>(key: string) => configValues.get(key) as T | undefined,
      onDidChange: (listener: (e: ConfigChangeEvent) => void) => {
        configListeners.add(listener);
        return { dispose: () => configListeners.delete(listener) };
      },
    },
    context: undefined as never,
    languages: undefined as never,
    themes: undefined as never,
  } as unknown as Tecode;

  function setConfig(key: string, value: unknown): void {
    configValues.set(key, value);
    const event: ConfigChangeEvent = { affectsConfiguration: (k) => k === key };
    for (const listener of configListeners) listener(event);
  }

  return { api, lines, appliedEdits, savedUris, setConfig, getSelections: () => selections };
}

function activateFixture(initialLines: string[]) {
  const fake = createFakeApi(initialLines);
  const ctx: ExtensionContext = {
    api: fake.api,
    extensionUri: "file:///fake-ext",
    subscriptions: [],
    storagePath: "/tmp/fake-ext-storage",
  };
  activate(ctx);
  return { ...fake, ctx };
}

describe("editor-core activate() — movement commands (Req 6.6, 11.1)", () => {
  test("cursorRight moves the caret", async () => {
    const { api, getSelections } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.cursorRight");
    expect(getSelections()).toEqual([cursorAt(0, 1)]);
  });

  test("cursorRightSelect extends the selection", async () => {
    const { api, getSelections } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.cursorRightSelect");
    expect(getSelections()).toEqual([
      { start: pos(0, 0), end: pos(0, 1), anchor: pos(0, 0), active: pos(0, 1) },
    ]);
  });

  test("cursorEnd then cursorHome round-trips", async () => {
    const { api, getSelections } = activateFixture(["  abc"]);
    await api.commands.execute("editor.action.cursorEnd");
    expect(getSelections()).toEqual([cursorAt(0, 5)]);
    await api.commands.execute("editor.action.cursorHome");
    expect(getSelections()).toEqual([cursorAt(0, 2)]); // smart home -> first non-blank
  });
});

describe("editor-core activate() — editing commands (Req 11.1)", () => {
  test("tab inserts spaces via document.applyEdits inside a transaction", async () => {
    const { api, lines, appliedEdits, getSelections } = activateFixture([""]);
    await api.commands.execute("editor.action.tab");
    expect(lines[0]).toBe("    ");
    expect(appliedEdits).toHaveLength(1);
    expect(getSelections()).toEqual([cursorAt(0, 4)]);
  });

  test("insertNewLine auto-indents from the current line", async () => {
    const { api, lines, getSelections } = activateFixture(["  if (x) {"]);
    await api.commands.execute("editor.action.cursorEnd");
    await api.commands.execute("editor.action.insertNewLine");
    expect(lines).toEqual(["  if (x) {", "  "]);
    expect(getSelections()).toEqual([cursorAt(1, 2)]);
  });

  test("outdent removes one indentation unit from the current line", async () => {
    const { api, lines } = activateFixture(["        abc"]);
    await api.commands.execute("editor.action.outdent");
    expect(lines[0]).toBe("    abc");
  });

  test("a no-op edit (outdent with no indentation) does not call applyEdits", async () => {
    const { api, appliedEdits } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.outdent");
    expect(appliedEdits).toHaveLength(0);
  });

  test("tab respects a live editor.tabSize change (Req 9.4)", async () => {
    const { api, lines, setConfig } = activateFixture([""]);
    setConfig("editor.tabSize", 2);
    await api.commands.execute("editor.action.tab");
    expect(lines[0]).toBe("  ");
  });

  test("tab respects a live editor.insertSpaces change (Req 9.4)", async () => {
    const { api, lines, setConfig } = activateFixture([""]);
    setConfig("editor.insertSpaces", false);
    await api.commands.execute("editor.action.tab");
    expect(lines[0]).toBe("\t");
  });

  test("deleteLeft/deleteRight are registered commands, usable without a keybinding", async () => {
    const { api, lines } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.cursorEnd");
    await api.commands.execute("editor.action.deleteLeft");
    expect(lines[0]).toBe("ab");
    await api.commands.execute("editor.action.cursorHome");
    await api.commands.execute("editor.action.deleteRight");
    expect(lines[0]).toBe("b");
  });
});

describe("editor-core activate() — save (Req 11.1)", () => {
  test("save calls workspace.save with the active document's uri", async () => {
    const { api, savedUris } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.save");
    expect(savedUris).toEqual(["file:///fake.txt"]);
  });
});
