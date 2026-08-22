/**
 * The command registry (Req 3, design.md §5): a `Map<string, CommandEntry>`
 * backing `tecode.commands`. All cross-module behavior in tecode — key
 * bindings, the palette, UI callbacks, extension-to-extension calls — goes
 * through `execute` rather than a direct function call (Req 1.5).
 *
 * Lazy (manifest-declared, not-yet-activated) commands (design.md §4.1's
 * "lazy commands", §5's `CommandEntry = { handler?, meta, extensionId?,
 * lazy }`) are registered via {@link CommandRegistry.registerLazy} by the
 * extension host (`host/registration.ts`) with no `handler` yet. Real
 * activation (Task 1.12, `host/activation.ts`) is wired in via
 * {@link CommandRegistryDeps.activateExtension}: `execute()` on an
 * unresolved lazy command awaits that hook (activating the owning
 * extension) and re-dispatches before falling back to the "not activated
 * yet" `HostError` reported through `log`/`sink` — never throwing or
 * silently no-op'ing either way.
 */

import type {
  CommandDescriptor,
  CommandHandler,
  CommandMeta,
  Disposable,
} from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";

/** Internal registry state for one registered command (design.md §5).
 * `handler` is absent for a lazy (manifest-declared, not-yet-activated)
 * command; `extensionId` is set only for lazy entries — a plain
 * `register()` call has no extension attribution. */
interface CommandEntry {
  handler?: CommandHandler;
  meta: CommandMeta;
  extensionId?: string;
  lazy: boolean;
  /** True while `execute()` is awaiting this entry's owning extension's
   * activation. Guards re-entrancy: an extension whose `activate(ctx)`
   * executes its own still-lazy command would otherwise `await` its own
   * in-flight activation promise and deadlock — with the marker set, the
   * recursive call falls through to the not-activated error path instead. */
  activating?: boolean;
}

/** Options for {@link CommandRegistry.registerLazy}. */
export interface RegisterLazyOptions {
  /** The extension whose `index.ts` owns this command, activated on first
   * `execute()` once Task 1.12 wires real activation. */
  extensionId: string;
  meta?: CommandMeta;
}

/** Dependencies a {@link createCommandRegistry} instance reports through
 * rather than owning directly (design.md §5, §14). */
export interface CommandRegistryDeps {
  /** Structured log for warnings (duplicate registration) and errors
   * (handler exceptions). */
  log: HostLog;
  /** Where user-facing command errors are surfaced (Req 3.4, 3.5). */
  sink: StatusSink;
  /**
   * Activate the extension owning an unresolved lazy command before
   * re-dispatching (Req 2.5, design.md §4.2's "executing a lazy command
   * activates the extension first, then re-dispatches"). Supplied by
   * `host/activation.ts`'s `createExtensionHost(...).activateExtension` at
   * the assembly layer — see that module's TSDoc for the construction
   * order. Optional so `registry.ts` has no hard dependency on the
   * extension host: omitted (as in every registry.test.ts case with no
   * host in the picture), `execute()` falls straight to the existing "not
   * activated yet" error path, unchanged from Task 1.11's behavior.
   * Documented to never throw/reject (matching `activateExtension`'s own
   * contract); `execute()` guards the call anyway so a misbehaving
   * implementation can't break its own never-throwing contract.
   */
  activateExtension?: (extensionId: string) => Promise<void>;
}

/** The public shape of the command registry — the implementation behind
 * `tecode.commands` (Req 10.1), plus `registerLazy` (design.md §4.1),
 * which is host-internal (extensions never call it directly; the `tecode`
 * API surface handed to extensions exposes only `register`). */
export interface CommandRegistry {
  register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
  /**
   * Register a command declared in a manifest's `contributes.commands`
   * without a handler yet (design.md §4.1, §5): the command appears in
   * {@link list} and can be looked up by keybindings/the palette
   * immediately, but `execute`-ing it before the owning extension has
   * activated reports a "not activated yet" error rather than running
   * anything. Same last-wins/duplicate-warning/`Disposable` semantics as
   * {@link register}.
   */
  registerLazy(id: string, options: RegisterLazyOptions): Disposable;
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
  const { log, sink, activateExtension } = deps;
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

  /** Shared last-wins storage behind both {@link register} and
   * {@link registerLazy}: warns on an existing entry under `id`, stores
   * `entry`, and returns the identity-checked `Disposable` common to both
   * (mirrors the entry-identity comparison design.md §5 relies on so a
   * stale handle from a superseded registration never removes a newer
   * one). */
  function storeEntry(id: string, entry: CommandEntry): Disposable {
    if (commands.has(id)) {
      logSafely("warning", {
        message: `Command re-registered, replacing previous handler: ${id}`,
      });
    }
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
    return storeEntry(id, { handler, meta, lazy: false });
  }

  function registerLazy(id: string, options: RegisterLazyOptions): Disposable {
    if (!isValidCommandId(id)) {
      throw new TypeError(
        `Invalid command ID "${id}": expected namespace.verb form (Req 3.2)`,
      );
    }
    return storeEntry(id, {
      meta: options.meta ?? {},
      extensionId: options.extensionId,
      lazy: true,
    });
  }

  async function execute(id: string, ...args: unknown[]): Promise<unknown> {
    let entry = commands.get(id);

    if (entry && !entry.handler && entry.extensionId && activateExtension && !entry.activating) {
      // Lazy, not-yet-activated command (design.md §4.1, §4.2) — activate
      // its owning extension, then re-look-up: activation is expected to
      // replace this entry with a real handler via register() (Task 1.12).
      // `activating` (see CommandEntry) keeps a recursive execute() from
      // inside that same activation from deadlocking on its own promise.
      entry.activating = true;
      try {
        await activateExtension(entry.extensionId);
      } catch (cause) {
        // activateExtension is documented to never throw/reject; guard
        // anyway so a misbehaving host implementation can't break
        // execute()'s own never-throwing contract.
        logSafely("error", {
          extensionId: entry.extensionId,
          message: `activateExtension("${entry.extensionId}") threw: ${describeError(cause)}`,
        });
      } finally {
        // Clear on the ORIGINAL entry (activation may have replaced it in
        // the map): once activation has settled, future execute() calls may
        // legitimately retry the hook (it no-ops fast for active/failed
        // extensions).
        entry.activating = false;
      }
      entry = commands.get(id);
    }

    if (!entry) {
      const err: HostError = { message: `Command not found: ${id}` };
      notifySafely(err);
      return undefined;
    }
    if (!entry.handler) {
      // Still lazy after the activation attempt above (no hook wired, the
      // entry carried no extensionId, or activation ran but the extension
      // never registered a real handler for this ID — including a
      // "failed" activation, design.md §4.2) — report and stop, never
      // throw.
      const err: HostError = {
        message:
          `Command "${id}" belongs to extension "${entry.extensionId ?? "unknown"}", ` +
          `which has not activated yet`,
        extensionId: entry.extensionId,
      };
      logSafely("warning", err);
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

  return { register, registerLazy, execute, list };
}
