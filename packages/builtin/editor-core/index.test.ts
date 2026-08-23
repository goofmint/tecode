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
  LanguageContribution,
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
  const languageContributions = new Map<string, LanguageContribution>();

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

  // A minimal snapshot-based undo/redo stack (Task 2.4) — real enough to
  // exercise `editor.action.undo`/`redo`'s contract (restore buffer content,
  // one entry per `applyEdits`/`transaction` call) without reimplementing
  // `@tecode/core`'s real inverse-edit `UndoStack`. Selections are never
  // recorded here — matching production reality: `editor-core` only ever
  // reaches the real undo stack through the PUBLIC `Document.applyEdits`
  // (no `selectionsBefore`/`selectionsAfter` opts on that signature), so its
  // own commands' undo entries always carry empty selection arrays too
  // (`index.ts`'s TSDoc on `editor.action.undo`/`redo`).
  const undoStack: string[][] = [];
  const redoStack: string[][] = [];
  let transactionDepth = 0;
  let transactionSnapshot: string[] | undefined;

  function snapshot(): string[] {
    return [...lines];
  }

  function pushUndo(before: string[]): void {
    undoStack.push(before);
    redoStack.length = 0;
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
      if (transactionDepth > 0) {
        applyEditsToLines(edits);
        return;
      }
      const before = snapshot();
      applyEditsToLines(edits);
      pushUndo(before);
    },
    transaction(fn: () => void) {
      const isOutermost = transactionDepth === 0;
      if (isOutermost) transactionSnapshot = snapshot();
      transactionDepth++;
      try {
        fn();
      } finally {
        transactionDepth--;
        if (transactionDepth === 0) {
          pushUndo(transactionSnapshot!);
          transactionSnapshot = undefined;
        }
      }
    },
    undo(): Selection[] | undefined {
      const before = undoStack.pop();
      if (before === undefined) return undefined;
      redoStack.push(snapshot());
      lines.splice(0, lines.length, ...before);
      return [];
    },
    redo(): Selection[] | undefined {
      const after = redoStack.pop();
      if (after === undefined) return undefined;
      undoStack.push(snapshot());
      lines.splice(0, lines.length, ...after);
      return [];
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
    languages: {
      register(contribution: LanguageContribution): Disposable {
        languageContributions.set(contribution.id, contribution);
        return { dispose: () => languageContributions.delete(contribution.id) };
      },
      getLanguageId: () => "plaintext",
      getLanguage: (id: string) => languageContributions.get(id),
    },
    themes: undefined as never,
  } as unknown as Tecode;

  function setConfig(key: string, value: unknown): void {
    configValues.set(key, value);
    const event: ConfigChangeEvent = { affectsConfiguration: (k) => k === key };
    for (const listener of configListeners) listener(event);
  }

  return {
    api,
    lines,
    appliedEdits,
    savedUris,
    setConfig,
    getSelections: () => selections,
    languageContributions,
  };
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

