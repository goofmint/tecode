/**
 * The `tab.*` commands (Task 3.5, Req 6.5, design.md §8): tab open/switch/
 * close over the single editor group `EditorArea`'s `TabBar` renders
 * (`shell.tsx`'s `editorTabs`) — `tab.next`/`tab.previous` cycle
 * `documents.documents`' order (Req 6.5's "exactly one editor group... with
 * multiple tabs" — that array IS the tab order, there is no separate tab
 * list to keep in sync), `tab.close`/`tab.closeOthers` close through a
 * shared dirty-close confirmation prompt.
 *
 * **Registered directly on the core `CommandRegistry`, not through an
 * extension manifest** — same privilege-boundary reasoning as `theme.
 * select` (`ui/themeSelectCommand.ts`'s TSDoc) and the `modal.*` commands
 * (`ui/modalCommands.ts`'s TSDoc): closing over `DocumentManager.close`/
 * `save` and `EditorSessionService.setActiveDocumentUri` directly is a
 * privileged operation `@tecode/api`'s `WorkspaceNamespace`/
 * `WindowNamespace` do not expose to extensions. `showQuickPick` is
 * injected (not hardcoded to `window.showQuickPick`) for the exact same
 * "substitution, not a rewrite" reason `themeSelectCommand.ts` gives.
 *
 * **`closeDocumentWithPrompt` never calls `setActiveDocumentUri`**
 * (this module's own contract, matching `editorSession.ts`'s documented
 * active-document policy): `EditorSessionService` already recalculates the
 * active uri itself on every `documents.onDidClose` (`editorSession.ts`'s
 * `syncActiveDocument`) — keep the current active document if still open,
 * otherwise fall back to the first open one, `undefined` when nothing is
 * open. Calling `setActiveDocumentUri` here too would be redundant at best
 * and, for `tab.closeOthers` (which closes several documents in one
 * sequence), would fight the service's own per-close recalculation with a
 * stale intermediate value on every iteration.
 *
 * **Save-failure safety** (design.md §14's "never lose unsaved data"):
 * `documents.save`'s contract is "returns `false` on a no-op or a write/
 * rename failure" (`documentManager.ts`) — `closeDocumentWithPrompt`
 * treats both a `false` return AND a thrown rejection identically: log and
 * abort, `documents.close` is never reached, so a save failure can never
 * silently discard the buffer.
 *
 * **Never throws** (design.md §14's "Command handler throws -> Caught,
 * logged", matching every other command handler in this codebase): a
 * throwing `showQuickPick` is treated the same as a Cancel/Escape pick —
 * logged, no side effects — rather than propagating.
 *
 * ---
 *
 * ## Keybinding verification (Task 3.5's methodology, following
 * `editor-core/manifest.ts`'s own "run the vendored parser against real
 * byte sequences" precedent)
 *
 * Ran `@opentui/core@0.1.107`'s actual `parseKeypress` (vendored in
 * `node_modules`, not re-derived from reading its source) against
 * realistic raw terminal byte sequences for Tab/Ctrl+Tab/Ctrl+Shift+Tab/
 * Ctrl+W/Ctrl+PageUp/Ctrl+PageDown, under both `useKittyKeyboard: false`
 * (the legacy/no-Kitty path) and `true` (the Kitty path) — same two facts
 * about `renderShellToTerminal`'s unconfigured `createCliRenderer()` call
 * apply here as `editor-core/manifest.ts`'s TSDoc already documents (Kitty
 * reporting requested by default, but only a Kitty-capable ATTACHED
 * TERMINAL actually honors it).
 *
 * **Ctrl+Tab / Ctrl+Shift+Tab collapse into plain Tab on a legacy
 * terminal — worse than the `ctrl+shift+<letter>` case `editor-core/
 * manifest.ts` already documents.** For a letter, `Ctrl+D` and
 * `Ctrl+Shift+D` at least both decode as *some* `ctrl+...` stroke on a
 * legacy terminal (`editor-core/manifest.ts`'s TSDoc). Tab has no `Ctrl+`
 * control-byte encoding at all distinct from plain Tab: clearing bits 5-6
 * of `Tab`'s own code point still yields the identical byte `0x09` — a
 * legacy terminal that sends Ctrl+Tab as a raw byte at all sends the EXACT
 * SAME `0x09` a plain Tab keystroke sends (verified: `parseKeypress(0x09,
 * {useKittyKeyboard:false})` → `{name:"tab", ctrl:false}`, identically for
 * both). Ctrl+Shift+Tab has no legacy raw-byte encoding whatsoever. A
 * genuinely Kitty-capable terminal DOES disambiguate both: `parseKeypress`
 * against a synthetic Kitty CSI-u sequence (`\x1b[9;5u`,
 * `useKittyKeyboard:true`) → `{name:"tab", ctrl:true, shift:false}`, and
 * (`\x1b[9;6u`) → `{name:"tab", ctrl:true, shift:true}` — genuinely
 * distinguishable from plain Tab and from each other, exactly the VS
 * Code-standard bindings this module still declares below. But relying on
 * them ALONE would be actively dangerous on a legacy terminal, more so
 * than `editor-core`'s ctrl+shift+d case: `editor-core/manifest.ts` binds
 * plain `"tab"` to `editor.action.tab` (indent/insert) under
 * `editorTextFocus` — so on a legacy terminal, physically pressing
 * Ctrl+Tab while editing would silently indent instead of switching tabs
 * (this collision predates this module — registering `"ctrl+tab"` here
 * cannot make it worse; the binding table key `"ctrl+tab"` is simply
 * unreachable on that terminal, `"tab"` was always going to win the raw
 * byte either way).
 *
 * **The fix, per this task's own instruction**: add distinguishable
 * alternates alongside the VS Code-standard Ctrl+Tab/Ctrl+Shift+Tab pair,
 * so the feature stays reachable on a legacy terminal. Verified
 * `Ctrl+PageDown`/`Ctrl+PageUp` (`\x1b[6;5~`/`\x1b[5;5~`, xterm's
 * traditional CSI-with-modifier-parameter form) decode IDENTICALLY and
 * correctly under BOTH `useKittyKeyboard: true` and `false` —
 * `{name:"pagedown", ctrl:true}` / `{name:"pageup", ctrl:true}` either
 * way, no ambiguity, nothing else in this codebase binds them. These are
 * also VS Code's OWN real alternate defaults for `workbench.action.
 * nextEditor`/`previousEditor` — not an invented Alt-based combo (a
 * from-scratch double-ESC "Alt+Tab" byte sequence was tried first and
 * decoded as garbage — `{name:"i", ctrl:true, meta:true}` — confirming
 * Alt+Tab is not a usable terminal keybinding here anyway, beyond it
 * being window-manager-captured on most desktops before a terminal ever
 * sees it). So both pairs are declared in {@link TAB_DEFAULT_KEYBINDINGS}:
 * Ctrl+Tab/Ctrl+Shift+Tab for a Kitty-capable terminal, Ctrl+PageDown/
 * Ctrl+PageUp as the reliable-everywhere alternate.
 *
 * **Ctrl+W is unambiguous everywhere**: a single control-byte combo
 * (`0x17`) with no shift dimension to lose, verified identical
 * `{name:"w", ctrl:true}` under both modes — exactly like `editor-core`'s
 * own `ctrl+s`/`ctrl+z`/`ctrl+d` bindings (that module's TSDoc's closing
 * paragraph), so `tab.close` binds it as its sole default with no
 * alternate needed.
 *
 * **`tab.closeOthers` has no default keybinding** — matches VS Code's own
 * `workbench.action.closeOtherEditors` (palette-only, no default chord in
 * VS Code either); this module still gives it `title`/`category` so it is
 * reachable from the command palette.
 *
 * **No `when` gating** on any of these — matches `explorer`'s
 * `ctrl+shift+e` and `command-palette`'s `ctrl+shift+p`/`ctrl+p`
 * (`explorer/manifest.ts`, `command-palette/manifest.ts`): tab switching
 * is meant to work from anywhere in the shell, the same "reach it no
 * matter what's focused" contract those two already establish, not scoped
 * to `editorTextFocus` the way `editor-core`'s own in-buffer bindings are.
 */

