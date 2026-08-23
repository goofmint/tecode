/**
 * `command-palette`'s manifest (Task 3.2, Req 11.3; design.md §13):
 * declares the two commands `index.ts` implements — command search
 * (`ctrl+shift+p`) and fuzzy file quick-open (`ctrl+p`) — and their default
 * keybindings. Read and validated by the host WITHOUT executing `index.ts`
 * (Req 2.2) — pure data, `export default {...} satisfies Manifest`
 * (follows `editor-core/manifest.ts`'s precedent).
 *
 * **No `when` clause on either binding**: both are meant to work from
 * anywhere (a real VS Code user reaches for `ctrl+shift+p`/`ctrl+p`
 * regardless of what currently has focus) — `KeybindingContribution.when`
 * is optional, and omitting it means "always active", exactly like every
 * `MODAL_DEFAULT_KEYBINDINGS` entry's `up`/`down` scoping does NOT apply
 * here (those are deliberately focus-scoped; these deliberately are not).
 *
 * **`ctrl+shift+p` vs `ctrl+p` on a non-Kitty terminal — a known,
 * documented limitation, not something this manifest can fix**: both keys
 * are declared below because design.md §13 and Req 11.3 name them
 * explicitly (VS Code's own convention: `ctrl+shift+p` opens the command
 * palette, `ctrl+p` opens quick-open), and `@tecode/core`'s
 * `keymap/bindingTable.ts` genuinely treats them as two distinct,
 * independently-resolvable table entries — `normalizeKey("ctrl+shift+p")`
 * (`"ctrl+shift+p"`) and `normalizeKey("ctrl+p")` (`"ctrl+p"`) are
 * different canonical strings, so `BindingTable.lookup` never confuses one
 * for the other, and `cli/src/commandPaletteKeybindings.test.ts` proves
 * exactly that at the table level.
 *
 * The genuine ambiguity lives one layer BELOW the table, in how a raw
 * keystroke is PARSED into a stroke in the first place — the exact
 * `ctrl+shift+<letter>` hazard `editor-core/manifest.ts`'s TSDoc already
 * documents at length for `ctrl+shift+d`/`ctrl+shift+k`/`ctrl+shift+z`: a
 * physical Ctrl+Shift+P on a terminal with no Kitty Keyboard Protocol
 * support sends the SAME raw control byte (`0x10`) as a physical Ctrl+P —
 * `parseKeypress`'s legacy branch cannot recover the dropped Shift bit, so
 * both decode to the identical `{ name: "p", ctrl: true, shift: false }`
 * event, which can only ever resolve `ctrl+p`'s binding
 * (`workbench.action.quickOpen`). A Kitty-capable terminal (Kitty, Ghostty,
 * WezTerm — Req 13.3's list) DOES disambiguate the two correctly.
 *
 * Unlike `duplicateLine`'s `ctrl+shift+d` (which `editor-core/manifest.ts`
 * deliberately moved OFF `ctrl+shift+d` to an unambiguous alternate
 * binding, since colliding with editor-core's OWN `ctrl+d` would silently
 * run the wrong command), this manifest keeps the VS Code-standard keys as
 * specified by design.md §13/Req 11.3 rather than inventing a
 * non-standard alternate binding for `workbench.action.showCommands` —
 * the collision only degrades ONE direction (Ctrl+Shift+P falls back to
 * quick-open instead of the palette) on a legacy terminal, both commands
 * stay reachable via `commands.execute` or the (still-working) other key
 * regardless, and Task 4.2's fallback keymap layer (design.md §6.5, Req
 * 4.7) is the intended, more general fix for every `ctrl+shift+<letter>`
 * hazard at once — not something this task should route around per
 * binding. Until then, this is a documented, accepted legacy-terminal
 * limitation, not a bug in this manifest or the binding table.
 */

import type { Manifest } from "@tecode/api";

/** `workbench.action.showCommands` — the command palette (`ctrl+shift+p`,
 * Req 11.3). Exported so `index.ts` and tests reference the same id. */
export const SHOW_COMMANDS_COMMAND_ID = "workbench.action.showCommands";
/** `workbench.action.quickOpen` — fuzzy file quick-open (`ctrl+p`, Req
 * 11.3). Exported so `index.ts` and tests reference the same id. */
export const QUICK_OPEN_COMMAND_ID = "workbench.action.quickOpen";

export default {
  id: "tecode.command-palette",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { id: SHOW_COMMANDS_COMMAND_ID, title: "Show All Commands", category: "View" },
      { id: QUICK_OPEN_COMMAND_ID, title: "Go to File...", category: "View" },
    ],
    keybindings: [
      { key: "ctrl+shift+p", command: SHOW_COMMANDS_COMMAND_ID },
      { key: "ctrl+p", command: QUICK_OPEN_COMMAND_ID },
    ],
  },
} satisfies Manifest;
