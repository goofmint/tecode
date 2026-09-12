/**
 * The `workbench.action.increase/decreasePanelHeight` commands (Issue
 * #146): the keyboard-driven resize entry point `panelHeight.ts`'s own
 * TSDoc noted was still missing — mirrors `sidebarWidthCommands.ts`'s
 * `workbench.action.increase/decreaseSidebarWidth` pair almost exactly,
 * just vertically: `panelHeight` standing in for `sidebarWidth`,
 * `clampPanelHeight` standing in for `clampSidebarWidth`, and
 * `PanelHeightSettingsWriter` standing in for `SidebarWidthSettingsWriter`.
 * Each command reads the current height, steps it by
 * {@link PANEL_HEIGHT_STEP}, clamps it (`panelHeight.ts`'s
 * `clampPanelHeight` — no `terminalHeight`, matching
 * `panelHeightConfigSync.ts`'s identical floor-only posture: neither module
 * has a live terminal to cap against, and `shell.tsx`'s `Shell` re-caps
 * against one on every render regardless), and writes the result to BOTH
 * `LayoutStateService` (so the change is visible immediately) and
 * `PanelHeightSettingsWriter` (so it survives a restart, `settings.json`'s
 * `workbench.panelHeight`) — the same "privileged bridge command
 * registered directly on the core `CommandRegistry`" shape as
 * `sidebarWidthCommands.ts`, for the same reason: `@tecode/api`'s public
 * surface exposes no way for an extension to touch either service
 * directly.
 *
 * **Every command invocation IS a commit** — a single keypress has no
 * "in progress" phase, so both commands always call `settingsWriter.write`
 * (`panelHeightSettingsWriter.ts`'s own debounce still protects against a
 * user mashing the keybinding rapidly — this module never has to reason
 * about that itself), matching `sidebarWidthCommands.ts`'s identical
 * reasoning.
 *
 * **Default binding — `ctrl+k up` / `ctrl+k down`, scoped by `when`**
 * ({@link PANEL_HEIGHT_DEFAULT_KEYBINDINGS}): a DIFFERENT `ctrl+k` chord
 * tail than `sidebarWidthCommands.ts`'s own `ctrl+k [` / `ctrl+k ]` (no
 * stroke collision) and than `keybindings-editor/manifest.ts`'s
 * `ctrl+k ctrl+s`. `PANEL_HEIGHT_FOCUS_WHEN` names `panelFocus` (`shell.
 * tsx`'s `Panel`) and `terminalFocus` (`terminalGridView.tsx`'s own outer
 * box) rather than `sidebarWidthCommands.ts`'s `sidebarFocus`/
 * `explorerFocus` — the vertical analogue of "focus somewhere inside the
 * thing being resized". Deliberately does NOT include `editorTextFocus`
 * (Issue #146's Design Choice 3): the same `hasSequencePrefix`-verified
 * mechanism as `sidebarWidthCommands.ts`'s TSDoc describes keeps a
 * HAND-BOUND `ctrl+k` (e.g. an Emacs-style kill-line binding) reachable
 * directly while the editor has focus, since `panelFocus`/`terminalFocus`
 * are both false there.
 *
 * **A real integrated-terminal focus cannot actually reach this chord
 * today** (Issue #146's own scope boundary, its Design Choice 3): while a
 * real pty has terminal focus, `keyRouting.ts`'s `handleKeyEvent` forwards
 * every stroke except `ctrl+o` straight to the pty BEFORE the chord state
 * machine ever sees it — so `ctrl+k up`/`ctrl+k down` only resolve once
 * focus has moved OFF the live terminal (e.g. via `ctrl+o`) onto the
 * `Panel`'s own chrome, even though `terminalFocus` is part of `when` here.
 * A true passthrough for reserved strokes while a pty is focused is
 * `keyRouting.ts`'s concern, deferred to Issue #145's reserved-stroke
 * design — this module does not attempt it, and `keyRouting.ts` is left
 * untouched.
 */

import type { CommandHandler, CommandMeta, Disposable, KeybindingContribution } from "@tecode/api";
import type { LayoutStateService } from "./layoutState";
import { clampPanelHeight } from "./panelHeight";
import type { PanelHeightSettingsWriter } from "./panelHeightSettingsWriter";

/** `workbench.action.increasePanelHeight`'s command id. Exported so
 * `main.ts`/tests reference the same string rather than re-typing it
 * (matches `INCREASE_SIDEBAR_WIDTH_COMMAND_ID`'s own precedent). */
export const INCREASE_PANEL_HEIGHT_COMMAND_ID = "workbench.action.increasePanelHeight";

/** `workbench.action.decreasePanelHeight`'s command id — see
 * {@link INCREASE_PANEL_HEIGHT_COMMAND_ID}'s TSDoc. */
export const DECREASE_PANEL_HEIGHT_COMMAND_ID = "workbench.action.decreasePanelHeight";