import type {
  CommandHandler,
  CommandMeta,
  Disposable,
  KeybindingContribution,
  QuickPickItem,
  QuickPickOptions,
  Uri,
} from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import type { DocumentManager } from "../buffer/documentManager";
import type { EditorSessionService } from "./editorSession";

/** Dependencies for {@link createTabCommandHandlers}/{@link registerTabCommands}. */
export interface TabCommandsDeps {
  /** Narrowed to exactly what this module needs — `documents.documents`
   * for tab order (Req 6.5), `close`/`save` for the dirty-close prompt. */
  documents: Pick<DocumentManager, "documents" | "close" | "save">;
  /** Narrowed to exactly what this module needs — see this module's TSDoc
   * on why `closeDocumentWithPrompt` never calls `setActiveDocumentUri`
   * itself (only `tab.next`/`tab.previous` do, to actually switch). */
  editorSession: Pick<EditorSessionService, "getActiveDocumentUri" | "setActiveDocumentUri">;
  /** The quick-pick surface (`@tecode/api`'s `WindowNamespace.
   * showQuickPick` shape), injected exactly like `themeSelectCommand.ts`'s
   * `ThemeSelectDeps.showQuickPick` — production wiring passes
   * `api.window.showQuickPick`. */
  showQuickPick: (
    items: QuickPickItem[],
    options?: QuickPickOptions,
  ) => Promise<QuickPickItem | undefined>;
  log?: HostLog;
}

