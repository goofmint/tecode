/**
 * The `extensions.reload` command (Req 2.8, design.md §4.4's "MVP
 * implementation re-execs the process (`Bun.spawn` of `process.execPath`
 * with the same argv, then exit) after persisting layout state."):
 * `requirements.md`'s Req 2.8 only asks that reloading extensions be
 * observable — "in the MVP a full application restart is an acceptable
 * implementation" — so this command's entire job is to persist whatever
 * would otherwise be lost across that restart, then hand off to a fresh
 * process that re-runs the exact same startup sequence discovery already
 * follows (Req 2.1's `builtin/` → user → workspace order), picking up any
 * extension that changed on disk since this process started.
 *
 * **Registered directly on the core `CommandRegistry`, not through the
 * extension API** (same privilege-boundary reasoning as `theme.select`
 * (`ui/themeSelectCommand.ts`'s TSDoc) and `workbench.action.files.
 * openUri` (`ui/openFileCommand.ts`'s TSDoc)): re-executing the whole
 * process is not a capability `@tecode/api` exposes to extensions at all —
 * `tecode.commands.register("extensions.reload", ...)` from an extension
 * would just replace this handler (last-wins, `commands/registry.ts`'s
 * `storeEntry`), so the real implementation has to be composition-root
 * code (`main.ts`) wiring a privileged `reExec` closure in here, exactly
 * the same shape `theme.select`'s `ThemeService`/`openUri`'s
 * `EditorSessionService` closures take.
 *
 * **`layoutState.flush()` strictly before `reExec()`, and `reExec()` is
 * skipped entirely on a `flush()` failure**: the whole point of this
 * command is that the NEXT process should look like the current one did —
 * `layoutState`'s debounced writes (`ui/layoutState.ts`'s TSDoc) may not
 * have reached disk yet when the user triggers a reload, so `flush()`
 * (which cancels any pending debounce timer and writes the latest
 * in-memory state immediately, `LayoutStateService.flush`'s own TSDoc) has
 * to complete first. A `flush()` that fails (a write error `layoutState`
 * itself already reported through its own `log`/`sink` — this module adds
 * its own log entry on top so `extensions.reload`'s own failure is
 * distinguishable from an ordinary debounced write's) means the new
 * process would start from STALE `state.json` — re-execing anyway would
 * silently discard whatever layout changes the user made this session,
 * which is worse than a reload that visibly does nothing, so this handler
 * stops there instead.
 *
 * **`reExec` is injected, not `Bun.spawn` called here directly**: keeps
 * this module (like every other `ui/*Command.ts`) testable with a plain
 * fake instead of actually spawning a subprocess and exiting the test
 * runner — the real `Bun.spawn(process.execPath, ...) `+`process.exit(0)`
 * closure is `main.ts`'s composition-root job (that module's own TSDoc
 * documents the `bun build --compile` `process.argv` caveat this command
 * has no visibility into).
 */

import type { CommandHandler, CommandMeta, Disposable } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import type { LayoutStateService } from "./layoutState";

/** Dependencies for {@link createExtensionsReloadHandler}. */
export interface ExtensionsReloadDeps {
  /** Persists any not-yet-written layout state before the process re-execs
   * (this module's TSDoc) — narrowed to `flush`, the only method this
   * command needs. */
  layoutState: Pick<LayoutStateService, "flush">;
  /** Re-executes the process with the same argv and exits the current one
   * (design.md §4.4) — injected so this module never calls `Bun.spawn`/
   * `process.exit` itself (this module's TSDoc). Documented to never
   * throw synchronously in normal operation, but guarded below anyway,
   * matching this codebase's "an injected dependency must not break a
   * never-throwing handler" convention (`themeSelectCommand.ts`'s
   * `showQuickPick`, `openFileCommand.ts`'s `documents`/`editorSession`). */
  reExec: () => void;
  log?: HostLog;
}

/** Guarded `log.append` (matches every other module's `logSafely` —
 * `themeSelectCommand.ts`, `openFileCommand.ts`, `modalCommands.ts`'s
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

/** Command id this module registers (this module's TSDoc, Req 2.8).
 * Exported so callers (a future palette entry, tests) reference the same
 * string rather than re-typing it. */
export const EXTENSIONS_RELOAD_COMMAND_ID = "extensions.reload";

/**
 * Build the `extensions.reload` handler (Req 2.8, design.md §4.4). Awaits
 * `deps.layoutState.flush()` first; only calls `deps.reExec()` once that
 * settles successfully — a rejecting (or throwing) `flush()` is logged as
 * an error and the handler returns without re-executing (this module's
 * TSDoc). Never throws — matches `CommandRegistry.execute`'s
 * never-throwing contract, and every other command handler in this
 * codebase.
 */
export function createExtensionsReloadHandler(deps: ExtensionsReloadDeps): CommandHandler {
  return async () => {
    try {
      await deps.layoutState.flush();
    } catch (cause) {
      logSafely(deps.log, "error", {
        message: `${EXTENSIONS_RELOAD_COMMAND_ID}: flush failed: ${describeError(cause)}`,
      });
      return;
    }

    try {
      deps.reExec();
    } catch (cause) {
      logSafely(deps.log, "error", {
        message: `${EXTENSIONS_RELOAD_COMMAND_ID}: reExec failed: ${describeError(cause)}`,
      });
    }
  };
}

/** Register {@link createExtensionsReloadHandler}'s handler as
 * `"extensions.reload"` on the core `CommandRegistry` (this module's
 * TSDoc — a direct `commands.register` call, not routed through
 * `tecode.commands`, for the same privilege-boundary reason
 * `registerThemeSelectCommand`/`registerOpenFileCommand` document). */
export function registerExtensionsReloadCommand(
  commands: { register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable },
  deps: ExtensionsReloadDeps,
): Disposable {
  return commands.register(EXTENSIONS_RELOAD_COMMAND_ID, createExtensionsReloadHandler(deps), {
    title: "Reload Window",
    category: "Extensions",
  });
}