/** Rows each command invocation steps `LayoutState.panelHeight` by (Issue
 * #146) — an arbitrary but deliberate "one keypress, one visible change"
 * granularity, smaller than `SIDEBAR_WIDTH_STEP`'s 5 columns since rows are
 * a coarser unit than columns in a typical terminal cell grid. */
export const PANEL_HEIGHT_STEP = 3;

/** The `when` clause scoping {@link PANEL_HEIGHT_DEFAULT_KEYBINDINGS} (this
 * module's TSDoc) — true while either the `Panel`'s own outer box
 * (`shell.tsx`'s `Panel`, `"panelFocus"`) or the terminal grid specifically
 * (`terminalGridView.tsx`'s own outer box, `"terminalFocus"`) holds focus.
 * Exported so `panelHeightCommands.test.ts`'s own regression tests can
 * assert against the same literal this module actually registers with,
 * rather than a hand-copied duplicate that could drift. */
export const PANEL_HEIGHT_FOCUS_WHEN = "panelFocus || terminalFocus";

/** Default keybindings for both commands (this module's TSDoc) — fed into
 * `main.ts`'s `defaults` layer alongside `SIDEBAR_WIDTH_DEFAULT_
 * KEYBINDINGS`/`TAB_DEFAULT_KEYBINDINGS`, the same "core-owned bindings,
 * not an extension manifest's" layer those already occupy (`keymapState.
 * ts`'s TSDoc). */
export const PANEL_HEIGHT_DEFAULT_KEYBINDINGS: KeybindingContribution[] = [
  { key: "ctrl+k up", command: INCREASE_PANEL_HEIGHT_COMMAND_ID, when: PANEL_HEIGHT_FOCUS_WHEN },
  { key: "ctrl+k down", command: DECREASE_PANEL_HEIGHT_COMMAND_ID, when: PANEL_HEIGHT_FOCUS_WHEN },
];

/** Dependencies for {@link createPanelHeightStepHandler}/
 * {@link registerPanelHeightCommands}. Narrowed with `Pick` (matches
 * `SidebarWidthCommandsDeps`'s own narrowing style) to the methods each
 * command needs. */
export interface PanelHeightCommandsDeps {
  layoutState: Pick<LayoutStateService, "get" | "update">;
  settingsWriter: Pick<PanelHeightSettingsWriter, "write">;
}

/**
 * Build a handler that steps `LayoutState.panelHeight` by `delta` (Issue
 * #146): reads the current height, clamps `current + delta` (no
 * `terminalHeight` — see this module's TSDoc), and writes the result to
 * both `deps.layoutState` (immediate effect) and `deps.settingsWriter`
 * (persisted, this module's TSDoc's "every invocation is a commit").
 * Synchronous and never throws — both `LayoutStateService.update`/`.get`
 * and `PanelHeightSettingsWriter.write` are themselves documented
 * never-throwing (`layoutState.ts`'s/`panelHeightSettingsWriter.ts`'s
 * TSDoc), so no guard is needed on top, matching
 * `createSidebarWidthStepHandler`'s identical reasoning.
 */
export function createPanelHeightStepHandler(
  deps: PanelHeightCommandsDeps,
  delta: number,
): CommandHandler {
  return () => {
    const current = deps.layoutState.get().panelHeight;
    const next = clampPanelHeight(current + delta);
    deps.layoutState.update({ panelHeight: next });
    deps.settingsWriter.write(next);
  };
}

/** The narrow `CommandRegistry` slice {@link registerPanelHeightCommands}
 * needs — matches `SidebarWidthCommandsRegistrar`'s sibling
 * registrar-shaped parameter style used across this codebase's other
 * privileged bridge commands. */
export interface PanelHeightCommandsRegistrar {
  registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
}

/**
 * Register both `workbench.action.increase/decreasePanelHeight` handlers
 * directly on the core `CommandRegistry` (this module's TSDoc) — visible in
 * the command palette (`category: "View"`, matching
 * `registerSidebarWidthCommands`'s identical "a reasonable,
 * self-explanatory palette entry on its own" framing), reachable via
 * `commands.execute`, AND via {@link PANEL_HEIGHT_DEFAULT_KEYBINDINGS}'s
 * chord bindings once `main.ts` feeds that array into the `defaults`
 * keymap layer. Returns one composite {@link Disposable} covering both
 * registrations, idempotent like every other `Disposable` in this
 * codebase.
 */
export function registerPanelHeightCommands(
  commands: PanelHeightCommandsRegistrar,
  deps: PanelHeightCommandsDeps,
): Disposable {
  const disposables: Disposable[] = [
    commands.registerCore(
      INCREASE_PANEL_HEIGHT_COMMAND_ID,
      createPanelHeightStepHandler(deps, PANEL_HEIGHT_STEP),
      { title: "Increase Panel Height", category: "View" },
    ),
    commands.registerCore(
      DECREASE_PANEL_HEIGHT_COMMAND_ID,
      createPanelHeightStepHandler(deps, -PANEL_HEIGHT_STEP),
      { title: "Decrease Panel Height", category: "View" },
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
