/**
 * Extension activation and the extension context (Req 2.5, 2.6, design.md
 * §4.2). Discovery/validation/registration (Task 1.11, `discovery.ts`/
 * `validate.ts`/`registration.ts`) get a manifest's declared contributions
 * into the various registries without ever running `index.ts`; this module
 * is what finally runs it, exactly once, when one of an extension's
 * `activationEvents` fires:
 *
 * - `onStartup` — {@link ExtensionHost.activateStartupExtensions}, called by
 *   the CLI after the first frame (Task 1.15).
 * - `onCommand:<id>` — handled entirely on the command-registry side
 *   (`commands/registry.ts`'s `execute`): a lazy `CommandEntry` already
 *   carries the owning `extensionId` (set by `registerExtension` at
 *   registration time), so `execute` calls {@link ExtensionHost.activateExtension}
 *   directly with that ID and re-dispatches — this module does not need to
 *   inspect `activationEvents` strings for that path at all.
 * - `onLanguage:<id>` — {@link ExtensionHost.onLanguage}, shaped as a plain
 *   synchronous `(languageId: string) => void` so it can be handed straight
 *   to `DocumentManagerDeps.onLanguageActivation` (`buffer/documentManager.ts`,
 *   unchanged by this task) at the assembly layer.
 *
 * **No dynamic `import()` here.** `discovery.ts`'s `importManifestModule` is
 * the one sanctioned dynamic-import call site in `core`, and it only ever
 * loads a `manifest.ts`/`.js` — never an extension's `index.ts`. Loading an
 * extension's actual implementation module is this module's job, but the
 * *how* (a real `import()` of a resolved file path, wrapped for the
 * compiled-binary case per design.md §4.4) is injected via
 * {@link ExtensionRecord.loadModule} rather than performed here — production
 * wiring of that closure is the later API-assembly task (1.13), which is
 * also where {@link ExtensionRecord}s are actually built from
 * `LoadedExtension`s (`registration.ts`). This keeps activation.ts testable
 * with plain in-memory fixtures and keeps the dynamic-import surface of
 * `core` exactly as small as `discovery.ts` already documents.
 */

import type { Disposable, ExtensionContext, Manifest, Tecode } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "./errors";

/**
 * One extension the runtime can activate — the shape {@link createExtensionHost}
 * consumes, built at the assembly layer (Task 1.13) from a `LoadedExtension`
 * (`registration.ts`) plus a real module loader. Defined here (rather than
 * in `registration.ts`/Task 1.11) because activation is the first task that
 * needs a *loadable* extension, not just a *registered* one.
 */
export interface ExtensionRecord {
  /** The validated `manifest.id` (Req 2.3) — matches `LoadedExtension.extensionId`. */
  id: string;
  manifest: Manifest;
  /** The extension's own directory, as an `ExtensionContext.extensionUri`. */
  extensionUri: string;
  /** A per-extension directory for `ExtensionContext.storagePath`. */
  storagePath: string;
  /**
   * Loads the extension's implementation module. Production callers close
   * over a real `import()` of the resolved `index.ts`/`.js` (design.md
   * §4.4: built-ins as static imports wrapped in a closure, external
   * extensions via `import(pathToFileURL(file).href)`); tests close over an
   * in-memory fixture object instead. Called at most once per extension —
   * {@link createExtensionHost}'s activation-exactly-once guarantee means a
   * second `activateExtension` call for the same ID never re-invokes this.
   */
  loadModule(): Promise<unknown>;
}

/**
 * The shape an extension's implementation module is expected to have (Req
 * 2.6). `@tecode/api` declares no runtime type for this — extension authors
 * write plain functions, not something importable as a type — so it is
 * defined here instead, structurally compatible with a module namespace
 * object (`export function activate(ctx) {...}`).
 */
