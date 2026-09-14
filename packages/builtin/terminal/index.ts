/**
 * `tecode.terminal`'s `activate(ctx)`/`deactivate()` (Issue #98 Phase 4):
 * spawns/owns the pty session (`TerminalStore`, `./store.ts`), registers
 * `TerminalView` into `"panel.tab"` (`./TerminalView.tsx`), and implements
 * `terminal.focus`/`terminal.new` (`./manifest.ts`). Modeled on
 * `explorer/index.ts`'s "view + store" shape. Only imports `@tecode/api`
 * plus this package's own local `./manifest`/`./store`/`./TerminalView`
 * files (the ESLint layering rule) — every read/write goes through
 * `ctx.api`.
 *
 * **Windows degradation (Issue #98's own "Platform support" scope,
 * `@tecode/api`'s `TerminalNamespace.isSupported`'s TSDoc)**: `activate`
 * checks `api.terminal.isSupported()` FIRST, before building anything
 * else. `false` (Windows on a Bun below 1.3.14, the release that added
 * `Bun.Terminal`'s ConPTY backing — `@tecode/core`'s `platform.ts`'s
 * `supportsBunTerminal`): both commands are still registered — so they
 * remain discoverable in the command palette and reachable via
 * `commands.execute`, matching design choice 2 of this issue's plan — but
 * their handlers only report the platform limitation via `api.window.
 * showMessage(..., "error")` (this codebase's established extension-facing
 * error-surfacing channel — `explorer/index.ts`'s own create/rename/delete
 * failure handling uses the exact same call) and return; NEITHER the pty
 * session NOR the panel view is ever created. `activate` itself never
 * throws either way — Req 2.6's activation contract.
 *
 * **The default shell command**: `$SHELL`, falling back to `/bin/sh` —
 * the pty's `cwd` is left unset entirely, deferring to `PtySpawnOptions.
 * cwd`'s own documented default (the host process's own cwd, `@tecode/api`'s
 * TSDoc) rather than converting `api.workspace.rootUri` (a `file://` URI)
 * to a filesystem path by hand — that conversion (`pathToUri`/`uriToPath`)
 * is a `@tecode/core`-only utility this package may never import (the
 * layering rule), and tecode is, in practice, always launched FROM the
 * workspace root already, so the host's own cwd is already correct for
 * the common case.
 */

import type { ExtensionContext } from "@tecode/api";
import { createTerminalStore, type TerminalStore } from "./store";
import { createTerminalViewComponent } from "./TerminalView";
import { TERMINAL_FOCUS_COMMAND_ID, TERMINAL_NEW_COMMAND_ID, TERMINAL_VIEW_ID } from "./manifest";

/** The privileged bridge command `@tecode/core`'s `ui/panelCommands.ts`
 * registers directly on the core `CommandRegistry` (matches `explorer/
 * index.ts`'s own documented duplication of `OPEN_FILE_COMMAND_ID` —
 * `packages/builtin` may never import `@tecode/core`, so this string must
 * stay in sync with `@tecode/core`'s `SHOW_PANEL_COMMAND_ID` by hand). */
const SHOW_PANEL_COMMAND_ID = "workbench.action.showPanel";

/** Reported when a terminal command runs on an unsupported platform (Issue
 * #98's Windows degradation, this module's TSDoc). Exported for the test
 * that pins this exact message. */
export const TERMINAL_UNSUPPORTED_MESSAGE =
  "Integrated terminal is not supported here: Bun.Terminal needs Bun 1.3.14 or newer on Windows.";

