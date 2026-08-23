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
 *
 * **Task 2.4 additions** (line operations, undo/redo, bracket auto-close,
 * ctrl+d multi-cursor — Req 11.1): every new command below follows the
 * exact same "pure builder in its own module + a thin `commands.register`
 * wrapper here" shape as Task 2.3's movement/editing commands, so this
 * TSDoc only calls out what is genuinely new:
 *
 * - **`tecode.languages.register`d stub `"plaintext"` declaration**: Task
 *   2.8/2.9 (the real language registry and `languages-basic`) haven't
 *   landed yet — `tecode.languages.getLanguageId` always reports
 *   `"plaintext"` today (`@tecode/core`'s `stubs.ts`), and no language's
 *   `comments`/`brackets` metadata exists for `toggleLineComment`/bracket
 *   auto-close to read. `activate` registers a `"plaintext"` declaration
 *   of its own — `comments.line: "//"` and a standard bracket-pair set —
 *   purely so those two features are exercisable NOW rather than staying
 *   dead code until 2.8/2.9. This is a deliberate, documented stub: a real
 *   `languages-basic` declaration for actual languages (TypeScript, Python,
 *   ...) will supersede it, and `"//"` as "plaintext's" comment marker is
 *   admittedly odd — acceptable only because `getLanguageId` cannot yet
 *   report anything else.
 * - **Line operations** (`duplicateLine`/`moveLinesUp`/`moveLinesDown`/
 *   `deleteLine`, `lineOps.ts`): unlike movement/editing's per-selection
 *   builders, these operate on the WHOLE selections array at once (line
 *   grouping spans cursors) and return at most one document-wide edit —
 *   `registerLineOp` below is `registerEditing`'s analogue for that shape.
 * - **`toggleLineComment`** (`comments.ts`): the one command that reads
 *   `tecode.languages.getLanguage` — no-ops with no active editor's
 *   language registered or lacking a `comments.line` marker.
 * - **`undo`/`redo`**: call the real `Document.undo`/`redo` (Task 2.4's
 *   `@tecode/api` addition) directly — no `buildEditBatch`-style builder
 *   needed, since the undo stack already carries everything.
 * - **Bracket auto-close** (`brackets.ts`): registered per-character
 *   (`(`, `)`, `[`, `]`, `{`, `}`, `"`, `'`) rather than as one generic
 *   "typed a character" command — `manifest.ts`'s TSDoc documents exactly
 *   why keybindings must bind these literal characters, not modifier
 *   combinations, given today's (pre-Kitty-protocol) key parsing.
 * - **`addSelectionToNextFindMatch`** (ctrl+d, `multiCursor.ts`): the one
 *   movement-adjacent command that does NOT go through `registerMovement`
 *   — `mergeSelections`' re-sorting would destroy the "index 0 is primary"
 *   invariant this command depends on (`multiCursor.ts`'s own TSDoc).
 */

import type {
  BracketPair,
  Document,
  ExtensionContext,
  Position,
  Selection,
  TextEdit,
} from "@tecode/api";
import { buildBracketEditBatch } from "./brackets";
import { buildToggleLineCommentResult } from "./comments";
import {
  buildBackspaceEdit,
  buildDeleteEdit,
  buildEditBatch,
  buildNewlineEdit,
  buildOutdentEdit,
  buildTabEdit,
} from "./editing";
import {
  buildDeleteLineResult,
  buildDuplicateLineResult,
  buildMoveLinesDownResult,
  buildMoveLinesUpResult,
  type LineOpResult,
} from "./lineOps";
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
import { addSelectionToNextMatch } from "./multiCursor";

const DEFAULT_TAB_SIZE = 4;
const DEFAULT_INSERT_SPACES = true;

/** The stub `"plaintext"` language's bracket pairs (this module's TSDoc's
 * "Task 2.4 additions") — the standard set every mainstream editor
 * auto-closes, independent of any particular programming language's
 * syntax. Superseded once a real per-language declaration (Task 2.9)
 * registers its own `brackets`. */
const STANDARD_BRACKET_PAIRS: BracketPair[] = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
  { open: '"', close: '"' },
  { open: "'", close: "'" },
];

/** The stub language id every document resolves to today (`@tecode/core`'s
 * `stubs.ts`'s `getLanguageId`) — see this module's TSDoc. */
const STUB_LANGUAGE_ID = "plaintext";

/** Every bracket/quote character `editor-core` auto-closes, and the
 * command id `manifest.ts` binds each one to (this module's TSDoc's
 * "Bracket auto-close": one command per character, not one generic
 * "typed a character" command). */
const BRACKET_COMMAND_IDS = {
  "(": "editor.action.typeOpenParen",
  ")": "editor.action.typeCloseParen",
  "[": "editor.action.typeOpenBracket",
  "]": "editor.action.typeCloseBracket",
  "{": "editor.action.typeOpenBrace",
  "}": "editor.action.typeCloseBrace",
  '"': "editor.action.typeDoubleQuote",
  "'": "editor.action.typeSingleQuote",
} as const satisfies Record<string, string>;

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;

  // Task 2.4's stub "plaintext" language declaration (this module's TSDoc)
  // — makes `toggleLineComment`/bracket auto-close exercisable before Task
  // 2.8/2.9's real language registry lands.
  ctx.subscriptions.push(
    api.languages.register({
      id: STUB_LANGUAGE_ID,
      extensions: [],
      grammar: "",
      highlights: "",
      comments: { line: "//" },
      brackets: STANDARD_BRACKET_PAIRS,
    }),
  );

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

  /** Register a line-operation command (Req 11.1, this module's TSDoc):
   * `build` reads the WHOLE `selections` array at once (line grouping can
   * span cursors, `lineOps.ts`'s `groupSelectionLines`) and returns at
   * most one document-wide edit — `undefined` for a documented no-op
   * (every group already at a buffer boundary). A no-op with no active
   * editor, exactly like `registerEditing`. */
  function registerLineOp(
    id: string,
    build: (r: LineReader, selections: readonly Selection[]) => LineOpResult,
  ): void {
    ctx.subscriptions.push(
      api.commands.register(id, () => {
        const editor = api.window.activeEditor;
        if (!editor) return;
        const selections = api.editor.selections;
        if (selections.length === 0) return;
        const { edit, selections: newSelections } = build(reader(), selections);
        if (!edit) return;
        const document: Document = editor.document;
        document.transaction(() => document.applyEdits([edit]));
        api.editor.setSelections(newSelections);
      }),
    );
  }

  registerLineOp("editor.action.duplicateLine", buildDuplicateLineResult);
  registerLineOp("editor.action.moveLinesUp", buildMoveLinesUpResult);
  registerLineOp("editor.action.moveLinesDown", buildMoveLinesDownResult);
  registerLineOp("editor.action.deleteLine", buildDeleteLineResult);

  ctx.subscriptions.push(
    api.commands.register("editor.action.toggleLineComment", () => {
      const editor = api.window.activeEditor;
      if (!editor) return;
      const selections = api.editor.selections;
      if (selections.length === 0) return;
      // No-op with no registered language, or one with no `comments.line`
      // marker (this module's TSDoc) — a block/only-`comments.block`
      // language declaration is out of scope for this command.
      const marker = api.languages.getLanguage(editor.document.languageId)?.comments?.line;
      if (!marker) return;
      const { edits, selections: newSelections } = buildToggleLineCommentResult(reader(), selections, marker);
      if (edits.length === 0) return;
      const document: Document = editor.document;
      document.transaction(() => document.applyEdits(edits));
      api.editor.setSelections(newSelections);
    }),
  );

  ctx.subscriptions.push(
    api.commands.register("editor.action.undo", () => {
      const editor = api.window.activeEditor;
      if (!editor) return;
      // `undefined` means the undo stack itself was empty — a documented
      // no-op (`@tecode/api`'s `Document.undo` TSDoc). An empty (but
      // defined) array means an entry WAS undone but carried no selection
      // snapshot — every entry `editor-core` itself produces is this case,
      // since it only ever reaches `Document.applyEdits` through the
      // public single-argument signature (no `selectionsBefore`/`After`
      // opts to set). Leave the caret exactly where it is for both: an
      // explicit length check here, rather than leaning on `tecode.editor.
      // setSelections`'s own empty-array no-op, keeps that "don't move the
      // caret" decision visible at the call site instead of implicit.
      const selections = editor.document.undo();
      if (selections !== undefined && selections.length > 0) api.editor.setSelections(selections);
    }),
  );

  ctx.subscriptions.push(
    api.commands.register("editor.action.redo", () => {
      const editor = api.window.activeEditor;
      if (!editor) return;
      // See `editor.action.undo`'s handler above: `undefined` (redo stack
      // empty) and `[]` (entry redone but recorded no selection snapshot)
      // both mean "leave the caret alone".
      const selections = editor.document.redo();
      if (selections !== undefined && selections.length > 0) api.editor.setSelections(selections);
    }),
  );

  ctx.subscriptions.push(
    api.commands.register("editor.action.addSelectionToNextFindMatch", () => {
      const selections = api.editor.selections;
      if (selections.length === 0) return;
      // Always a defined, non-empty array — even the documented no-op
      // cases (`multiCursor.ts`'s TSDoc) return a copy of `selections`
      // unchanged, so writing it back is always safe.
      api.editor.setSelections(addSelectionToNextMatch(reader(), selections));
    }),
  );

  /** Register a bracket/quote auto-close command for `ch` (this module's
   * TSDoc's "Bracket auto-close"): reads the active document's registered
   * bracket pairs (`[]` with no matching language — degrades to plain
   * character insertion, exactly what keymap fallthrough would have done),
   * builds the multi-cursor batch (`brackets.ts`), and applies it in one
   * undo group. Skips `applyEdits` entirely for a pure type-over/no-op
   * batch (`edits.length === 0`) but still writes back `selections` —
   * type-over moves the caret with no edit at all. */
  function registerBracketChar(ch: string, id: string): void {
    ctx.subscriptions.push(
      api.commands.register(id, () => {
        const editor = api.window.activeEditor;
        if (!editor) return;
        const selections = api.editor.selections;
        if (selections.length === 0) return;
        const pairs = api.languages.getLanguage(editor.document.languageId)?.brackets ?? [];
        const { edits, selections: newSelections } = buildBracketEditBatch(reader(), selections, ch, pairs);
        if (edits.length > 0) {
          const document: Document = editor.document;
          document.transaction(() => document.applyEdits(edits));
        }
        api.editor.setSelections(newSelections);
      }),
    );
  }

  for (const [ch, id] of Object.entries(BRACKET_COMMAND_IDS)) {
    registerBracketChar(ch, id);
  }

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