describe("editor-core activate() — line operations (Req 11.1, Task 2.4)", () => {
  test("duplicateLine is correct with two cursors on distinct lines — one undo step", async () => {
    const { api, lines, appliedEdits, getSelections } = activateFixture(["aaa", "bbb", "ccc"]);
    api.editor.setSelections([cursorAt(0, 1), cursorAt(2, 2)]);
    await api.commands.execute("editor.action.duplicateLine");

    expect(lines).toEqual(["aaa", "aaa", "bbb", "ccc", "ccc"]);
    expect(appliedEdits).toHaveLength(1);
    // Each cursor lands on its own duplicate: line 0's copy is now at line
    // 1 (shifted by its own group's size); line 2's copy is now at line 4
    // (shifted by group 0's size (1, above it) plus its own group's size).
    expect(getSelections()).toEqual([cursorAt(1, 1), cursorAt(4, 2)]);

    await api.commands.execute("editor.action.undo");
    expect(lines).toEqual(["aaa", "bbb", "ccc"]);
  });

  test("moveLinesUp/moveLinesDown move a single line, no-op at the buffer boundary", async () => {
    const { api, lines } = activateFixture(["aaa", "bbb", "ccc"]);
    await api.commands.execute("editor.action.cursorDown"); // -> line 1
    await api.commands.execute("editor.action.moveLinesUp");
    expect(lines).toEqual(["bbb", "aaa", "ccc"]);

    const { api: api2, lines: lines2, appliedEdits: edits2 } = activateFixture(["aaa"]);
    await api2.commands.execute("editor.action.moveLinesUp"); // already at top
    expect(lines2).toEqual(["aaa"]);
    expect(edits2).toHaveLength(0);

    const { api: api3, lines: lines3 } = activateFixture(["aaa", "bbb"]);
    await api3.commands.execute("editor.action.moveLinesDown");
    expect(lines3).toEqual(["bbb", "aaa"]);
  });

  test("deleteLine handles the trailing-newline edge on the last line", async () => {
    const { api, lines, getSelections } = activateFixture(["aaa", "bbb", "ccc"]);
    await api.commands.execute("editor.action.cursorBottom"); // -> last line
    await api.commands.execute("editor.action.deleteLine");
    expect(lines).toEqual(["aaa", "bbb"]);
    expect(getSelections()).toEqual([cursorAt(1, 0)]);
  });

  test("deleteLine on the only line leaves a single empty line", async () => {
    const { api, lines } = activateFixture(["only"]);
    await api.commands.execute("editor.action.deleteLine");
    expect(lines).toEqual([""]);
  });

  test("deleteLine is correct with two cursors on distinct lines", async () => {
    const { api, lines, getSelections } = activateFixture(["aaa", "bbb", "ccc", "ddd"]);
    api.editor.setSelections([cursorAt(0, 0), cursorAt(2, 0)]);
    await api.commands.execute("editor.action.deleteLine");
    expect(lines).toEqual(["bbb", "ddd"]);
    expect(getSelections()).toEqual([cursorAt(0, 0), cursorAt(1, 0)]);
  });
});

describe("editor-core activate() — toggleLineComment (Req 11.1, Task 2.4)", () => {
  test("comments, then uncomments, then round-trips to the original", async () => {
    const { api, lines } = activateFixture(["const a = 1;", "const b = 2;"]);
    api.editor.setSelections([
      { start: pos(0, 0), end: pos(1, 5), anchor: pos(0, 0), active: pos(1, 5) },
    ]);

    await api.commands.execute("editor.action.toggleLineComment");
    expect(lines).toEqual(["// const a = 1;", "// const b = 2;"]);

    await api.commands.execute("editor.action.toggleLineComment");
    expect(lines).toEqual(["const a = 1;", "const b = 2;"]);
  });

  test("is a no-op with no registered language declaration", async () => {
    const { api, lines, languageContributions, appliedEdits } = activateFixture(["const a = 1;"]);
    languageContributions.delete("plaintext");

    await api.commands.execute("editor.action.toggleLineComment");
    expect(lines).toEqual(["const a = 1;"]);
    expect(appliedEdits).toHaveLength(0);
  });
});

describe("editor-core activate() — undo/redo commands (Req 11.1, Task 2.4)", () => {
  test("undo restores the buffer; redo re-applies the change", async () => {
    const { api, lines } = activateFixture([""]);
    await api.commands.execute("editor.action.tab");
    expect(lines[0]).toBe("    ");

    await api.commands.execute("editor.action.undo");
    expect(lines[0]).toBe("");

    await api.commands.execute("editor.action.redo");
    expect(lines[0]).toBe("    ");
  });

  test("undo with nothing to undo is a harmless no-op", async () => {
    const { api, lines } = activateFixture(["abc"]);
    await api.commands.execute("editor.action.undo");
    expect(lines).toEqual(["abc"]);
  });

  // `@tecode/api`'s `Document.undo`/`redo` TSDoc: entries `editor-core`
  // itself produces (via the public single-arg `applyEdits`, exactly what
  // this fixture's fake `document.undo`/`redo` mirrors by returning `[]`)
  // carry no selection snapshot. The handler must leave the caret exactly
  // where the USER put it — not snap it to wherever the edit happened to
  // land — for both `undo` and `redo`.
  test("undo/redo leave the caret untouched when the undone/redone entry has no selection snapshot", async () => {
    const { api, getSelections } = activateFixture([""]);
    api.editor.setSelections([cursorAt(0, 0)]);

    await api.commands.execute("editor.action.tab");
    api.editor.setSelections([cursorAt(0, 2)]); // user moved the caret after typing
    await api.commands.execute("editor.action.undo");
    expect(getSelections()).toEqual([cursorAt(0, 2)]);

    api.editor.setSelections([cursorAt(0, 0)]); // user moved it again before redoing
    await api.commands.execute("editor.action.redo");
    expect(getSelections()).toEqual([cursorAt(0, 0)]);
  });
});

