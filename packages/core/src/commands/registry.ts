/**
 * The command registry (Req 3, design.md §5): a `Map<string, CommandEntry>`
 * backing `tecode.commands`. All cross-module behavior in tecode — key
 * bindings, the palette, UI callbacks, extension-to-extension calls — goes
 * through `execute` rather than a direct function call (Req 1.5).
 *
 * Lazy (manifest-declared, not-yet-activated) commands are out of scope
 * here — they arrive with the extension host task (design.md §4.1's
 * "lazy commands"); `CommandEntry` therefore carries no `lazy` flag.
 */

import type {
  CommandDescriptor,
  CommandHandler,
  CommandMeta,
  Disposable,
} from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";

/** Internal registry state for one registered command. */
interface CommandEntry {
  handler: CommandHandler;
  meta: CommandMeta;
}

/** Dependencies a {@link createCommandRegistry} instance reports through
 * rather than owning directly (design.md §5, §14). */
export interface CommandRegistryDeps {
  /** Structured log for warnings (duplicate registration) and errors
   * (handler exceptions). */
  log: HostLog;
  /** Where user-facing command errors are surfaced (Req 3.4, 3.5). */
  sink: StatusSink;
}

/** The public shape of the command registry — the implementation behind
 * `tecode.commands` (Req 10.1). */
export interface CommandRegistry {
  register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  list(): CommandDescriptor[];
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (e.g. a throwing `toString`, or an `Error` subclass whose
 * `message` getter throws). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Whether `id` follows the `namespace.verb` convention (Req 3.2): two or
 * more non-empty, whitespace-free segments separated by dots (e.g.
 * `editor.action.deleteLine`). Shared so manifest validation can reuse it.
 */
export function isValidCommandId(id: string): boolean {
  return /^[^\s.]+(\.[^\s.]+)+$/.test(id);
}

/**
 * Build a command registry (Req 3.1). `register`/`execute`/`list` are the
 * exact operations `tecode.commands` exposes to extensions; `deps` lets the
 * host inject the shared {@link HostLog} and {@link StatusSink} rather than
 * the registry owning them.
 */
export function createCommandRegistry(deps: CommandRegistryDeps): CommandRegistry {
  const { log, sink } = deps;
  const commands = new Map<string, CommandEntry>();

  /** Guarded `log.append` — an injected log must not be able to break the
   * registry's error paths (execute's never-throwing contract). */
  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  /** Guarded `sink.error` — same rationale as {@link logSafely}. */
  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed: preserve execute()'s never-throwing contract.
    }
  }

  function register(
    id: string,
    handler: CommandHandler,
    meta: CommandMeta = {},
  ): Disposable {
    if (!isValidCommandId(id)) {
      throw new TypeError(
        `Invalid command ID "${id}": expected namespace.verb form (Req 3.2)`,
      );
    }
    if (commands.has(id)) {
      logSafely("warning", {
        message: `Command re-registered, replacing previous handler: ${id}`,
      });
    }
    const entry: CommandEntry = { handler, meta };
    commands.set(id, entry);

    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        // Only remove if this registration is still the current one —
        // re-registration (last-wins) or a prior dispose may have already
        // replaced/removed it, and this dispose must be a no-op then.
        if (commands.get(id) === entry) {
          commands.delete(id);
        }
      },
    };
  }

  async function execute(id: string, ...args: unknown[]): Promise<unknown> {
    const entry = commands.get(id);
    if (!entry) {
      const err: HostError = { message: `Command not found: ${id}` };
      notifySafely(err);
      return undefined;
    }
    try {
      return await entry.handler(...args);
    } catch (cause: unknown) {
      const err: HostError = {
        message: `Command "${id}" threw: ${describeError(cause)}`,
      };
      logSafely("error", err);
      notifySafely(err);
      return undefined;
    }
  }

  function list(): CommandDescriptor[] {
    return Array.from(commands.entries()).map(([id, entry]) => ({
      id,
      title: entry.meta.title,
      category: entry.meta.category,
      when: entry.meta.when,
    }));
  }

  return { register, execute, list };
}
