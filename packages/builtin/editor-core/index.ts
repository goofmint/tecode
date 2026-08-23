/**
 * `editor-core`'s `activate(ctx)` (Req 11.1; design.md §13's "pure command
 * handlers over `tecode.editor` + `document.transaction`"): registers every
 * command `manifest.ts` declares against the real handlers in `movement.ts`/
 * `editing.ts`. Only imports `@tecode/api` (the ESLint layering rule) —
 * every read/write goes through `ctx.api`.
 *
 * **Movement/selection handlers** read `tecode.editor.selections` (`[]`
 * doubles as "no active editor", so no separate active-editor check is
 * needed — a document's `EditorState` always has at least one selection
 * once it exists), compute the new selections purely (`movement.ts`'s
 * `applyMovement`), and write them back via `tecode.editor.setSelections`
 * — no document mutation, so `revealLine`/scrolling happens for free via
 * `EditorView`'s own "recompute scroll from the primary cursor on every
 * render" behavior (`@tecode/core`'s `ui/editorView.tsx`).
 *
 * **Editing handlers** (`insertNewLine`/`tab`/`outdent`/`deleteLeft`/
 * `deleteRight`) go through `tecode.window.activeEditor.document` — the
 * real `Document`, wired since Task 2.3 (`@tecode/core`'s
 * `api/create.ts`) — rather than `tecode.editor.applyEdits`, specifically
 * to reach `Document.transaction`: wrapping even a single `applyEdits`
 * call in a `transaction` sets its undo-stack group id, which
 * `@tecode/core`'s `buffer/document.ts` documents as disabling
 * typing-coalescing for that entry — exactly right here, since a Tab/
 * Enter/Backspace/Delete should always be its own undo step, never merged
 * into an adjacent typed-character coalescing group.
 *
 * **`editor.tabSize`/`editor.insertSpaces`**: read once at activation and
 * kept current via `tecode.config.onDidChange` (Req 9.4) — every tab/
 * outdent command reads the live closed-over value, not a stale snapshot.
 */

import type { Document, ExtensionContext, Position, Selection, TextEdit } from "@tecode/api";
import {
  buildBackspaceEdit,
  buildDeleteEdit,
  buildEditBatch,
  buildNewlineEdit,
  buildOutdentEdit,
  buildTabEdit,
} from "./editing";
import {
  applyMovement,
  moveCharLeft,
  moveCharRight,
  moveDocumentEnd,
  moveDocumentStart,
  moveLineDown,
  moveLineEnd,
  moveLineHome,
  moveLineUp,
  moveWordLeft,
  moveWordRight,
  type LineReader,
} from "./movement";

