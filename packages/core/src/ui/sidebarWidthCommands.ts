/**
 * The `workbench.action.increase/decreaseSidebarWidth` commands (Issue
 * #105): palette-visible, keyboard-driven sidebar resizing, and the third
 * of the three ways this issue asks for (a setting, a mouse drag, a
 * keyboard command). Each command reads the current width, steps it by
 * {@link SIDEBAR_WIDTH_STEP}, clamps it (`sidebarWidth.ts`'s
 * `clampSidebarWidth` — no `terminalWidth`, matching `layoutState.ts`'s
 * `coerceLayoutState`/`sidebarWidthConfigSync.ts`'s identical floor-only
 * posture: neither module has a live terminal to cap against, and
 * `shell.tsx`'s `Shell` re-caps against one on every render regardless), and
 * writes the result to BOTH `LayoutStateService` (so the change is visible
 * immediately) and `SidebarWidthSettingsWriter` (so it survives a restart,
 * `settings.json`'s `workbench.sidebarWidth`) — mirrors `panelCommands.ts`'s
 * "privileged bridge command registered directly on the core
 * `CommandRegistry`" shape exactly, for the same reason: `@tecode/api`'s
 * public surface exposes no way for an extension to touch either service
 * directly.
 *
 * **Every command invocation IS a commit** — unlike a mouse-drag's many
 * intermediate `onWidthDrag` ticks (`shell.tsx`'s `Sidebar`/`Shell` TSDoc),
 * a single keypress has no "in progress" phase, so both commands always
 * call `settingsWriter.write` (`sidebarWidthSettingsWriter.ts`'s own
 * debounce still protects against a user mashing the keybinding rapidly —
 * this module never has to reason about that itself).
 *
 * **Default binding — `ctrl+k [` / `ctrl+k ]`, scoped by `when`**
 * ({@link SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS}): verified against
 * `bindingTable.ts`'s `hasSequencePrefix`, which DOES evaluate each
 * candidate continuation's `when` clause before reporting a live chord
 * prefix (that function's own TSDoc: "A prefix whose only continuation's
 * `when` clause fails against `get` returns `false` here") — this is what
 * keeps a HAND-BOUND `ctrl+k` (e.g. an Emacs-style kill-line binding a
 * user adds to their own `keybindings.json` — `samples/
 * keybindings.emacs.json`'s own TSDoc-style header explains why) reachable
 * directly: under `editorTextFocus`, `sidebarFocus`/`explorerFocus` are
 * both false, so `hasSequencePrefix("ctrl+k", ...)` finds neither
 * `ctrl+k [` nor `ctrl+k ]` visible, and the user's own `ctrl+k` resolves
 * directly rather than entering chord-pending state.
 * `sidebarWidthCommands.test.ts`'s "the ctrl+k chord-shadowing hazard"
 * describe block proves exactly this against a real `BindingTable`/
 * `ChordStateMachine` pair (originally proven — before Issue #115 removed
 * the bundled keybinding presets — by `keybindingPresets.test.ts` pressing
 * the Emacs preset's own `ctrl+k` binding through the same real chord
 * machine; the guarantee this `when` clause provides outlives that
 * removal, since a hand-authored `user`-layer `ctrl+k` binding depends on
 * it exactly as much as a preset's did). Dropping the `when` clause here
 * would make both bindings visible UNCONDITIONALLY, breaking that test —
 * this `when` clause is load-bearing, not decorative. No existing binding
 * anywhere in `keybindings.fallback.json` or any builtin manifest uses
 * `[`/`]` as a stroke (verified by grep across `packages/`), so both
 * tails are free.
 */

import type { CommandHandler, CommandMeta, Disposable, KeybindingContribution } from "@tecode/api";
import type { LayoutStateService } from "./layoutState";
import { clampSidebarWidth } from "./sidebarWidth";
import type { SidebarWidthSettingsWriter } from "./sidebarWidthSettingsWriter";

/** `workbench.action.increaseSidebarWidth`'s command id. Exported so
 * `main.ts`/tests reference the same string rather than re-typing it
 * (matches `SHOW_PANEL_COMMAND_ID`'s own precedent). */
export const INCREASE_SIDEBAR_WIDTH_COMMAND_ID = "workbench.action.increaseSidebarWidth";

/** `workbench.action.decreaseSidebarWidth`'s command id — see
 * {@link INCREASE_SIDEBAR_WIDTH_COMMAND_ID}'s TSDoc. */
export const DECREASE_SIDEBAR_WIDTH_COMMAND_ID = "workbench.action.decreaseSidebarWidth";

/** Columns each command invocation steps `LayoutState.sidebarWidth` by
 * (Issue #105) — an arbitrary but deliberate "one keypress, one visible
 * change" granularity, matching a typical editor's resize-by-keyboard
 * step. */
