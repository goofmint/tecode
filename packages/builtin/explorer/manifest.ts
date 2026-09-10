/**
 * `explorer`'s manifest (Task 3.3, Req 11.2; design.md §13's `explorer`
 * design): declares the sidebar view `index.ts` populates, the file-
 * operation commands it implements, `ctrl+shift+e`'s focus keybinding, and
 * `explorer.showHidden`'s configuration schema. Read and validated by the
 * host WITHOUT executing `index.ts` (Req 2.2) — pure data, `export default
 * {...} satisfies Manifest` (follows `command-palette/manifest.ts`'s
 * precedent).
 *
 * **`activationEvents: ["onCommand:explorer.focus"]`, not `"onStartup"`**
 * (design.md §12's "extension loading deferred... activate lazily per
 * their activation events"): the explorer's `views`/`commands`/
 * `keybindings`/`configuration` contributions are all registered at
 * manifest-registration time regardless of activation (`@tecode/core`'s
 * `host/registration.ts`'s `registerExtension` — every one of those four
 * kinds is pushed into its registry unconditionally, before any
 * extension's `index.ts` ever runs), so the activity-bar icon, the
 * "Focus on Explorer" palette entry, `ctrl+shift+e`, and `explorer.
 * showHidden`'s default are all present from the very first frame either
 * way. Only the actual `ExplorerView` React component (and its
 * `workspace.fs.readdir`/`watch` wiring) needs `activate(ctx)` to have
 * run — and that happens lazily, triggered by WHICHEVER of two paths
 * happens first: `ctrl+shift+e` resolving to `explorer.focus` (a lazy
 * command's `commands.execute` re-dispatches after activating its owner,
 * `commands/registry.ts`), or the user clicking the activity-bar icon
 * directly (`ui/slotRegistry.ts`'s `requestActivation`, `shell.tsx`'s
 * `Sidebar`) — `onCommand:explorer.focus` only names the FIRST of those
 * two as this manifest's own declared trigger; the second path activates
 * the same way any lazy `sidebar.view` entry does, independently of
 * `activationEvents` (`slotRegistry.ts`'s TSDoc's "Lazy views from
 * manifests").
 *
 * **No keybinding for Enter/creation/rename/deletion, deliberately**
 * (Task 3.3's plan: "avoid double-handling"): `tecode.ui.Tree`
 * (`@tecode/core`'s `components.tsx`) already handles `up`/`down`/`left`/
 * `right`/`return` itself, directly on its own focused root node
 * (`components.tsx`'s TSDoc's "Keyboard nav while focused") — a core-level
 * `when: "explorerFocus"` keybinding for `return` would race Tree's own
 * `onKeyDown` handling for the exact same keystroke with no well-defined
 * winner. `explorer.newFile`/`newFileFromEditor`/`newFolder`/`rename`/
 * `delete` are reachable via `ctrl+shift+p` (the command palette lists
 * every registered command) with no dedicated keybinding of their own in
 * this MVP — Req 11.2 asks for the CAPABILITY (create/rename/delete with
 * prompts), not a specific keyboard shortcut for each.
 */

import type { Manifest } from "@tecode/api";

/** The sidebar view id `index.ts` registers `ExplorerView` under, and the
 * activity-bar/sidebar pairing id (Req 6.2) — also `workbench.view.
 * explorer`'s auto-registered target (`@tecode/core`'s `shell.tsx`'s
 * `Sidebar`'s TSDoc). Exported so `index.ts` and tests reference the same
 * id. */
export const EXPLORER_VIEW_ID = "explorer";

/** `ctrl+shift+e` — focuses (and, VS Code-style, toggles) the explorer
 * sidebar (Req 11.2). */
export const EXPLORER_FOCUS_COMMAND_ID = "explorer.focus";
/** Creates a new file (Req 11.2's "create... with input-box prompts"). */
export const EXPLORER_NEW_FILE_COMMAND_ID = "explorer.newFile";
/** Creates a new file (Issue #120), same deferred-create behavior as
 * {@link EXPLORER_NEW_FILE_COMMAND_ID} — reachable from the command
 * palette without the explorer sidebar focused first (e.g. while working
 * in the editor). No dedicated keybinding, matching `newFile`/`newFolder`'s
 * own "command palette only" precedent (this manifest's TSDoc's "No
 * keybinding for Enter/creation/rename/deletion, deliberately"). */
