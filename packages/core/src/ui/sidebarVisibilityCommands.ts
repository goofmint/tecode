/**
 * The `workbench.action.toggleSidebarVisibility` command (Issue #135):
 * replaces the old "re-click the active activity-bar item to collapse the
 * sidebar" gesture (`shell.tsx`'s `Shell.selectSidebarView`, now changed to
 * never toggle visibility on its own — see that function's own TSDoc) with
 * an explicit, dedicated command — mirrors `panelCommands.ts`'s
 * `workbench.action.showPanel` "privileged bridge command registered
 * directly on the core `CommandRegistry`" shape exactly, for exactly the
 * same reason: `@tecode/api`'s public surface exposes no way for an
 * extension (or, here, `shell.tsx`'s own `ActivityBar`'s dedicated toggle
 * glyph, wired through this same command id) to touch
 * `LayoutStateService.update` directly (`main.ts`'s composition root is the
 * only place that holds a real `LayoutStateService`).
 *
 * **Reads-then-writes, unlike `showPanelCommand`'s unconditional `true`**:
 * this command TOGGLES rather than sets a fixed value, so — unlike
 * `createShowPanelCommandHandler`, which never needs to look at the current
 * state — the handler here first reads `layoutState.get().sidebarVisible`
 * and writes back its negation. Still idempotent in the sense that matters
 * (every invocation is a well-defined flip, never throws, never leaves
 * `LayoutState` in a partial/inconsistent shape) — just not a no-op on
 * repeat, which is the whole point of a toggle.
 *
 * **Wired from two places (Issue #135)**: both `shell.tsx`'s `ActivityBar`
 * dedicated toggle glyph (a UI affordance, driven through `commands.execute`
 * exactly like a keybinding would be) and this module's own registration
 * below reach the SAME command id, so a user's `keybindings.json` rebind or
 * a command-palette invocation stays in sync with the glyph's own behavior
 * automatically — there is exactly one place that decides what "toggle the
 * sidebar" means.
 */

import type { CommandHandler, CommandMeta, Disposable } from "@tecode/api";
import type { LayoutStateService } from "./layoutState";

/** Command id this module registers. Exported so `main.ts`/tests and
 * `shell.tsx`'s `ActivityBar` toggle glyph reference the same string rather
 * than re-typing it — matches `SHOW_PANEL_COMMAND_ID`'s own precedent. */
export const TOGGLE_SIDEBAR_VISIBILITY_COMMAND_ID = "workbench.action.toggleSidebarVisibility";

/** Dependencies for {@link createToggleSidebarVisibilityCommandHandler}.
 * Narrowed with `Pick` (matches `ShowPanelCommandDeps`'s own narrowing
 * style) to the two methods this command needs — `get` (to read the
 * current value before flipping it) in addition to `update`. */
export interface ToggleSidebarVisibilityCommandDeps {
  layoutState: Pick<LayoutStateService, "get" | "update">;
}

/** Build the `workbench.action.toggleSidebarVisibility` handler (this
 * module's TSDoc): reads `LayoutState.sidebarVisible` and writes back its
 * negation. Synchronous and never throws — `LayoutStateService.get`/
 * `.update` are themselves documented never-throwing (`layoutState.ts`'s
 * TSDoc), so no guard is needed on top of it, matching
 * `createShowPanelCommandHandler`'s identical reasoning. */
export function createToggleSidebarVisibilityCommandHandler(
  deps: ToggleSidebarVisibilityCommandDeps,
): CommandHandler {
  return () => {
    const current = deps.layoutState.get().sidebarVisible;
    deps.layoutState.update({ sidebarVisible: !current });
  };
}

/** Register {@link createToggleSidebarVisibilityCommandHandler}'s handler
 * as `workbench.action.toggleSidebarVisibility` directly on the core
 * `CommandRegistry` (this module's TSDoc) — no `meta.when` is set (matches
 * `registerShowPanelCommand`'s own reasoning): toggling the sidebar is a
 * reasonable, self-explanatory palette entry on its own. */
export function registerSidebarVisibilityCommand(
  commands: { registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable },
  deps: ToggleSidebarVisibilityCommandDeps,
): Disposable {
  return commands.registerCore(
    TOGGLE_SIDEBAR_VISIBILITY_COMMAND_ID,
    createToggleSidebarVisibilityCommandHandler(deps),
    { title: "Toggle Sidebar Visibility", category: "View" },
  );
}
