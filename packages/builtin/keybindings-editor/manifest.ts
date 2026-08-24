/**
 * `keybindings-editor`'s manifest (Task 4.3, Req 11.7; design.md §13's
 * "**keybindings-editor**: `keybindings.open` opens the JSON file as a
 * normal document [...]; `keybindings.showResolved` renders the keymap
 * service's resolved table in a quick pick"): declares the two commands
 * `index.ts` implements and `keybindings.open`'s default chord binding.
 * Read and validated by the host WITHOUT executing `index.ts` (Req 2.2) —
 * pure data, `export default {...} satisfies Manifest` (follows
 * `command-palette/manifest.ts`'s precedent).
 *
 * **`activationEvents: ["onStartup"]`, not `onCommand:keybindings.open`**
 * (unlike `explorer/manifest.ts`'s deliberately lazy
 * `onCommand:explorer.focus`): both commands here are meant to be
 * reachable the moment the shell paints — `ctrl+k ctrl+s` is a chord a
 * user may reach for immediately, with no other affordance (no
 * activity-bar icon, no sidebar view) that would otherwise trigger lazy
 * activation the way `explorer.focus`'s icon click does. `command-palette`
 * (Req 11.3) makes the identical `onStartup` choice for the same reason —
 * its commands have no OTHER activation trigger besides being invoked
 * directly.
 *
 * **`ctrl+k ctrl+s` is a genuine two-stroke chord** (Req 4.4, design.md
 * §6.3): `keymap/bindingTable.ts`/`normalize.ts` treat a space-joined
 * sequence like this as one canonical multi-token key, resolved by the
 * chord state machine (`chords.ts`) after both strokes land in order —
 * this is not two separate single-key bindings.
 *
 * **No keybinding for `keybindings.showResolved`**: Req 11.7/design.md §13
 * name only `keybindings.open`'s chord explicitly; `showResolved` is
 * reachable through the command palette (`workbench.action.showCommands`)
 * like any other listed command — it has a `title`/`category` here for
 * exactly that reason, unlike the `keybindings.internal.*` bridge commands
 * `@tecode/core`'s `ui/keybindingsCommands.ts` registers directly (those
 * are deliberately hidden from every listing; these two are deliberately
 * NOT).
 */

import type { Manifest } from "@tecode/api";

/** `keybindings.open` — opens `~/.config/tecode/keybindings.json` as a
 * normal document, creating it from a commented JSONC template first if
 * absent (Req 11.7). Exported so `index.ts` and tests reference the same
 * id. */
export const KEYBINDINGS_OPEN_COMMAND_ID = "keybindings.open";

/** `keybindings.showResolved` — a quick pick over the keymap service's
 * fully resolved binding table: key, command, `when` clause, and source
 * layer (default / fallback / extension id / user) per binding (Req
 * 11.7). Exported so `index.ts` and tests reference the same id. */
export const KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID = "keybindings.showResolved";

export default {
  id: "tecode.keybindings-editor",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      {
        id: KEYBINDINGS_OPEN_COMMAND_ID,
        title: "Open Keyboard Shortcuts (JSON)",
        category: "Preferences",
      },
      {
        id: KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID,
        title: "Show Resolved Keybindings",
        category: "Preferences",
      },
    ],
    keybindings: [{ key: "ctrl+k ctrl+s", command: KEYBINDINGS_OPEN_COMMAND_ID }],
  },
} satisfies Manifest;
