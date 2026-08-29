/**
 * `tecode.terminal`'s manifest (Issue #98 Phase 4): declares the panel
 * view `index.ts` populates and the two commands that open it. Read and
 * validated by the host WITHOUT executing `index.ts` (Req 2.2) — pure
 * data, `export default {...} satisfies Manifest` (follows `explorer/
 * manifest.ts`'s precedent).
 *
 * **No default keybinding, deliberately** — unlike `explorer.focus`'s
 * `ctrl+shift+e`: every plain `ctrl+<letter>` this codebase can decode
 * unambiguously on every terminal (`editor-core/manifest.ts`'s own TSDoc)
 * is already spoken for by something else, cataloged exhaustively in
 * `packages/cli/src/keyRouting.ts`'s `TERMINAL_ESCAPE_STROKE` constant —
 * the very key this feature itself needed to reserve. Both commands are
 * still fully reachable via the command palette (`ctrl+shift+p`/`ctrl+p`)
 * with no dedicated shortcut of their own, matching `explorer.newFile`/
 * `newFolder`/`rename`/`delete`'s own "reachable via the palette, no
 * keybinding" precedent (`explorer/manifest.ts`'s TSDoc).
 *
 * **`activationEvents` names BOTH commands**, not just the one a user is
 * more likely to reach for first (`explorer/manifest.ts`'s own
 * `onCommand:explorer.focus`-only precedent covers a single command
 * because explorer only has one path INTO activation — clicking the
 * activity-bar icon directly activates the same way independently of
 * `activationEvents`, `slotRegistry.ts`'s "Lazy views from manifests").
 * `terminal.new` has no such second path (there is no activity-bar icon
 * for a panel view), so it needs its own explicit activation event or
 * invoking it before `terminal.focus` ever ran would simply do nothing.
 */

import type { Manifest } from "@tecode/api";

/** The panel view id `index.ts` registers the terminal grid under (Req
 * 6.2). Exported so `index.ts` and tests reference the same id. */
export const TERMINAL_VIEW_ID = "terminal";

/** Shows (creating the pty session on first use) and focuses the
 * integrated terminal panel (Issue #98). VS Code-style "focus" naming,
 * matching `explorer.focus`'s own convention — this does NOT toggle the
 * panel shut on a repeat invocation (unlike `explorer.focus`'s sidebar
 * delegate): a terminal session is a real, potentially long-running
 * process a user does not want to lose access to by pressing the same
 * shortcut twice. */
export const TERMINAL_FOCUS_COMMAND_ID = "terminal.focus";
/** Discards the current pty session (if any) and spawns a fresh one, then
 * shows and focuses it exactly like {@link TERMINAL_FOCUS_COMMAND_ID}
 * (Issue #98's MVP scope: exactly one terminal at a time — "new" means
 * "restart", not "open a second one"). */
export const TERMINAL_NEW_COMMAND_ID = "terminal.new";

export default {
  id: "tecode.terminal",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [`onCommand:${TERMINAL_FOCUS_COMMAND_ID}`, `onCommand:${TERMINAL_NEW_COMMAND_ID}`],
  contributes: {
    views: [{ id: TERMINAL_VIEW_ID, title: "Terminal", slot: "panel" }],
    commands: [
      { id: TERMINAL_FOCUS_COMMAND_ID, title: "Focus on Terminal", category: "View" },
      { id: TERMINAL_NEW_COMMAND_ID, title: "New Terminal", category: "Terminal" },
    ],
  },
} satisfies Manifest;
