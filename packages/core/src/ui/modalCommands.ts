/**
 * Core-owned `modal.*` commands and their default keybindings (Task 3.1,
 * Req 10.1, design.md §12). Thin one-line delegations from a command (and,
 * via {@link MODAL_DEFAULT_KEYBINDINGS}, a keystroke) straight to
 * {@link ModalService} — the exact same "pure command handlers... delegate
 * to `ctx.api.editor.find.*`" shape `editor-core`'s find/replace commands
 * use over `ui/findService.ts` (`findService.ts`'s TSDoc), applied here to
 * the modal overlay instead.
 *
 * **Registered directly on the core `CommandRegistry`, NOT through an
 * extension manifest** — same privilege/ordering reasoning as `theme.
 * select` (`ui/themeSelectCommand.ts`'s TSDoc): the modal overlay is
 * core-owned infrastructure (design.md §12's "the palette and pickers must
 * exist before any extension UI") that `editor-core`'s own find/replace
 * commands, and later the command-palette/quick-open built-ins (tasks.md's
 * Task 3.2), all depend on already existing — it cannot wait for extension
 * discovery/registration to contribute its own keybindings the way
 * `editor-core`'s manifest does for `findWidgetFocus`. `main.ts`'s
 * composition root registers these commands AND feeds
 * {@link MODAL_DEFAULT_KEYBINDINGS} into `keymapState.ts`'s `defaults`
 * layer (`createKeymapState`'s second parameter) — the layer `bindingTable.
 * ts` has always reserved for exactly this ("core commands' own default
 * bindings", `keymapState.ts`'s pre-Task-3.1 TSDoc, now the first real
 * occupant).
 *
 * **`when` gating mirrors `editor-core`'s `findWidgetFocus` precedent**
 * (`editor-core/manifest.ts`'s TSDoc): `up`/`down` are scoped to
 * `quickPickFocus` only (an input box has nothing to navigate — Enter/
 * Escape are its only two actions), while `return`/`escape` are gated on
 * `quickPickFocus || inputBoxFocus` so the SAME two keys drive whichever
 * modal happens to be open, exactly like `editor-core`'s `return` binding
 * safely appears twice in one table disambiguated purely by `when`
 * (`bindingTable.ts`'s documented multi-binding-per-key contract) — here,
 * `quickPickFocus`/`inputBoxFocus`/`findWidgetFocus`/`editorTextFocus` are
 * never more than one truthy at a time (`modalOverlay.tsx`'s conditionally
 * mounted, single-active-modal Input reports whichever ONE of the first two
 * applies; `focus.tsx`'s single-focus-pointer bookkeeping — Escape/Enter
 * consumed here `preventDefault()`s before OpenTUI's own focused-input
 * handling ever sees the stroke, `keyRouting.ts`'s "consumed" branch).
 */

import type { CommandHandler, Disposable, KeybindingContribution } from "@tecode/api";
import type { ModalService } from "./modalService";

/** The `up`/`down`-gated context key a quick pick's filter `Input` reports
 * via `useFocusTracking` (`modalOverlay.tsx`) — mirrors `editor-core/
 * manifest.ts`'s `WHEN_FIND_WIDGET_FOCUS` naming. */
export const QUICK_PICK_FOCUS_CONTEXT_KEY = "quickPickFocus";
/** The context key an input box's `Input` reports (this module's TSDoc). */
export const INPUT_BOX_FOCUS_CONTEXT_KEY = "inputBoxFocus";

export const MODAL_SELECT_NEXT_COMMAND = "modal.selectNext";
export const MODAL_SELECT_PREVIOUS_COMMAND = "modal.selectPrevious";
export const MODAL_ACCEPT_COMMAND = "modal.accept";
export const MODAL_CLOSE_COMMAND = "modal.close";

const WHEN_ANY_MODAL_FOCUS = `${QUICK_PICK_FOCUS_CONTEXT_KEY} || ${INPUT_BOX_FOCUS_CONTEXT_KEY}`;

/** The modal overlay's default keybindings (this module's TSDoc) — fed
 * into `keymapState.ts`'s `defaults` layer directly by `main.ts`, never
 * through an extension manifest. Key names already in `keymap/normalize.
 * ts`'s canonical form (`editor-core/manifest.ts`'s own verified names:
 * `"return"` for Enter, `"escape"` for Escape). */
export const MODAL_DEFAULT_KEYBINDINGS: KeybindingContribution[] = [
  { key: "down", command: MODAL_SELECT_NEXT_COMMAND, when: QUICK_PICK_FOCUS_CONTEXT_KEY },
  { key: "up", command: MODAL_SELECT_PREVIOUS_COMMAND, when: QUICK_PICK_FOCUS_CONTEXT_KEY },
  { key: "return", command: MODAL_ACCEPT_COMMAND, when: WHEN_ANY_MODAL_FOCUS },
  { key: "escape", command: MODAL_CLOSE_COMMAND, when: WHEN_ANY_MODAL_FOCUS },
];

/** Narrow surface {@link registerModalCommands} needs from the core command
 * registry — matches `themeSelectCommand.ts`'s own `commands` parameter
 * shape. `registerCore`, not `register` (Issue #72): these commands are
 * core-owned infrastructure and must reserve their ids against extension
 * override. */
export interface ModalCommandsRegistrar {
  registerCore(id: string, handler: CommandHandler): Disposable;
}

/**
 * Register the 4 `modal.*` commands against `modalService` (this module's
 * TSDoc) directly on the core `CommandRegistry`. Returns one
 * {@link Disposable} that unregisters all 4 together, idempotent like every
 * other `Disposable` in this codebase.
 */
export function registerModalCommands(
  commands: ModalCommandsRegistrar,
  modalService: Pick<ModalService, "selectNext" | "selectPrevious" | "accept" | "cancel">,
): Disposable {
  const disposables: Disposable[] = [
    commands.registerCore(MODAL_SELECT_NEXT_COMMAND, () => modalService.selectNext()),
    commands.registerCore(MODAL_SELECT_PREVIOUS_COMMAND, () => modalService.selectPrevious()),
    commands.registerCore(MODAL_ACCEPT_COMMAND, () => modalService.accept()),
    commands.registerCore(MODAL_CLOSE_COMMAND, () => modalService.cancel()),
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