/** Approximate initial pty size (this module's TSDoc's "the default shell
 * command" paragraph's sibling concern) — `TerminalGridView`'s own resize
 * effect (`@tecode/core`'s `terminalGridView.tsx`) corrects this against
 * the real panel dimensions the moment `TerminalView` first mounts;
 * matches `TerminalView.tsx`'s own `DEFAULT_COLS`/`DEFAULT_ROWS` fallback,
 * intentionally duplicated rather than shared — the two live in different
 * concerns (spawn-time vs. render-time defaults) that only coincidentally
 * agree today. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/**
 * Environment variables every shell this terminal spawns gets on top of
 * the host's own (Issue #158): the socket of the instance that owns this
 * terminal, plus that instance's pid.
 *
 * `TECODE_SOCK` is what makes a `tecode <file>` typed inside this terminal
 * open the file in the SURROUNDING editor instead of starting a second
 * full-screen TUI nested inside the pty — the CLI looks for exactly this
 * variable (`packages/cli`'s `ipcClient.ts`) and, finding it, delegates
 * and exits. `TECODE_PID` carries no behaviour; it is there so a user (or
 * a shell prompt) can tell WHICH instance a terminal belongs to.
 *
 * **`TECODE_SOCK` is always SET, even to the empty string** when this host
 * published no socket path (`ExtensionContext.ipcSocketPath`'s own TSDoc:
 * Windows, headless, or a socket that failed to open). Leaving it out
 * instead would let the variable be INHERITED: a `tecode --new-window`
 * launched from another instance's terminal runs with that instance's
 * `TECODE_SOCK` in its own environment, so its terminal's shells would
 * receive it too — and a `tecode <file>` typed in this window's terminal
 * would then open the file in the OTHER window, which is the exact
 * opposite of what `--new-window` was asked for. An empty value is what
 * `packages/cli`'s `resolveDelegateTarget` already treats as "no socket",
 * so it reliably means "this terminal belongs to an instance you cannot
 * delegate to" rather than "look at whatever the parent left behind".
 */
function ipcMarkerEnv(ctx: ExtensionContext): Record<string, string> {
  const socketPath = ctx.ipcSocketPath;
  return {
    TECODE_SOCK: socketPath !== undefined && socketPath.length > 0 ? socketPath : "",
    TECODE_PID: String(process.pid),
  };
}

/** The default shell to spawn (this module's TSDoc). */
function defaultShellCmd(): string[] {
  const shell = process.env["SHELL"];
  return [shell && shell.length > 0 ? shell : "/bin/sh"];
}

/** Registers both commands as platform-limitation reporters (Windows —
 * this module's TSDoc). Never throws: `api.window.showMessage` is itself
 * documented never-throwing (`windowMessageService.ts`). */
function registerUnsupportedCommands(ctx: ExtensionContext): void {
  const { api } = ctx;
  function reportUnsupported(): void {
    api.window.showMessage(TERMINAL_UNSUPPORTED_MESSAGE, "error");
  }
  ctx.subscriptions.push(api.commands.register(TERMINAL_FOCUS_COMMAND_ID, reportUnsupported));
  ctx.subscriptions.push(api.commands.register(TERMINAL_NEW_COMMAND_ID, reportUnsupported));
}

/** Registers `terminal.focus`/`terminal.new` against a real, live {@link
 * TerminalStore} (the supported-platform path). Both commands show the
 * panel (`SHOW_PANEL_COMMAND_ID`) then request focus (`store.
 * requestFocus`, `store.ts`'s own "pending, consumed on next mount"
 * TSDoc) — the ordering matters: `Panel` (`@tecode/core`'s `shell.tsx`)
 * only mounts `TerminalView` once `layoutState.panelVisible` is true, so
 * `requestFocus()` must run AFTER the show-panel command has had a chance
 * to flip that, even though (being merely "pending" until a handle
 * registers) the actual ordering of these two calls does not change the
 * OUTCOME — it is still correct here for clarity. */
function registerSupportedCommands(ctx: ExtensionContext, store: TerminalStore): void {
  const { api } = ctx;

  async function showAndFocus(): Promise<void> {
    await api.commands.execute(SHOW_PANEL_COMMAND_ID);
    store.requestFocus();
  }

  ctx.subscriptions.push(
    api.commands.register(TERMINAL_FOCUS_COMMAND_ID, async () => {
      store.ensureSession();
      await showAndFocus();
    }),
  );
  ctx.subscriptions.push(
    api.commands.register(TERMINAL_NEW_COMMAND_ID, async () => {
      store.respawn();
      await showAndFocus();
    }),
  );
}

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;

  if (!api.terminal.isSupported()) {
    registerUnsupportedCommands(ctx);
    return;
  }

  const store = createTerminalStore({
    spawn: (options) => api.terminal.spawn(options),
    cmd: defaultShellCmd(),
    initialCols: INITIAL_COLS,
    initialRows: INITIAL_ROWS,
    env: ipcMarkerEnv(ctx),
  });
  ctx.subscriptions.push({ dispose: () => store.dispose() });

  ctx.subscriptions.push(
    api.ui.registerView(
      "panel.tab",
      TERMINAL_VIEW_ID,
      createTerminalViewComponent({ store, Terminal: api.ui.Terminal }),
    ),
  );

  registerSupportedCommands(ctx, store);
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