const DEFAULT_TAB_SIZE = 4;
const DEFAULT_INSERT_SPACES = true;

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;

  let tabSize = api.config.get<number>("editor.tabSize") ?? DEFAULT_TAB_SIZE;
  let insertSpaces = api.config.get<boolean>("editor.insertSpaces") ?? DEFAULT_INSERT_SPACES;

  ctx.subscriptions.push(
    api.config.onDidChange((event) => {
      if (event.affectsConfiguration("editor.tabSize")) {
        tabSize = api.config.get<number>("editor.tabSize") ?? DEFAULT_TAB_SIZE;
      }
      if (event.affectsConfiguration("editor.insertSpaces")) {
        insertSpaces = api.config.get<boolean>("editor.insertSpaces") ?? DEFAULT_INSERT_SPACES;
      }
    }),
  );

  /** `tecode.editor` itself already satisfies `LineReader` (`getLine`/
   * `lineCount`) — this just narrows the reference for `movement.ts`/
   * `editing.ts`'s call signatures. */
  function reader(): LineReader {
    return { getLine: (line) => api.editor.getLine(line), lineCount: api.editor.lineCount };
  }

  /** Register a movement/selection command (Req 6.6, 11.1): map `moveOne`
   * over every current selection (`movement.ts`'s `applyMovement`, which
   * also merges overlaps) and write the result back. A no-op with no
   * active editor (`selections` is `[]` then). */
  function registerMovement(
    id: string,
    moveOne: (r: LineReader, position: Position) => Position,
    extend: boolean,
  ): void {
    ctx.subscriptions.push(
      api.commands.register(id, () => {
        const selections = api.editor.selections;
        if (selections.length === 0) return;
        const r = reader();
        api.editor.setSelections(applyMovement(selections, extend, (p) => moveOne(r, p)));
      }),
    );
  }

  registerMovement("editor.action.cursorLeft", moveCharLeft, false);
  registerMovement("editor.action.cursorRight", moveCharRight, false);
  registerMovement("editor.action.cursorUp", (r, p) => moveLineUp(r, p, tabSize), false);
  registerMovement("editor.action.cursorDown", (r, p) => moveLineDown(r, p, tabSize), false);
  registerMovement("editor.action.cursorWordLeft", moveWordLeft, false);
  registerMovement("editor.action.cursorWordRight", moveWordRight, false);
  registerMovement("editor.action.cursorHome", moveLineHome, false);
  registerMovement("editor.action.cursorEnd", moveLineEnd, false);
  registerMovement("editor.action.cursorTop", () => moveDocumentStart(), false);
  registerMovement("editor.action.cursorBottom", (r) => moveDocumentEnd(r), false);

  registerMovement("editor.action.cursorLeftSelect", moveCharLeft, true);
  registerMovement("editor.action.cursorRightSelect", moveCharRight, true);
  registerMovement("editor.action.cursorUpSelect", (r, p) => moveLineUp(r, p, tabSize), true);
  registerMovement("editor.action.cursorDownSelect", (r, p) => moveLineDown(r, p, tabSize), true);
  registerMovement("editor.action.cursorWordLeftSelect", moveWordLeft, true);
  registerMovement("editor.action.cursorWordRightSelect", moveWordRight, true);
  registerMovement("editor.action.cursorHomeSelect", moveLineHome, true);
  registerMovement("editor.action.cursorEndSelect", moveLineEnd, true);
  registerMovement("editor.action.cursorTopSelect", () => moveDocumentStart(), true);
  registerMovement("editor.action.cursorBottomSelect", (r) => moveDocumentEnd(r), true);

  /** Register an editing command (Req 11.1): build the multi-cursor edit
   * batch (`editing.ts`'s `buildEditBatch`), apply it through the active
   * document's own `transaction`/`applyEdits` (this module's TSDoc on why
   * `tecode.window.activeEditor.document`, not `tecode.editor.applyEdits`),
   * then write back the resulting selections. A no-op with no active
   * editor, or when the batch produces no edits at all (e.g. outdent on an
   * already-unindented line). */
  function registerEditing(
    id: string,
    build: (r: LineReader, selection: Selection) => TextEdit | undefined,
  ): void {
    ctx.subscriptions.push(
      api.commands.register(id, () => {
        const editor = api.window.activeEditor;
        if (!editor) return;
        const selections = api.editor.selections;
        if (selections.length === 0) return;
        const r = reader();
        const { edits, selections: newSelections } = buildEditBatch(selections, (s) => build(r, s));
        if (edits.length === 0) return;
        const document: Document = editor.document;
        document.transaction(() => document.applyEdits(edits));
        api.editor.setSelections(newSelections);
      }),
    );
  }

  registerEditing("editor.action.insertNewLine", (r, s) => buildNewlineEdit(r, s));
  registerEditing("editor.action.tab", (r, s) => buildTabEdit(r, s, tabSize, insertSpaces));
  registerEditing("editor.action.outdent", (r, s) => buildOutdentEdit(r, s, tabSize));
  registerEditing("editor.action.deleteLeft", (r, s) => buildBackspaceEdit(r, s));
  registerEditing("editor.action.deleteRight", (r, s) => buildDeleteEdit(r, s));

  ctx.subscriptions.push(
    api.commands.register("editor.action.save", async () => {
      const editor = api.window.activeEditor;
      if (!editor) return;
      await api.workspace.save(editor.document.uri);
    }),
  );
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