export const SIDEBAR_WIDTH_STEP = 5;

/** The `when` clause scoping {@link SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS}
 * (this module's TSDoc) — true while either the sidebar's own outer box
 * (`shell.tsx`'s `Sidebar`, `"sidebarFocus"`) or the explorer's tree
 * specifically (`builtin/explorer/ExplorerView.tsx`'s
 * `EXPLORER_FOCUS_CONTEXT_KEY`, `"explorerFocus"`) holds focus. Exported so
 * `sidebarWidthCommands.test.ts`'s own regression tests can assert against
 * the same literal this module actually registers with, rather than a
 * hand-copied duplicate that could drift. */
export const SIDEBAR_WIDTH_FOCUS_WHEN = "sidebarFocus || explorerFocus";

/** Default keybindings for both commands (this module's TSDoc) — fed into
 * `main.ts`'s `defaults` layer alongside `MODAL_DEFAULT_KEYBINDINGS`/
 * `TAB_DEFAULT_KEYBINDINGS`, the same "core-owned bindings, not an
 * extension manifest's" layer those two already occupy
 * (`keymapState.ts`'s TSDoc). */
export const SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS: KeybindingContribution[] = [
  { key: "ctrl+k [", command: DECREASE_SIDEBAR_WIDTH_COMMAND_ID, when: SIDEBAR_WIDTH_FOCUS_WHEN },
  { key: "ctrl+k ]", command: INCREASE_SIDEBAR_WIDTH_COMMAND_ID, when: SIDEBAR_WIDTH_FOCUS_WHEN },
];

/** Dependencies for {@link createSidebarWidthStepHandler}/
 * {@link registerSidebarWidthCommands}. Narrowed with `Pick` (matches
 * `ShowPanelCommandDeps`'s own narrowing style) to the methods each command
 * needs. */
export interface SidebarWidthCommandsDeps {
  layoutState: Pick<LayoutStateService, "get" | "update">;
  settingsWriter: Pick<SidebarWidthSettingsWriter, "write">;
}

/**
 * Build a handler that steps `LayoutState.sidebarWidth` by `delta` (Issue
 * #105): reads the current width, clamps `current + delta`, and writes the
 * result to both `deps.layoutState` (immediate effect) and
 * `deps.settingsWriter` (persisted, this module's TSDoc's "every invocation
 * is a commit"). Synchronous and never throws — both `LayoutStateService.
 * update`/`.get` and `SidebarWidthSettingsWriter.write` are themselves
 * documented never-throwing (`layoutState.ts`'s/
 * `sidebarWidthSettingsWriter.ts`'s TSDoc), so no guard is needed on top,
 * matching `createShowPanelCommandHandler`'s identical reasoning.
 */
export function createSidebarWidthStepHandler(
  deps: SidebarWidthCommandsDeps,
  delta: number,
): CommandHandler {
  return () => {
    const current = deps.layoutState.get().sidebarWidth;
    const next = clampSidebarWidth(current + delta);
    deps.layoutState.update({ sidebarWidth: next });
    deps.settingsWriter.write(next);
  };
}

/** The narrow `CommandRegistry` slice {@link registerSidebarWidthCommands}
 * needs — matches `ShowPanelCommandDeps`'s sibling registrar-shaped
 * parameter style used across this codebase's other privileged bridge
 * commands. */
export interface SidebarWidthCommandsRegistrar {
  registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
}

/**
 * Register both `workbench.action.increase/decreaseSidebarWidth` handlers
 * directly on the core `CommandRegistry` (this module's TSDoc) — visible in
 * the command palette (`category: "View"`, matching
 * `registerShowPanelCommand`'s identical "a reasonable, self-explanatory
 * palette entry on its own" framing), reachable via `commands.execute`, AND
 * via {@link SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS}'s chord bindings once
 * `main.ts` feeds that array into the `defaults` keymap layer. Returns one
 * composite {@link Disposable} covering both registrations, idempotent like
 * every other `Disposable` in this codebase.
 */
export function registerSidebarWidthCommands(
  commands: SidebarWidthCommandsRegistrar,
  deps: SidebarWidthCommandsDeps,
): Disposable {
  const disposables: Disposable[] = [
    commands.registerCore(
      INCREASE_SIDEBAR_WIDTH_COMMAND_ID,
      createSidebarWidthStepHandler(deps, SIDEBAR_WIDTH_STEP),
      { title: "Increase Sidebar Width", category: "View" },
    ),
    commands.registerCore(
      DECREASE_SIDEBAR_WIDTH_COMMAND_ID,
      createSidebarWidthStepHandler(deps, -SIDEBAR_WIDTH_STEP),
      { title: "Decrease Sidebar Width", category: "View" },
    ),
  ];
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
