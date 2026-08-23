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
 * winner. `explorer.newFile`/`newFolder`/`rename`/`delete` are reachable
 * via `ctrl+shift+p` (the command palette lists every registered command)
 * with no dedicated keybinding of their own in this MVP — Req 11.2 asks
 * for the CAPABILITY (create/rename/delete with prompts), not a specific
 * keyboard shortcut for each.
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

export default {
  id: "tecode.explorer",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [`onCommand:${EXPLORER_FOCUS_COMMAND_ID}`],
  contributes: {
    views: [{ id: EXPLORER_VIEW_ID, title: "Explorer", slot: "sidebar", icon: "📁" }],
    commands: [
      { id: EXPLORER_FOCUS_COMMAND_ID, title: "Focus on Explorer", category: "View" },
      { id: EXPLORER_NEW_FILE_COMMAND_ID, title: "New File", category: "File" },
      { id: EXPLORER_NEW_FOLDER_COMMAND_ID, title: "New Folder", category: "File" },
      { id: EXPLORER_RENAME_COMMAND_ID, title: "Rename", category: "File" },
      { id: EXPLORER_DELETE_COMMAND_ID, title: "Delete", category: "File" },
    ],
    keybindings: [{ key: "ctrl+shift+e", command: EXPLORER_FOCUS_COMMAND_ID }],
    configuration: {
      title: "Explorer",
      properties: {
        [EXPLORER_SHOW_HIDDEN_CONFIG_KEY]: {
          type: "boolean",
          default: false,
          description: "Show hidden (dot-prefixed) and .gitignore-ignored files in the explorer.",
        },
      },
    },
  },
} satisfies Manifest;
