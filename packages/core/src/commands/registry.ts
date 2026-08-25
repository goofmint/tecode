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
   *
   * Re-entrancy contract: the implementation must resolve immediately for
   * a call re-entering an activation already in progress on the current
   * async path — an extension executing its own still-lazy command from
   * inside `activate(ctx)`, or a mutual activation cycle. `execute()`
   * keeps no re-entrancy state of its own, so an implementation that
   * hands back its own in-flight activation promise here deadlocks
   * (`createExtensionHost` satisfies this via its activation context).
   */
  activateExtension?: (extensionId: string) => Promise<void>;
}

/** The public shape of the command registry — the implementation behind
 * `tecode.commands` (Req 10.1), plus `registerLazy` (design.md §4.1) and
 * `registerCore` (Issue #72), both of which are host-internal (extensions
 * never call either directly; the `tecode` API surface handed to
 * extensions exposes only `register`/`execute`/`list` — see
 * `api/create.ts`'s `commandsNamespace`). */
export interface CommandRegistry {
  /**
   * Register a command as `tecode.commands.register` does for an
   * extension (Req 3.1, 3.2). Rejects (see this interface's
   * {@link registerCore} TSDoc for the asymmetry with the `isValidCommandId`
   * check below) an id reserved by {@link registerCore} — Issue #72's fix
   * for the pre-fix behavior where any extension could silently take over
   * a core-owned command id (last-wins `storeEntry`, no id policy at all):
   * a reserved id instead logs an error and notifies `sink`, then returns
   * a no-op {@link Disposable}, WITHOUT registering anything and WITHOUT
   * throwing — a malformed extension manifest/`activate(ctx)` must not
   * crash the whole extension over a naming collision it didn't cause.
   */
  register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
  /**
   * Register a command declared in a manifest's `contributes.commands`
   * without a handler yet (design.md §4.1, §5): the command appears in
   * {@link list} and can be looked up by keybindings/the palette
   * immediately, but `execute`-ing it before the owning extension has
   * activated reports a "not activated yet" error rather than running
   * anything. Same last-wins/duplicate-warning/`Disposable` semantics as
   * {@link register} — including the same reserved-id rejection (Issue
   * #72): `host/registration.ts` walks `contributes.commands` straight
   * into this method, so an extension manifest declaring
   * `{ "id": "tab.close" }` reaches `registerCore`'s reservation exactly
   * the same way a runtime `tecode.commands.register("tab.close", ...)`
   * call would — both paths must reject, not just `register`.
   */
  registerLazy(id: string, options: RegisterLazyOptions): Disposable;
  /**
   * Host-internal third registration method (Issue #72): registers exactly
   * like {@link register} (Req 3.1, 3.2 — same `namespace.verb` id
   * validation, same last-wins-with-warning behavior for two `registerCore`
   * calls under the same id) AND marks `id` reserved, so every subsequent
   * `register`/`registerLazy` call under that id — from an extension, via
   * either the runtime `tecode.commands.register` or a manifest's
   * `contributes.commands` — is rejected instead of silently replacing the
   * core handler.
   *
   * **Structurally unreachable from extensions**: `api/create.ts` builds
   * the frozen `tecode.commands` namespace by naming only
   * `register`/`execute`/`list` off this registry — `registerCore` (like
   * `registerLazy`) is simply never copied onto that object, so no
   * extension can reach it even indirectly. Only composition-root code
   * (`cli/main.ts`'s `buildAssemblyRoot`, registering the 6 core command
   * modules under `ui/`) ever calls this method, ahead of
   * `runDeferredPhase`'s `loadExtensions` call — see `main.ts`'s own
   * assembly-order TSDoc/tests for why that ordering is what makes the
   * reservation effective against every extension, not just ones loaded
   * later.
   *
   * **Malformed id still throws, unlike a reserved-id collision**: an
   * invalid `namespace.verb` id passed to `registerCore` is a programming
   * error in THIS codebase's own core command modules (never an
   * extension's fault, since extensions cannot reach this method at all),
   * so it keeps {@link register}'s existing `TypeError`-throwing behavior
   * — there is no third-party `activate(ctx)` call on the stack here to
   * protect from a crash.
   *
   * **Dispose clears the reservation**: disposing a `registerCore`
   * registration also removes `id` from the reserved set (only when that
   * dispose call actually removes the CURRENT entry — a stale
   * `Disposable` from a registration a later `registerCore`/`register`
   * call already superseded is a no-op for both the entry and the
   * reservation, mirroring {@link register}'s existing entry-identity
   * dispose guard). Rationale: a disposed core command no longer exists,
   * so nothing is left to protect — the id becomes an ordinary, available
   * `namespace.verb` string again, registrable by anyone (matches this
   * registry's existing "dispose really means gone" contract elsewhere).
   */
  registerCore(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
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
  // Ids reserved by registerCore (Issue #72) — checked by register/
  // registerLazy before they ever touch `commands` or `storeEntry`.
  const reserved = new Set<string>();

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

  /** A `Disposable` whose `dispose()` does nothing — returned by
   * `register`/`registerLazy` for a rejected, reserved id (Issue #72):
   * nothing was ever stored, so there is nothing to remove, but the
   * caller still gets a real `Disposable` to push onto `ctx.subscriptions`
   * without a type-check special case. */
  function noopDisposable(): Disposable {
    return {
      dispose() {
        // Intentionally does nothing — see this function's TSDoc.
      },
    };
  }

  /** Shared last-wins storage behind {@link register}, {@link registerLazy},
   * and {@link registerCore}: warns on an existing entry under `id`, stores
   * `entry`, and returns the identity-checked `Disposable` common to all
   * three (mirrors the entry-identity comparison design.md §5 relies on so
   * a stale handle from a superseded registration never removes a newer
   * one). `onRemoved`, when given, fires exactly when THIS dispose call
   * actually removes the current entry (Issue #72's `registerCore`: a
   * stale/already-superseded dispose is a no-op for the reservation too,
   * not just the entry). */
  function storeEntry(id: string, entry: CommandEntry, onRemoved?: () => void): Disposable {
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
          onRemoved?.();
        }
      },
    };
  }

  /** Reject `id` for an extension-facing {@link register}/
   * {@link registerLazy} call: reports through both `log` and `sink`
   * (Issue #72's "policy rejection, not a crash" — see
   * {@link CommandRegistry.register}'s TSDoc) and returns
   * {@link noopDisposable}. `extensionId`, when known (a `registerLazy`
   * caller's {@link RegisterLazyOptions.extensionId}), is attributed on the
   * reported {@link HostError} so a misbehaving extension is identifiable
   * from the log/status bar, matching every other extension-attributed
   * `HostError` in this module.
   *
   * Logged at `"error"`, not `"warning"`: this matches
   * `host/registration.ts`'s `reportSkip`, which reports a refused
   * extension with `logSafely(deps.log, "error", err)` + `notifySafely`. A
   * reserved-id rejection means the extension's command does not exist —
   * the same class of outcome as a skipped extension — unlike
   * {@link storeEntry}'s "Command re-registered, replacing previous
   * handler" notice, which stays `"warning"` because the command still
   * works there; only this rejection path changes. */
  function rejectReserved(id: string, extensionId?: string): Disposable {
    const err: HostError = {
      message: `Command "${id}" is reserved for core and cannot be registered by an extension.`,
      ...(extensionId !== undefined ? { extensionId } : {}),
    };
    logSafely("error", err);
    notifySafely(err);
    return noopDisposable();
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
    if (reserved.has(id)) {
      return rejectReserved(id);
    }
    return storeEntry(id, { handler, meta, lazy: false });
  }

  function registerLazy(id: string, options: RegisterLazyOptions): Disposable {
    if (!isValidCommandId(id)) {
      throw new TypeError(
        `Invalid command ID "${id}": expected namespace.verb form (Req 3.2)`,
      );
    }
    if (reserved.has(id)) {
      return rejectReserved(id, options.extensionId);
    }
    return storeEntry(id, {
      meta: options.meta ?? {},
      extensionId: options.extensionId,
      lazy: true,
    });
  }

  function registerCore(
    id: string,
    handler: CommandHandler,
    meta: CommandMeta = {},
  ): Disposable {
    if (!isValidCommandId(id)) {
      throw new TypeError(
        `Invalid command ID "${id}": expected namespace.verb form (Req 3.2)`,
      );
    }
    reserved.add(id);
    return storeEntry(id, { handler, meta, lazy: false }, () => reserved.delete(id));
  }

  async function execute(id: string, ...args: unknown[]): Promise<unknown> {
    let entry = commands.get(id);

    if (entry && !entry.handler && entry.extensionId && activateExtension) {
      // Lazy, not-yet-activated command (design.md §4.1, §4.2) — activate
      // its owning extension, then re-look-up: activation is expected to
      // replace this entry with a real handler via register() (Task 1.12).
      // Concurrent execute() calls all await here and share the host's
      // in-flight activation; the one case that must NOT wait — the
      // extension executing its own still-lazy command from inside its own
      // activate(ctx), which would deadlock on its own activation promise —
      // is detected host-side (host/activation.ts's activation context) and
      // resolves immediately, landing on the not-activated error path below.
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

  return { register, registerLazy, registerCore, execute, list };
}