export interface ExtensionModule {
  activate?(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * One extension's activation state (Req 2.5, 2.6): every extension starts
 * `"registered"` (contributions are live, `index.ts` has not run);
 * `"active"` once `activate(ctx)` has run without throwing (or the module
 * exports no `activate` at all — see {@link ExtensionHost.activateExtension}'s
 * TSDoc); `"failed"` if loading the module or running `activate(ctx)` threw
 * or rejected. Both `"active"` and `"failed"` are terminal until an explicit
 * {@link ExtensionHost.deactivateExtension} returns the extension to
 * `"registered"` — activation events are is-a-no-op once past `"registered"`,
 * which is what makes "each event activates exactly once" (Req 2.5) hold
 * regardless of how many activation events subsequently fire for the same
 * extension.
 */
export type ActivationState = "registered" | "active" | "failed";

/** Dependencies {@link createExtensionHost} needs. */
export interface ExtensionHostDeps {
  /** Every extension the host may be asked to activate — built once at
   * startup from Task 1.11's `LoadExtensionsResult.loaded` (a later task's
   * wiring; this module only consumes the array). */
  extensions: ExtensionRecord[];
  /** The live `tecode` API object handed to every extension's `activate(ctx)`
   * (Req 1.4, 2.6) — identical for every extension, built once by the
   * API-assembly task (1.13). */
  api: Tecode;
  log: HostLog;
  sink: StatusSink;
}

/**
 * The extension host's public surface (design.md §4.2). Deliberately not
 * named `ExtensionHost` in a way that implies it owns discovery/registration
 * too — those stay `discovery.ts`/`registration.ts`'s job; this is purely
 * the activation lifecycle layered on top of an already-registered set of
 * extensions.
 */
export interface ExtensionHost {
  /**
   * Activate one extension by ID, exactly once (Req 2.5). A no-op — resolves
   * immediately, does nothing — when `id` is unknown or the extension is
   * already `"active"`/`"failed"`. Concurrent calls for the same
   * not-yet-activated extension (e.g. two documents of the same language
   * opening back to back before the first activation settles) share one
   * in-flight activation rather than running `activate(ctx)` twice.
   *
   * Never throws or rejects (Req 2.4-style never-throwing boundary, matching
   * `registry.ts`/`registration.ts`): a failure loading the module or
   * running `activate(ctx)` is caught, reported through `log`/`sink` as a
   * {@link HostError}, and leaves the extension `"failed"` — its
   * already-registered contributions (commands, views, ...) stay registered
   * (Req 2.4's "continue starting up" spirit applied to one extension), and
   * no other extension is affected.
   */
  activateExtension(id: string): Promise<void>;
  /**
   * Deactivate one active extension (Req 2.6): disposes its
   * `ExtensionContext.subscriptions` in reverse push order (each `dispose()`
   * individually guarded — one throwing disposable does not stop the rest),
   * then calls its module's `deactivate()` if exported (also guarded).
   * A no-op for an extension that is not currently `"active"`
   * (idempotent — calling this twice in a row only disposes once).
   *
   * After deactivation the extension's state returns to `"registered"`
   * rather than some fourth "deactivated" state — deliberately, so that a
   * subsequent activation event (e.g. after `extensions.reload`-style
   * re-registration in a future task) can activate it again. Never throws.
   */
  deactivateExtension(id: string): Promise<void>;
  /** {@link deactivateExtension} every currently-`"active"` extension.
   * Idempotent — a second call finds nothing left to deactivate. Never
   * throws. */
  disposeAll(): Promise<void>;
  /** Activate every extension whose `manifest.activationEvents` includes
   * `"onStartup"` (Req 2.5). Owns no render loop or timing of its own — the
   * CLI decides *when* to call this (after the first frame, Task 1.15).
   * Never throws. */
  activateStartupExtensions(): Promise<void>;
  /**
   * Activate every extension whose `manifest.activationEvents` includes
   * `` `onLanguage:${languageId}` `` (Req 2.5). Synchronous and
   * void-returning by design: `DocumentManagerDeps.onLanguageActivation`
   * (`buffer/documentManager.ts`, unchanged by this task) is exactly this
   * shape, guards the call in its own try/catch, and does not await it —
   * this function starts activation and returns immediately, relying on
   * {@link activateExtension}'s own never-rejecting contract so nothing here
   * produces an unhandled rejection.
   */
  onLanguage(languageId: string): void;
  /** Read-only lookup of one extension's current {@link ActivationState};
   * `undefined` for an unknown ID. Exists mainly for tests — the host's own
   * decisions never need a caller to branch on this first. */
  getState(id: string): ActivationState | undefined;
}

/** Per-extension runtime bookkeeping — kept separate from {@link ExtensionRecord}
 * (the caller-supplied, immutable description) since this is what activation
 * actually mutates. */
interface ExtensionRuntime {
  state: ActivationState;
  ctx?: ExtensionContext;
  module?: ExtensionModule;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `discovery.ts`'s/`registration.ts`'s/`registry.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Pull `activate`/`deactivate` out of a loaded extension module. Anything
 * else on the module (default export, other named exports) is ignored —
 * extensions are expected to export these two functions by name, the
 * VS-Code-familiar convention (unlike `manifest.ts`'s `export default`
 * convention, which is documented in `discovery.ts`).
 */
function asExtensionModule(mod: unknown): ExtensionModule {
  if (!mod || typeof mod !== "object") return {};
  const record = mod as Record<string, unknown>;
  const activate = typeof record.activate === "function" ? (record.activate as ExtensionModule["activate"]) : undefined;
  const deactivate =
    typeof record.deactivate === "function" ? (record.deactivate as ExtensionModule["deactivate"]) : undefined;
  return { activate, deactivate };
}

/**
 * Build the extension activation host (Req 2.5, 2.6, design.md §4.2).
 *
 * **Wiring `onCommand:<id>` into the command registry**: this host does
 * *not* take a `CommandRegistry` dependency. The data flows the other way —
 * `commands/registry.ts`'s `execute()` needs *this host's*
 * {@link ExtensionHost.activateExtension}, so the simplest ordering (no
 * setter, no mutable closure box) is to build the host first and pass its
 * `activateExtension` straight into `createCommandRegistry`'s
 * `activateExtension` dependency afterward:
 *
 * ```ts
 * const host = createExtensionHost({ extensions, api, log, sink });
 * const commands = createCommandRegistry({ log, sink, activateExtension: host.activateExtension });
 * ```
 *
 * (A registry built *before* the host — e.g. because registration.ts needs
 * it earlier at startup — still works with this same host unchanged: build
 * the registry without `activateExtension` first, build the host, then
 * assign `commands` a way to reach `host.activateExtension` — a setter on
 * `CommandRegistry` or a mutable closure box the deps function reads from
 * would both work equally well here; this codebase's actual startup order
 * (a later task) hasn't been settled, so that variant is deliberately left
 * for whichever assembly task needs it.)
 */
export function createExtensionHost(deps: ExtensionHostDeps): ExtensionHost {
  const { api, log, sink } = deps;

  const records = new Map<string, ExtensionRecord>();
  const runtimes = new Map<string, ExtensionRuntime>();
  for (const record of deps.extensions) {
    records.set(record.id, record);
    runtimes.set(record.id, { state: "registered" });
  }

  /** In-flight activation promises, keyed by extension ID — collapses
   * concurrent {@link activateExtension} calls for the same not-yet-active
   * extension into one activation (see {@link ExtensionHost.activateExtension}'s
   * TSDoc). */
  const inFlight = new Map<string, Promise<void>>();

  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed — see logSafely.
    }
  }

  /** Dispose `ctx.subscriptions` in reverse push order, one guarded
   * `dispose()` at a time (Req 2.6) — a throwing disposable is logged and
   * does not stop the rest. Clears the array afterward so a second call
   * against the same `ctx` (defensive; callers are expected to gate on
   * state) disposes nothing again. */
  function disposeSubscriptions(id: string, ctx: ExtensionContext): void {
    const subscriptions = ctx.subscriptions;
    for (let i = subscriptions.length - 1; i >= 0; i--) {
      const disposable: Disposable | undefined = subscriptions[i];
      try {
        disposable?.dispose();
      } catch (cause) {
        logSafely("error", {
          extensionId: id,
          message: `Extension "${id}" subscription dispose() threw: ${describeError(cause)}`,
        });
      }
    }
    subscriptions.length = 0;
  }

  function markFailed(id: string, runtime: ExtensionRuntime, cause: unknown): void {
    // A partially-set-up extension may have pushed subscriptions before its
    // activate() threw/rejected — dispose those now rather than leaking them
    // forever (deactivateExtension only ever acts on "active" extensions).
    if (runtime.ctx) disposeSubscriptions(id, runtime.ctx);
    runtime.state = "failed";
    runtime.ctx = undefined;
    runtime.module = undefined;
    const err: HostError = {
      extensionId: id,
      message: `Extension "${id}" failed to activate: ${describeError(cause)}`,
    };
    logSafely("error", err);
    notifySafely(err);
  }

  async function performActivation(
    id: string,
    record: ExtensionRecord,
    runtime: ExtensionRuntime,
  ): Promise<void> {
    let loaded: unknown;
    try {
      loaded = await record.loadModule();
    } catch (cause) {
      markFailed(id, runtime, cause);
      return;
    }

    const extensionModule = asExtensionModule(loaded);
    const ctx: ExtensionContext = {
      api,
      extensionUri: record.extensionUri,
      subscriptions: [],
      storagePath: record.storagePath,
    };
    // Visible to markFailed immediately, so subscriptions pushed before a
    // throw/rejection below are still reachable for disposal.
    runtime.ctx = ctx;

    try {
      // A missing `activate` export is not an error (Req 2.6 says "call its
      // exported activate(ctx)" — an extension that exports none has simply
      // finished its (empty) activation work): the extension becomes
      // "active" with nothing to run, which also makes its (possibly
      // exported) `deactivate()` reachable on shutdown.
      if (extensionModule.activate) {
        await extensionModule.activate(ctx);
      }
      runtime.state = "active";
      runtime.module = extensionModule;
    } catch (cause) {
      markFailed(id, runtime, cause);
    }
  }

  function activateExtension(id: string): Promise<void> {
    const record = records.get(id);
    const runtime = runtimes.get(id);
    if (!record || !runtime || runtime.state !== "registered") {
      return Promise.resolve();
    }

    const existing = inFlight.get(id);
    if (existing) return existing;

    const promise = performActivation(id, record, runtime).finally(() => {
      inFlight.delete(id);
    });
    inFlight.set(id, promise);
    return promise;
  }

  async function deactivateExtension(id: string): Promise<void> {
    const runtime = runtimes.get(id);
    if (!runtime || runtime.state !== "active") return;

    const { ctx, module } = runtime;
    if (ctx) disposeSubscriptions(id, ctx);
    if (module?.deactivate) {
      try {
        await module.deactivate();
      } catch (cause) {
        logSafely("error", {
          extensionId: id,
          message: `Extension "${id}" deactivate() threw: ${describeError(cause)}`,
        });
      }
    }
    runtime.state = "registered";
    runtime.ctx = undefined;
    runtime.module = undefined;
  }

  async function disposeAll(): Promise<void> {
    // Settle in-flight activations first: a fire-and-forget trigger (e.g.
    // onLanguage) may still be mid-activation, and deactivateExtension
    // skips anything not yet "active" — without this, such an extension
    // would finish activating after shutdown with its subscriptions never
    // disposed.
    await Promise.all(Array.from(inFlight.values()));
    for (const id of records.keys()) {
      await deactivateExtension(id);
    }
  }

  async function activateStartupExtensions(): Promise<void> {
    const startupIds = Array.from(records.values())
      .filter((record) => record.manifest.activationEvents.includes("onStartup"))
      .map((record) => record.id);
    await Promise.all(startupIds.map((id) => activateExtension(id)));
  }

  function onLanguage(languageId: string): void {
    const event = `onLanguage:${languageId}` as const;
    for (const record of records.values()) {
      if (record.manifest.activationEvents.includes(event)) {
        // Fire-and-forget: activateExtension never rejects (every failure
        // path inside performActivation is caught and reported), so this
        // cannot produce an unhandled rejection.
        void activateExtension(record.id);
      }
    }
  }

  function getState(id: string): ActivationState | undefined {
    return runtimes.get(id)?.state;
  }

  return {
    activateExtension,
    deactivateExtension,
    disposeAll,
    activateStartupExtensions,
    onLanguage,
    getState,
  };
}
