/**
 * The `workbench.action.showPanel` command (Issue #98 Phase 3 Task 4):
 * the privileged bridge command a `panel.tab` extension's own "focus"
 * command (e.g. `tecode.terminal`'s `terminal.focus`) calls to make
 * `Shell`'s bottom `Panel` visible before it grabs real OpenTUI focus onto
 * its own view — mirrors `openFileCommand.ts`'s/`tabCommands.ts`'s own
 * "privileged bridge command registered directly on the core
 * `CommandRegistry`" shape exactly, for exactly the same reason:
 * `@tecode/api`'s public surface exposes no way for an extension to touch
 * `LayoutStateService.update` directly (`main.ts`'s composition root is
 * the only place that holds a real `LayoutStateService`), the same
 * privilege boundary `explorer.focus`'s own `workbench.view.<id>`
 * delegate (`shell.tsx`'s `Shell`'s auto-registered per-sidebar-pair
 * command) already crosses for the SIDEBAR half of this exact problem —
 * this command is that same crossing point for the PANEL half, which had
 * no equivalent bridge at all before this issue (design.md's own
 * "Panel already exists and is ready... No builtin contributes a panel
 * view today" — Issue #98's own body).
 *
 * **Idempotent, and does nothing else**: setting `panelVisible: true` when
 * it is already `true` is a harmless no-op merge (`layoutState.ts`'s
 * `update` always just re-merges the partial and reschedules its own
 * debounced save — never throws, never no-ops differently based on
 * whether anything "actually changed"). This command deliberately does
 * NOT choose which `panel.tab` becomes the active tab — `Panel`
 * (`shell.tsx`) already defaults to the first registered tab on its own,
 * and Design Choice 3 of this issue's plan explicitly scopes tab-selection
 * plumbing out of the MVP (single panel tab).
 */

import type { CommandHandler, CommandMeta, Disposable } from "@tecode/api";
import type { LayoutStateService } from "./layoutState";

/** Command id this module registers. Exported so `main.ts`/tests and a
 * panel-contributing extension's own "focus" command (`tecode.terminal`'s
 * `terminal.focus`, Phase 4) reference the same string rather than
 * re-typing it — matches `OPEN_FILE_COMMAND_ID`'s own precedent, INCLUDING
 * the built-in extension that calls it re-declaring this exact string by
 * hand (`explorer/index.ts`'s own `OPEN_FILE_COMMAND_ID` duplicate — the
 * ESLint layering rule means `packages/builtin` can never import this
 * constant directly). */
export const SHOW_PANEL_COMMAND_ID = "workbench.action.showPanel";

/** Dependencies for {@link createShowPanelCommandHandler}. Narrowed with
 * `Pick` (matches `OpenFileCommandDeps`'s own narrowing style) to the one
 * method this command needs. */
export interface ShowPanelCommandDeps {
  layoutState: Pick<LayoutStateService, "update">;
}

/** Build the `workbench.action.showPanel` handler (this module's TSDoc):
 * unconditionally makes the bottom panel visible. Synchronous and never
 * throws — `LayoutStateService.update` is itself documented
 * never-throwing (`layoutState.ts`'s TSDoc), so no guard is needed on top
 * of it (unlike `openFileCommand.ts`'s handler, which wraps a real,
 * fallible I/O call). */
export function createShowPanelCommandHandler(deps: ShowPanelCommandDeps): CommandHandler {
  return () => {
    deps.layoutState.update({ panelVisible: true });
  };
}

/** Register {@link createShowPanelCommandHandler}'s handler as
 * `workbench.action.showPanel` directly on the core `CommandRegistry`
 * (this module's TSDoc) — no `meta.when` is set (unlike
 * `openFileCommand.ts`'s `HIDDEN_FROM_LISTINGS_WHEN`): showing the panel
 * is a reasonable, self-explanatory palette entry on its own, not merely
 * a plumbing step another command's handler calls internally. */
export function registerShowPanelCommand(
  commands: { registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable },
  deps: ShowPanelCommandDeps,
): Disposable {
  return commands.registerCore(SHOW_PANEL_COMMAND_ID, createShowPanelCommandHandler(deps), {
    title: "Show Panel",
    category: "View",
  });
}