describe("editor-core activate() — addSelectionToNextFindMatch (ctrl+d, Req 11.1, Task 2.4)", () => {
  test("word select -> next match -> wraparound -> all-matches no-op", async () => {
    const { api, getSelections } = activateFixture(["foo bar foo baz foo"]);
    api.editor.setSelections([cursorAt(0, 9)]); // inside the middle "foo" (8-11)

    await api.commands.execute("editor.action.addSelectionToNextFindMatch");
    expect(getSelections()).toEqual([
      { start: pos(0, 8), end: pos(0, 11), anchor: pos(0, 8), active: pos(0, 11) },
    ]);

    await api.commands.execute("editor.action.addSelectionToNextFindMatch");
    expect(getSelections()[0]).toEqual({
      start: pos(0, 16),
      end: pos(0, 19),
      anchor: pos(0, 16),
      active: pos(0, 19),
    });
    expect(getSelections()).toHaveLength(2);

    await api.commands.execute("editor.action.addSelectionToNextFindMatch"); // wraparound
    expect(getSelections()[0]).toEqual({ start: pos(0, 0), end: pos(0, 3), anchor: pos(0, 0), active: pos(0, 3) });
    expect(getSelections()).toHaveLength(3);

    const beforeNoOp = getSelections();
    await api.commands.execute("editor.action.addSelectionToNextFindMatch"); // all matches selected
    expect(getSelections()).toEqual(beforeNoOp);
  });
});

describe("editor-core activate() — bracket auto-close (Req 11.1, Task 2.4)", () => {
  test("insert: an open bracket inserts the pair, caret lands between", async () => {
    const { api, lines, getSelections } = activateFixture([""]);
    await api.commands.execute("editor.action.typeOpenParen");
    expect(lines[0]).toBe("()");
    expect(getSelections()).toEqual([cursorAt(0, 1)]);
  });

  test("type-over: typing the closer right before an existing one just advances", async () => {
    const { api, lines, appliedEdits, getSelections } = activateFixture(["()"]);
    await api.commands.execute("editor.action.cursorRight"); // caret between ( and )
    await api.commands.execute("editor.action.typeCloseParen");
    expect(lines[0]).toBe("()"); // unchanged
    expect(appliedEdits).toHaveLength(0);
    expect(getSelections()).toEqual([cursorAt(0, 2)]);
  });

  test("selection-wrap: an open bracket over a selection wraps it, keeping it selected", async () => {
    const { api, lines, getSelections } = activateFixture(["abc"]);
    api.editor.setSelections([{ start: pos(0, 0), end: pos(0, 3), anchor: pos(0, 0), active: pos(0, 3) }]);
    await api.commands.execute("editor.action.typeOpenParen");
    expect(lines[0]).toBe("(abc)");
    expect(getSelections()).toEqual([
      { start: pos(0, 1), end: pos(0, 4), anchor: pos(0, 1), active: pos(0, 4) },
    ]);
  });

  test("a stray closing bracket with no match just inserts plainly", async () => {
    const { api, lines } = activateFixture([""]);
    await api.commands.execute("editor.action.typeCloseParen");
    expect(lines[0]).toBe(")");
  });

  test("quotes: typing a quote right before an existing one skips over it", async () => {
    const { api, lines, getSelections } = activateFixture(['""']);
    await api.commands.execute("editor.action.cursorRight");
    await api.commands.execute("editor.action.typeDoubleQuote");
    expect(lines[0]).toBe('""');
    expect(getSelections()).toEqual([cursorAt(0, 2)]);
  });

  test("no bracket pairs registered: degrades to plain character insertion", async () => {
    const { api, lines, languageContributions } = activateFixture([""]);
    languageContributions.delete("plaintext");
    await api.commands.execute("editor.action.typeOpenParen");
    expect(lines[0]).toBe("(");
  });
});
