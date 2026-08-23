/**
 * `editor-core`'s manifest (Req 2.3, 11.1; design.md §4.1, §13): declares
 * every movement/selection/editing command Task 2.3 provides and their
 * default keybindings. Read and validated by the host WITHOUT executing
 * `index.ts` (Req 2.2) — pure data, `export default {...} satisfies
 * Manifest`.
 *
 * **Keybinding scope** (see `index.ts`'s TSDoc for the full rationale):
 * only movement/selection keys, Tab/Shift+Tab, Enter, and Ctrl+S are bound
 * here. Plain printable-character typing and Backspace/Delete are NOT
 * bound — `@tecode/core`'s `editor/inputRouter.ts` (Task 2.2) already
 * handles those via keymap fallthrough (no binding matched), and binding
 * them here would make the chord machine consume the stroke before it ever
 * reaches that fallthrough path, silently breaking typing. `editor.action.
 * deleteLeft`/`deleteRight` are still registered as commands (Req 11.1
 * lists "insert/delete" among what `editor-core` provides, for the palette
 * and programmatic `commands.execute` callers) — just with no keybinding.
 *
 * Every binding's `when` is `"editorTextFocus"` (the same context key
 * `editor/inputRouter.ts` gates on and `editorView.tsx`'s focus tracking
 * sets — Req 4.6), and every key string is already in
 * `keymap/normalize.ts`'s canonical lowercase `mod+...+key` form. Key names
 * match `@opentui/core`'s parsed key names, NOT always their VS Code label:
 * Enter's key name is `"return"` (`parse.keypress.ts`'s `charCode === 13 →
 * "return"`), not `"enter"`.
 */

import type { Manifest } from "@tecode/api";

const WHEN_EDITOR_TEXT_FOCUS = "editorTextFocus";

export default {
  id: "tecode.editor-core",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { id: "editor.action.cursorLeft", title: "Cursor Left", category: "Editor" },
      { id: "editor.action.cursorRight", title: "Cursor Right", category: "Editor" },
      { id: "editor.action.cursorUp", title: "Cursor Up", category: "Editor" },
      { id: "editor.action.cursorDown", title: "Cursor Down", category: "Editor" },
      { id: "editor.action.cursorWordLeft", title: "Cursor Word Left", category: "Editor" },
      { id: "editor.action.cursorWordRight", title: "Cursor Word Right", category: "Editor" },
      { id: "editor.action.cursorHome", title: "Cursor Line Start", category: "Editor" },
      { id: "editor.action.cursorEnd", title: "Cursor Line End", category: "Editor" },
      { id: "editor.action.cursorTop", title: "Cursor Document Start", category: "Editor" },
      { id: "editor.action.cursorBottom", title: "Cursor Document End", category: "Editor" },
      { id: "editor.action.cursorLeftSelect", title: "Select Left", category: "Editor" },
      { id: "editor.action.cursorRightSelect", title: "Select Right", category: "Editor" },
      { id: "editor.action.cursorUpSelect", title: "Select Up", category: "Editor" },
      { id: "editor.action.cursorDownSelect", title: "Select Down", category: "Editor" },
      { id: "editor.action.cursorWordLeftSelect", title: "Select Word Left", category: "Editor" },
      { id: "editor.action.cursorWordRightSelect", title: "Select Word Right", category: "Editor" },
      { id: "editor.action.cursorHomeSelect", title: "Select to Line Start", category: "Editor" },
      { id: "editor.action.cursorEndSelect", title: "Select to Line End", category: "Editor" },
      { id: "editor.action.cursorTopSelect", title: "Select to Document Start", category: "Editor" },
      { id: "editor.action.cursorBottomSelect", title: "Select to Document End", category: "Editor" },
      { id: "editor.action.insertNewLine", title: "Insert Line Break", category: "Editor" },
      { id: "editor.action.tab", title: "Tab", category: "Editor" },
      { id: "editor.action.outdent", title: "Outdent Line", category: "Editor" },
      { id: "editor.action.deleteLeft", title: "Delete Left (Backspace)", category: "Editor" },
      { id: "editor.action.deleteRight", title: "Delete Right", category: "Editor" },
      { id: "editor.action.save", title: "Save File", category: "Editor" },
    ],
    keybindings: [
      { key: "left", command: "editor.action.cursorLeft", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "right", command: "editor.action.cursorRight", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "up", command: "editor.action.cursorUp", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "down", command: "editor.action.cursorDown", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+left", command: "editor.action.cursorWordLeft", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+right", command: "editor.action.cursorWordRight", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "home", command: "editor.action.cursorHome", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "end", command: "editor.action.cursorEnd", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+home", command: "editor.action.cursorTop", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+end", command: "editor.action.cursorBottom", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+left", command: "editor.action.cursorLeftSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+right", command: "editor.action.cursorRightSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+up", command: "editor.action.cursorUpSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+down", command: "editor.action.cursorDownSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      {
        key: "ctrl+shift+left",
        command: "editor.action.cursorWordLeftSelect",
        when: WHEN_EDITOR_TEXT_FOCUS,
      },
      {
        key: "ctrl+shift+right",
        command: "editor.action.cursorWordRightSelect",
        when: WHEN_EDITOR_TEXT_FOCUS,
      },
      { key: "shift+home", command: "editor.action.cursorHomeSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+end", command: "editor.action.cursorEndSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+shift+home", command: "editor.action.cursorTopSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+shift+end", command: "editor.action.cursorBottomSelect", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "return", command: "editor.action.insertNewLine", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "tab", command: "editor.action.tab", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "shift+tab", command: "editor.action.outdent", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+s", command: "editor.action.save", when: WHEN_EDITOR_TEXT_FOCUS },
    ],
  },
} satisfies Manifest;
