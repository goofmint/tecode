/**
 * The find-file commands (Issue #164): `workbench.action.files.findFile`
 * (open the path minibuffer) plus the three widget-scoped `findFile.*`
 * commands its keybindings drive — `accept`, `close`, and `complete` (Tab).
 * Each one is a thin delegation to {@link FindFileService}, the same "pure
 * command handlers... delegate to the service" shape `modalCommands.ts`
 * uses over `ModalService` and `editor-core` uses over `ui/findService.ts`.
 *
 * **Registered directly on the core `CommandRegistry`, NOT through an
 * extension manifest** (Issue #164's Design Choice 2) — same
 * privilege-boundary reasoning as `openFileCommand.ts`/`modalCommands.ts`:
 * the service is `@tecode/core`-internal (it needs `EditorSessionService`
 * and the workspace root), so only composition-root code (`main.ts`) can
 * close over it, and its default keybindings must exist before extension
 * discovery has run.
 *
 * **No default keybinding for OPENING the minibuffer** (Issue #164's
 * 論点 3): Emacs' own `C-x C-f` is unavailable here — `ctrl+x` is cut
 * (`editor-core`'s manifest), so it is not a chord prefix — and every
 * plausible alternative collides with an existing binding or with an
 * `editorTextFocus` chord that deliberately is not a prefix. Following the
 * `editor.action.toggleFold` precedent (Issue #150), the command therefore
 * ships with `title`/`category` so it is reachable from the command palette
 * and leaves the key choice to the user's own `keybindings.json`.
 *
 * **The three widget bindings ARE defaults**
 * ({@link FIND_FILE_DEFAULT_KEYBINDINGS}, fed into `keymapState.ts`'s
 * `defaults` layer by `main.ts` alongside `MODAL_DEFAULT_KEYBINDINGS`):
 * `return`/`escape`/`tab`, each gated on
 * {@link FIND_FILE_FOCUS_CONTEXT_KEY} — the context key
 * `findFileWidget.tsx`'s own `useFocusTracking` reports. That `when` is
 * what separates this `tab` from the editor's own `tab` →
 * `editor.action.tab` (gated `editorTextFocus`): OpenTUI holds a single
 * focus pointer, so exactly one of the two keys is ever live
 * (`bindingTable.ts`'s documented multi-binding-per-key contract,
 * disambiguated purely by `when` — the same mechanism `modalCommands.ts`'s
 * `return`/`escape` already rely on).
 */

import type { CommandHandler, CommandMeta, Disposable, KeybindingContribution } from "@tecode/api";
import type { FindFileService } from "./findFileService";

/** The command that opens the path minibuffer (this module's TSDoc).
 * Exported so `main.ts`/tests/a user's `keybindings.json` documentation all
 * reference the same string. */
export const FIND_FILE_COMMAND_ID = "workbench.action.files.findFile";

/** Accept the typed path (`return`) — {@link FindFileService.accept}. */
export const FIND_FILE_ACCEPT_COMMAND = "findFile.accept";

/** Dismiss the minibuffer (`escape`) — {@link FindFileService.close}. */
export const FIND_FILE_CLOSE_COMMAND = "findFile.close";

/** Complete the typed path (`tab`) — {@link FindFileService.complete}. */
export const FIND_FILE_COMPLETE_COMMAND = "findFile.complete";

/** The context key `findFileWidget.tsx`'s input reports its focus into, and
 * the `when` clause every binding in {@link FIND_FILE_DEFAULT_KEYBINDINGS}
 * is gated on (this module's TSDoc). */
export const FIND_FILE_FOCUS_CONTEXT_KEY = "findFileWidgetFocus";

/** The widget-scoped default bindings (this module's TSDoc) — core-owned,
 * fed into `keymapState.ts`'s `defaults` layer by `main.ts`. Deliberately
 * contains NO binding for {@link FIND_FILE_COMMAND_ID} itself. */
export const FIND_FILE_DEFAULT_KEYBINDINGS: KeybindingContribution[] = [
  { key: "return", command: FIND_FILE_ACCEPT_COMMAND, when: FIND_FILE_FOCUS_CONTEXT_KEY },
  { key: "escape", command: FIND_FILE_CLOSE_COMMAND, when: FIND_FILE_FOCUS_CONTEXT_KEY },
  { key: "tab", command: FIND_FILE_COMPLETE_COMMAND, when: FIND_FILE_FOCUS_CONTEXT_KEY },
];

/** Dependencies for {@link createFindFileHandler}/{@link
 * registerFindFileCommands}. Narrowed to a `Pick` (matches
 * `OpenFileCommandDeps`' own narrowing) so a test can inject a minimal
 * fake. */
export interface FindFileCommandDeps {
  findFileService: Pick<FindFileService, "open" | "close" | "accept" | "complete">;
}

/** Narrow surface {@link registerFindFileCommands} needs from the core
 * command registry — `registerCore`, not `register` (Issue #72): these
 * commands are core-owned infrastructure and must reserve their ids against
 * extension override, exactly like `modalCommands.ts`'s own registrar. */
export interface FindFileCommandsRegistrar {
  registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
}

/** Build the `workbench.action.files.findFile` handler (this module's
 * TSDoc) — takes no arguments and simply opens the minibuffer. */
export function createFindFileHandler(deps: FindFileCommandDeps): CommandHandler {
  return () => {
    deps.findFileService.open();
  };
}

/**
 * Register {@link FIND_FILE_COMMAND_ID} (with `title`/`category`, so the
 * command palette lists it — this module's TSDoc's "No default keybinding
 * for OPENING the minibuffer") plus the three widget-scoped `findFile.*`
 * commands, all directly on the core `CommandRegistry`. Returns one
 * {@link Disposable} that unregisters all four together, idempotent like
 * every other `Disposable` in this codebase.
 */
export function registerFindFileCommands(
  commands: FindFileCommandsRegistrar,
  deps: FindFileCommandDeps,
): Disposable {
  const { findFileService } = deps;
  const disposables: Disposable[] = [
    commands.registerCore(FIND_FILE_COMMAND_ID, createFindFileHandler(deps), {
      title: "Find File (open by path)",
      category: "File",
    }),
    commands.registerCore(FIND_FILE_ACCEPT_COMMAND, () => {
      findFileService.accept();
    }),
    commands.registerCore(FIND_FILE_CLOSE_COMMAND, () => {
      findFileService.close();
    }),
    commands.registerCore(FIND_FILE_COMPLETE_COMMAND, () => findFileService.complete()),
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