export const EXPLORER_NEW_FILE_FROM_EDITOR_COMMAND_ID = "explorer.newFileFromEditor";
/** Creates a new folder (Req 11.2). */
export const EXPLORER_NEW_FOLDER_COMMAND_ID = "explorer.newFolder";
/** Renames the selected file or folder (Req 11.2). */
export const EXPLORER_RENAME_COMMAND_ID = "explorer.rename";
/** Deletes the selected file or folder, after a confirm prompt (Req
 * 11.2). */
export const EXPLORER_DELETE_COMMAND_ID = "explorer.delete";

/** Req 9.5's MVP setting: shows dotfiles and `.gitignore`-ignored entries
 * when `true` (`../shared/ignore.ts`'s `showHidden` bypass). Exported so
 * `index.ts` and tests reference the same key. */
export const EXPLORER_SHOW_HIDDEN_CONFIG_KEY = "explorer.showHidden";

/** Issue #121's setting: how many terminal columns `tecode.ui.Tree` indents
 * each depth level by inside the explorer (`components.tsx`'s
 * `TreeProps.indentWidth`, forwarded through `ExplorerView.tsx`). Follows
 * {@link EXPLORER_SHOW_HIDDEN_CONFIG_KEY}'s own shape exactly: read once at
 * `activate` (`index.ts`), kept live via `api.config.onDidChange`, and also
 * step-adjustable at runtime via {@link EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID}/
 * {@link EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID} WITHOUT writing back to
 * `settings.json` (`store.ts`'s `ExplorerStore.stepIndentWidth` TSDoc) — a
 * temporary, session-only override that a genuine `explorer.indentWidth`
 * edit (or a live config reload) always clears. Exported so `index.ts` and
 * tests reference the same key. */
export const EXPLORER_INDENT_WIDTH_CONFIG_KEY = "explorer.indentWidth";

/** Increases the explorer tree's indent width by one step, without writing
 * back to `settings.json` (Issue #121; `store.ts`'s `ExplorerStore.
 * stepIndentWidth` TSDoc). Exported so `index.ts` and tests reference the
 * same id. */
export const EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID = "explorer.increaseIndentWidth";
/** Decreases the explorer tree's indent width by one step (Issue #121) —
 * see {@link EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID}'s TSDoc. */
export const EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID = "explorer.decreaseIndentWidth";

