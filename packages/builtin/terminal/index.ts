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
