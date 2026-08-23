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
 *
 * **Task 2.4's bracket/quote keybindings** — the one place this manifest
 * DOES bind plain, unmodified printable characters, deliberately breaking
 * the "plain typing stays keymap fallthrough" rule stated above: `index.ts`'s
 * bracket auto-close commands need to intercept `(`, `)`, `[`, `]`, `{`,
 * `}`, `"`, `'` themselves (insert-pair / type-over / wrap), so the keymap
 * layer must consume them before fallthrough ever sees them — exactly the
 * same reasoning that puts `return`/`tab`/`shift+tab` here instead of
 * leaving them to fallthrough.
 *
 * **How every Task 2.4 stroke below was verified** — running
 * `@opentui/core@0.1.107`'s actual `parseKeypress` (vendored in
 * `node_modules`, not re-derived from reading its source) against
 * realistic raw terminal byte sequences for each combination, both with
 * `useKittyKeyboard: false` (the legacy/no-Kitty path) and `true` (the
 * Kitty path). Two facts about how `@tecode/cli`'s `renderShell.tsx` calls
 * `createCliRenderer()` (with no options at all) matter for reading the
 * results below:
 *
 * 1. `@opentui/core`'s `CliRenderer` — independently of `@tecode/cli`'s
 *    OWN (still-stubbed, unwired) `terminalCapabilities.ts` — asks the
 *    terminal to enable Kitty keyboard reporting BY DEFAULT (flags
 *    "disambiguate" + "report alternate keys", NOT "report all keys as
 *    escape codes") whenever `createCliRenderer` is called with no
 *    `useKittyKeyboard` override, which is exactly how `renderShell.tsx`
 *    calls it. So real behavior depends on whether the ATTACHED TERMINAL
 *    actually honors that request, independent of `@tecode/cli`'s own
 *    capability stub (which nothing downstream consumes yet, per its own
 *    TSDoc) — a real Kitty-capable terminal (Kitty, Ghostty, WezTerm — Req
 *    13.3's list) gets real disambiguation; others silently don't.
 * 2. Because the "report all keys as escape codes" flag is NOT requested,
 *    an unmodified printable keystroke is NEVER sent as a Kitty escape
 *    sequence on ANY terminal — it always arrives as the literal UTF-8
 *    byte(s), so `parseKittyKeyboard` never matches it and parsing falls
 *    through to the exact same legacy branch either way.
 *
 * **Bracket/quote characters** (`(`, `)`, `[`, `]`, `{`, `}`, `"`, `'`):
 * per fact 2 above, these are UNMODIFIED printable keystrokes on every
 * terminal, Kitty-capable or not — `parseKeypress` falls through to
 * `key.name = s` with every modifier flag `false` (the `s.length === 1`
 * branch), so the canonical stroke is the bare literal character itself,
 * NOT `shift+9`/`shift+'`/etc. even though each is a shifted key on a US
 * layout. Verified identical under both `useKittyKeyboard: true` and
 * `false`.
 *
 * **`ctrl+/` (`toggleLineComment`)**: genuinely terminal/mode-dependent.
 * Under a real Kitty-capable terminal, Ctrl+/ is disambiguated and reports
 * `{ name: "/", ctrl: true }` — canonical `"ctrl+/"`, exactly as bound
 * below. Under a non-Kitty (or Kitty-unresponsive) terminal, the physical
 * key instead sends the traditional single control byte `0x1F`, which
 * `parseKeypress`'s `getCtrlKeyName` maps to `"_"` (its `charCode 28-31 →
 * String.fromCharCode(charCode + 64)` table), producing `{ name: "_", ctrl:
 * true }` — canonical `"ctrl+_"`. Both bindings are declared below for the
 * same command so the shortcut works either way, rather than waiting on
 * Task 4.2's fallback-keymap layer (design.md §6.5) to cover this gap.
 *
 * **`ctrl+shift+<letter>` combos are UNSAFE as sole bindings**: a raw
 * `Ctrl+<letter>` control byte is computed by clearing bits 5-6 of the
 * ASCII code, which discards case entirely — `Ctrl+D` and `Ctrl+Shift+D`
 * send the IDENTICAL byte `0x04` on a non-Kitty terminal, both decoding to
 * `{ name: "d", ctrl: true, shift: false }` (verified: legacy parsing of
 * `0x04` never sets `shift`). A Kitty-capable terminal DOES disambiguate
 * them (`{ name: "d", ctrl: true, shift: true }`, verified against a
 * synthetic Kitty CSI-u sequence), but relying on that for a DEFAULT
 * binding means it silently fires the WRONG command on every non-Kitty
 * terminal whenever the un-shifted combo is already bound to something
 * else. This ruled out `ctrl+shift+d` for `duplicateLine` specifically,
 * since `ctrl+d` is this manifest's OWN binding for
 * `addSelectionToNextFindMatch` — on a non-Kitty terminal, Ctrl+Shift+D
 * would have silently run "add selection to next match" instead of
 * "duplicate line". `duplicateLine` uses `shift+alt+meta+down` instead
 * (this TSDoc's next paragraph explains the `alt+meta` pairing) — an
 * Alt-based combo, which (unlike Ctrl+letter) DOES preserve shift
 * information even without Kitty, verified below.
 *
 * `ctrl+shift+k` (`deleteLine`) keeps the collision-tolerant default
 * anyway: nothing else in this manifest claims `ctrl+k`, so on a
 * non-Kitty terminal it silently does nothing (never fires the wrong
 * command) rather than corrupting a selection — an acceptable degraded
 * mode, unlike `duplicateLine`'s case. `ctrl+shift+z` (`redo`) has the
 * SAME collision risk as `duplicateLine` did (a non-Kitty terminal cannot
 * distinguish it from this manifest's own `ctrl+z` `undo` binding, so it
 * would silently run undo instead) — kept anyway (it is at least
 * non-destructive: an accidental undo is one redo away) but paired with
 * `ctrl+y`, a universally unambiguous (Ctrl-only, no shift) alternate
 * binding for the same command, verified below.
 *
 * **Alt+Arrow (`moveLinesUp`/`moveLinesDown`/`duplicateLine`)**: verified
 * against both the traditional CSI modifier-parameter form
 * (`\x1b[1;{n}A`) and the double-ESC form (`\x1b\x1b[A`) some terminals
 * use for Alt — both decode identically, and identically under Kitty or
 * legacy parsing (the traditional CSI form doesn't match either of
 * `parseKittyKeyboard`'s two regexes, so it always falls through to the
 * same modifier-bitmask branch). That branch's own logic
 * (`key.option = key.option || !!(modifier & 2); key.meta = key.meta ||
 * !!(modifier & 2);`) sets BOTH `option` AND `meta` from the SAME "Alt"
 * modifier bit — so `keyEventToStroke` (which emits an `"alt"` token for
 * `option` and a separate `"meta"` token for `meta`) always produces BOTH
 * tokens together for an Alt-held arrow key, never `"alt"` alone. Hence
 * `alt+meta+up`/`alt+meta+down` below, and `shift+alt+meta+down` for
 * `duplicateLine` (VS Code's real "Copy Line Down" default is
 * Shift+Alt+Down) — confirmed this SAME double-flag behavior extends to
 * Shift+Alt+Arrow too (modifier bit 1 for shift ORs in independently).
 * Plain `ctrl+letter` combos (`ctrl+s`, `ctrl+z`, `ctrl+y`, `ctrl+d`) are
 * unaffected by any of this — a single modifier with no shift ambiguity
 * decodes identically and unambiguously in every mode.
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
      // Task 2.4: line operations, undo/redo, bracket auto-close, ctrl+d.
      { id: "editor.action.duplicateLine", title: "Duplicate Line", category: "Editor" },
      { id: "editor.action.moveLinesUp", title: "Move Line Up", category: "Editor" },
      { id: "editor.action.moveLinesDown", title: "Move Line Down", category: "Editor" },
      { id: "editor.action.deleteLine", title: "Delete Line", category: "Editor" },
      { id: "editor.action.toggleLineComment", title: "Toggle Line Comment", category: "Editor" },
      { id: "editor.action.undo", title: "Undo", category: "Editor" },
      { id: "editor.action.redo", title: "Redo", category: "Editor" },
      {
        id: "editor.action.addSelectionToNextFindMatch",
        title: "Add Selection to Next Find Match",
        category: "Editor",
      },
      { id: "editor.action.typeOpenParen", title: "Type ( (auto-close)", category: "Editor" },
      { id: "editor.action.typeCloseParen", title: "Type ) (auto-close)", category: "Editor" },
      { id: "editor.action.typeOpenBracket", title: "Type [ (auto-close)", category: "Editor" },
      { id: "editor.action.typeCloseBracket", title: "Type ] (auto-close)", category: "Editor" },
      { id: "editor.action.typeOpenBrace", title: "Type { (auto-close)", category: "Editor" },
      { id: "editor.action.typeCloseBrace", title: "Type } (auto-close)", category: "Editor" },
      { id: "editor.action.typeDoubleQuote", title: 'Type " (auto-close)', category: "Editor" },
      { id: "editor.action.typeSingleQuote", title: "Type ' (auto-close)", category: "Editor" },
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
      // Task 2.4: line operations, undo/redo, bracket auto-close, ctrl+d.
      // See this file's TSDoc for the verification behind every stroke
      // string below, especially the `alt+meta+`/dual-binding choices.
      {
        key: "shift+alt+meta+down",
        command: "editor.action.duplicateLine",
        when: WHEN_EDITOR_TEXT_FOCUS,
      },
      { key: "alt+meta+up", command: "editor.action.moveLinesUp", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "alt+meta+down", command: "editor.action.moveLinesDown", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+shift+k", command: "editor.action.deleteLine", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+/", command: "editor.action.toggleLineComment", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+_", command: "editor.action.toggleLineComment", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+z", command: "editor.action.undo", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+shift+z", command: "editor.action.redo", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "ctrl+y", command: "editor.action.redo", when: WHEN_EDITOR_TEXT_FOCUS },
      {
        key: "ctrl+d",
        command: "editor.action.addSelectionToNextFindMatch",
        when: WHEN_EDITOR_TEXT_FOCUS,
      },
      { key: "(", command: "editor.action.typeOpenParen", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: ")", command: "editor.action.typeCloseParen", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "[", command: "editor.action.typeOpenBracket", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "]", command: "editor.action.typeCloseBracket", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "{", command: "editor.action.typeOpenBrace", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "}", command: "editor.action.typeCloseBrace", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: '"', command: "editor.action.typeDoubleQuote", when: WHEN_EDITOR_TEXT_FOCUS },
      { key: "'", command: "editor.action.typeSingleQuote", when: WHEN_EDITOR_TEXT_FOCUS },
    ],
  },
} satisfies Manifest;