export default {
  id: "tecode.explorer",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [`onCommand:${EXPLORER_FOCUS_COMMAND_ID}`],
  contributes: {
    views: [{ id: EXPLORER_VIEW_ID, title: "Explorer", slot: "sidebar" }],
    commands: [
      { id: EXPLORER_FOCUS_COMMAND_ID, title: "Focus on Explorer", category: "View" },
      { id: EXPLORER_NEW_FILE_COMMAND_ID, title: "New File", category: "File" },
      { id: EXPLORER_NEW_FILE_FROM_EDITOR_COMMAND_ID, title: "New File", category: "Editor" },
      { id: EXPLORER_NEW_FOLDER_COMMAND_ID, title: "New Folder", category: "File" },
      { id: EXPLORER_RENAME_COMMAND_ID, title: "Rename", category: "File" },
      { id: EXPLORER_DELETE_COMMAND_ID, title: "Delete", category: "File" },
      { id: EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID, title: "Increase Indent Width", category: "View" },
      { id: EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID, title: "Decrease Indent Width", category: "View" },
    ],
    // Issue #121's indent-width keybindings — `]`/`[`, plain (no modifier),
    // scoped to `when: "explorerFocus"`:
    //
    // - **NOT `ctrl+k ]` / `ctrl+k [`** (the originally-proposed key): those
    //   two chords are ALREADY `@tecode/core`'s own
    //   `sidebarWidthCommands.ts`'s `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS`, bound
    //   to `workbench.action.increase/decreaseSidebarWidth` under
    //   `SIDEBAR_WIDTH_FOCUS_WHEN = "sidebarFocus || explorerFocus"` — i.e.
    //   exactly the `explorerFocus` scope these two commands need too. Reusing
    //   the identical key string would make the two features fight over the
    //   very same chord the moment the explorer has focus (the case Issue #121
    //   actually cares about); the sidebar-width pair wins that fight simply by
    //   being registered in the `defaults` layer, ahead of any `extension`-
    //   layer entry a manifest like this one contributes, leaving these two
    //   commands permanently unreachable by keyboard. A DIFFERENT `ctrl+k`
    //   second stroke (e.g. `ctrl+k i`/`ctrl+k d`) would dodge the exact
    //   string collision but still make `ctrl+k` a chord PREFIX the instant
    //   `explorerFocus` is true — `chords.ts`'s "prefix wins over a
    //   simultaneous single-stroke exact match" (`sidebarWidthCommands.ts`'s
    //   own TSDoc walks through this exact hazard) — piling a second,
    //   unrelated `ctrl+k`-prefixed feature onto a chord namespace this
    //   package does not own is avoidable complexity for no benefit, so this
    //   manifest steers clear of `ctrl+k` altogether rather than trying to
    //   thread a non-colliding second stroke through it.
    // - **Not `ctrl+[` / `ctrl+]` either**: `ctrl+[` is indistinguishable from
    //   a bare Escape keypress in raw terminal input (both send the single
    //   byte `0x1B`) on a non-Kitty terminal — binding it would either steal
    //   Escape everywhere `explorerFocus` is true, or never fire at all,
    //   depending on how the terminal/parser resolves the ambiguity. Plain,
    //   unmodified `]`/`[` have no such ambiguity: they are ordinary printable
    //   characters, decoded identically on every terminal.
    // - **`]`/`[` are free**: verified by grepping `key:`/`"key":` across every
    //   `packages/builtin/*/manifest.ts`, `packages/core/src/ui/*Commands.ts`,
    //   `packages/core/src/keymap/keybindings.fallback.json`, and
    //   `samples/keybindings*.json` — the only existing bindings on these two
    //   characters are `editor-core/manifest.ts`'s `editor.action.
    //   typeOpenBracket`/`typeCloseBracket`, scoped to `when:
    //   "editorTextFocus"` — a context that can never be simultaneously true
    //   with `explorerFocus` (only one widget holds real keyboard focus at
    //   once), so the two `when`-scoped bindings on the same key never
    //   actually compete for a keystroke, the same "same key, mutually
    //   exclusive `when`" shape `modalCommands.ts`'s `up`/`down`/`return` and
    //   `editor-core/manifest.ts`'s own `up`/`down`/`return` already coexist
    //   under. `tecode.ui.Tree` itself (`components.tsx`) only intercepts
    //   `up`/`down`/`left`/`right`/`return` directly on its own focused root
    //   box — `]`/`[` pass through untouched, so there is no Tree-vs-keybinding
    //   race either (unlike Enter/arrows, `manifest.ts`'s own "no keybinding
    //   for Enter" paragraph above).
    // - **Why `]`/`[` conceptually**: mirrors how narrowing/widening the
    //   tree's indent visually resembles indent/outdent — `]` (increase)
    //   widens, `[` (decrease) narrows, the same left/right-bracket pairing
    //   an editor's own indent/outdent commands use elsewhere in this
    //   codebase, just applied to the tree's indent step instead of a text
    //   buffer's.
    keybindings: [
      { key: "ctrl+shift+e", command: EXPLORER_FOCUS_COMMAND_ID },
      { key: "]", command: EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID, when: "explorerFocus" },
      { key: "[", command: EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID, when: "explorerFocus" },
    ],
    configuration: {
      title: "Explorer",
      properties: {
        [EXPLORER_SHOW_HIDDEN_CONFIG_KEY]: {
          type: "boolean",
          default: false,
          description: "Show hidden (dot-prefixed) and .gitignore-ignored files in the explorer.",
        },
        [EXPLORER_INDENT_WIDTH_CONFIG_KEY]: {
          type: "number",
          default: 1,
          description: "Terminal columns each nesting level indents the explorer tree by.",
        },
      },
    },
  },
} satisfies Manifest;