/** Guarded `log.append` (matches every other module's `logSafely` —
 * `openFileCommand.ts`, `themeSelectCommand.ts`, `modalCommands.ts`'s
 * sibling modules). */
function logSafely(log: HostLog | undefined, level: "error" | "warning", err: HostError): void {
  if (!log) return;
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

export const TAB_NEXT_COMMAND = "tab.next";
export const TAB_PREVIOUS_COMMAND = "tab.previous";
export const TAB_CLOSE_COMMAND = "tab.close";
export const TAB_CLOSE_OTHERS_COMMAND = "tab.closeOthers";

/** {@link createCloseDocumentWithPrompt}'s outcome: `true` when `uri` ends
 * up NOT open any more (it was closed just now, or it was already not
 * open to begin with — a safe no-op) — `false` when the user cancelled
 * (Escape, or explicitly picking "Cancel") or a save failed, in which case
 * `uri` is still open and unchanged. `tab.closeOthers`'s loop uses this to
 * know when to abort the rest of the sequence (this module's TSDoc). */
export type CloseOutcome = boolean;

/**
 * Build the shared dirty-close-confirmation helper (Task 3.5's plan,
 * this module's TSDoc): `uri` not open → no-op, reports "closed" (nothing
 * to abort on). Not dirty → close directly. Dirty → `showQuickPick` with
 * Save/Discard/Cancel:
 *
 * - **Save** → `await documents.save(uri)`, then close ONLY if that
 *   resolved `true`; a `false` result or a thrown rejection aborts without
 *   closing (this module's TSDoc's "Save-failure safety").
 * - **Discard** → close without saving.
 * - **Cancel, Escape (`undefined`), or a throwing `showQuickPick`** → no
 *   side effects at all.
 *
 * Never calls `editorSession.setActiveDocumentUri` (this module's TSDoc).
 * Never throws.
 */
export function createCloseDocumentWithPrompt(
  deps: Pick<TabCommandsDeps, "documents" | "showQuickPick" | "log">,
): (uri: Uri) => Promise<CloseOutcome> {
  const { documents, log } = deps;

  return async function closeDocumentWithPrompt(uri: Uri): Promise<CloseOutcome> {
    const document = documents.documents.find((d) => d.uri === uri);
    if (!document) return true;

    if (!document.dirty) {
      documents.close(uri);
      return true;
    }

    const items: QuickPickItem[] = [
      { label: "Save", description: "save" },
      { label: "Discard", description: "discard" },
      { label: "Cancel", description: "cancel" },
    ];

    let picked: QuickPickItem | undefined;
    try {
      picked = await deps.showQuickPick(items, { placeHolder: `Save changes to "${uri}"?` });
    } catch (cause) {
      logSafely(log, "error", {
        message: `${TAB_CLOSE_COMMAND}: showQuickPick threw for "${uri}": ${describeError(cause)}`,
        path: uri,
      });
      return false;
    }

    if (!picked || picked.label === "Cancel") return false;

    if (picked.label === "Discard") {
      documents.close(uri);
      return true;
    }

    // Save.
    let saved: boolean;
    try {
      saved = await documents.save(uri);
    } catch (cause) {
      logSafely(log, "error", {
        message: `${TAB_CLOSE_COMMAND}: save threw for "${uri}", not closing: ${describeError(cause)}`,
        path: uri,
      });
      return false;
    }
    if (!saved) {
      logSafely(log, "warning", {
        message: `${TAB_CLOSE_COMMAND}: save failed for "${uri}", not closing (unsaved changes preserved).`,
        path: uri,
      });
      return false;
    }

    documents.close(uri);
    return true;
  };
}

/** The 4 `tab.*` command handlers (Task 3.5), independently callable for
 * tests (matches `openFileCommand.ts`'s `createOpenFileCommandHandler`/
 * `themeSelectCommand.ts`'s `createThemeSelectHandler` "build the handler,
 * separately from registering it" shape). */
export interface TabCommandHandlers {
  next: CommandHandler;
  previous: CommandHandler;
  close: CommandHandler;
  closeOthers: CommandHandler;
}

/**
 * Build all 4 `tab.*` handlers against `deps` (Task 3.5, this module's
 * TSDoc). `next`/`previous` cycle `documents.documents`' order (Req 6.5),
 * wrapping at both ends, and no-op when 1 or fewer documents are open —
 * including when nothing is open at all (`documents.documents.length ===
 * 0`), since there is then nothing to make active.
 */
export function createTabCommandHandlers(deps: TabCommandsDeps): TabCommandHandlers {
  const { documents, editorSession } = deps;
  const closeDocumentWithPrompt = createCloseDocumentWithPrompt(deps);

  function cycle(direction: 1 | -1): void {
    const open = documents.documents;
    if (open.length <= 1) return;
    const activeUri = editorSession.getActiveDocumentUri();
    const currentIndex = activeUri === undefined ? -1 : open.findIndex((d) => d.uri === activeUri);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (((baseIndex + direction) % open.length) + open.length) % open.length;
    editorSession.setActiveDocumentUri(open[nextIndex]!.uri);
  }

  const next: CommandHandler = async () => {
    cycle(1);
  };

  const previous: CommandHandler = async () => {
    cycle(-1);
  };

  const close: CommandHandler = async () => {
    const activeUri = editorSession.getActiveDocumentUri();
    if (activeUri === undefined) return;
    await closeDocumentWithPrompt(activeUri);
  };

  const closeOthers: CommandHandler = async () => {
    const activeUri = editorSession.getActiveDocumentUri();
    if (activeUri === undefined) return;
    // Snapshot the target uris up front, in document order — closes
    // mutate `documents.documents` as the loop runs, and this sequence
    // must visit "every OTHER tab as of when the command was invoked",
    // not whatever set happens to remain after each step.
    const others = documents.documents.filter((d) => d.uri !== activeUri).map((d) => d.uri);
    for (const uri of others) {
      const proceeded = await closeDocumentWithPrompt(uri);
      if (!proceeded) break;
    }
  };

  return { next, previous, close, closeOthers };
}

/** {@link TAB_NEXT_COMMAND}/{@link TAB_PREVIOUS_COMMAND}'s default
 * keybindings (VS Code-standard, verified as genuinely Kitty-only —
 * this module's TSDoc): reliable everywhere via {@link TAB_CLOSE_COMMAND}'s
 * `ctrl+w` (unambiguous) and the Ctrl+PageDown/Ctrl+PageUp alternates
 * (verified identical under both Kitty and legacy parsing). Key names
 * already in `keymap/normalize.ts`'s canonical form. No `when` (this
 * module's TSDoc's "No `when` gating"). Fed into `keymapState.ts`'s
 * `defaults` layer by `main.ts`, alongside `MODAL_DEFAULT_KEYBINDINGS`. */
export const TAB_DEFAULT_KEYBINDINGS: KeybindingContribution[] = [
  { key: "ctrl+tab", command: TAB_NEXT_COMMAND },
  { key: "ctrl+pagedown", command: TAB_NEXT_COMMAND },
  { key: "ctrl+shift+tab", command: TAB_PREVIOUS_COMMAND },
  { key: "ctrl+pageup", command: TAB_PREVIOUS_COMMAND },
  { key: "ctrl+w", command: TAB_CLOSE_COMMAND },
];

/** Narrow surface {@link registerTabCommands} needs from the core command
 * registry (matches `themeSelectCommand.ts`'s own `commands` parameter
 * shape, extended with the optional `meta` third argument
 * `CommandRegistry.register` already accepts). `registerCore`, not
 * `register` (Issue #72): reserves each `tab.*` id against extension
 * override. */
export interface TabCommandsRegistrar {
  registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
}

/**
 * Register the 4 `tab.*` commands (Task 3.5) directly on the core
 * `CommandRegistry` (this module's TSDoc). All 4 get `title`/`category` so
 * they show in the command palette (Task 3.5's plan). Returns one
 * {@link Disposable} that unregisters all 4 together, idempotent like
 * every other `Disposable` in this codebase.
 */
export function registerTabCommands(
  commands: TabCommandsRegistrar,
  deps: TabCommandsDeps,
): Disposable {
  const handlers = createTabCommandHandlers(deps);
  const category = "View";
  const disposables: Disposable[] = [
    commands.registerCore(TAB_NEXT_COMMAND, handlers.next, { title: "Next Editor", category }),
    commands.registerCore(TAB_PREVIOUS_COMMAND, handlers.previous, { title: "Previous Editor", category }),
    commands.registerCore(TAB_CLOSE_COMMAND, handlers.close, { title: "Close Editor", category }),
    commands.registerCore(TAB_CLOSE_OTHERS_COMMAND, handlers.closeOthers, {
      title: "Close Other Editors",
      category,
    }),
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
