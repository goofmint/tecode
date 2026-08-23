import pkg from "../package.json";
import type { FileSystem, Manifest, ResolvedTheme, Tecode } from "@tecode/api";
import {
  createCommandRegistry,
  createConfigService,
  createContextService,
  createDocumentManager,
  createExtensionHost,
  createFileSystem,
  createHostLog,
  createLayoutStateService,
  createNoopStatusSink,
  createBaseTheme,
  createSlotRegistry,
  createTecodeApi,
  loadExtensions,
  pathToUri,
  registerCoreConfiguration,
  registerTecodeAlias,
  type CommandRegistry,
  type ConfigService,
  type ContextService,
  type DiscoveryFs,
  type DocumentManager,
  type ExtensionHost,
  type HostLog,
  type LayoutStateService,
  type LoadExtensionsResult,
  type SlotRegistry,
  type StatusSink,
} from "@tecode/core";
import { builtinManifests } from "@tecode/builtin";
import { resolveStartupTarget, type StartupTarget } from "./argv";
import { buildExtensionRecords } from "./extensionRecords";
import { createKeymapState, type KeymapState } from "./keymapState";
import { renderShellHeadless, renderShellToTerminal, type RenderShell } from "./renderShell";
import { detectTerminalCapabilities } from "./terminalCapabilities";

/**
 * Every core service {@link buildAssemblyRoot} wires together, plus the
 * assembled `tecode` object itself (Req 10.1, 10.2; design.md §12, §17;
 * Task 1.13's "Bun module alias registration" note, extended by Task
 * 1.15's full startup sequence below).
 */
export interface AssemblyRoot {
  log: HostLog;
  sink: StatusSink;
  commands: CommandRegistry;
  documents: DocumentManager;
  fs: FileSystem;
  config: ConfigService;
  context: ContextService;
  api: Tecode;
  /** The live slot registry backing both `tecode.ui.registerView` (via
   * `api`) and the rendered Shell — see this module's TSDoc on why both
   * must share the exact same instance. */
  slotRegistry: SlotRegistry;
  layoutState: LayoutStateService;
  /** The active theme (Task 1.14's hardcoded base palette — a real theme
   * loader is Task 2.6's job). */
  theme: ResolvedTheme;
  /** The resolved workspace root this root was built for. */
  workspaceRoot: string;
  /** The layered keybinding table, kept up to date across every startup
   * phase — see `keymapState.ts`'s TSDoc. */
  keymap: KeymapState;
  /**
   * Forward-reference box for the extension host (this module's TSDoc,
   * "Forward-referenced host wiring"): `undefined` until the deferred
   * phase ({@link runDeferredPhase}) assigns it. `commands`/`documents`/
   * `slotRegistry` above all close over `hostRef.current` rather than a
   * host instance directly, so they can be built in the sync phase, before
   * the host exists, and still reach it once it does.
   */
  hostRef: { current?: ExtensionHost };
}

/**
 * Build the `tecode` composition root and register the `"tecode"` module
 * alias (Req 10.1, 10.2, 1.4; design.md §2, §12, §17). `packages/cli` is
 * the one place allowed to import `@tecode/core` directly
 * (`eslint.config.mjs`'s layering rule) — this function is that wiring,
 * and the sync phase of Task 1.15's startup sequence (everything up to,
 * but not including, rendering the Shell) is entirely this function's
 * body.
 *
 * **Forward-referenced host wiring**: the extension host
 * ({@link ExtensionHost}, `@tecode/core`'s `createExtensionHost`) is built
 * in the *deferred* phase ({@link runDeferredPhase}), after discovery —
 * which itself needs `commands`/`slotRegistry` already registered so
 * lazy commands/views exist to attach to. But `commands.execute` on a lazy
 * command, `documents`' `onLanguage:*` firing, and `slotRegistry`'s lazy
 * view activation all need to reach the host *from here*, in the sync
 * phase. `hostRef` — a plain mutable box, read through an optional-chained
 * closure — is exactly the pattern `host/activation.ts`'s own TSDoc
 * documents for this: build the services that need the host first with a
 * closure over `hostRef.current`, build the host once discovery has run,
 * then assign it. Every call through `hostRef.current` before the deferred
 * phase assigns it is a documented, safe no-op (each dependency's own
 * `activateExtension?`/`onLanguageActivation?` is already optional and
 * guarded for exactly this "no host yet" case).
 *
 * `registerTecodeAlias` runs immediately after {@link createTecodeApi} and
 * strictly before any extension module import — {@link runDeferredPhase}'s
 * `loadModule()` closures (`extensionRecords.ts`) are the first (and only)
 * dynamic imports of extension code, always strictly after this function
 * returns.
 */
export function buildAssemblyRoot(
  workspaceRoot: string = process.cwd(),
  deps: { log?: HostLog } = {},
): AssemblyRoot {
  const log = deps.log ?? createHostLog();
  // The UI shell is real now (PR #53), but nothing wires host/command
  // errors into it yet — that is the statusbar built-in's job
  // (`packages/builtin/statusbar`, still a placeholder) or a later
  // notification-area task, not Task 1.15's. Every other composition point
  // in `core` stays a no-op sink until one of those lands.
  const sink = createNoopStatusSink();

  const hostRef: { current?: ExtensionHost } = {};

  const commands = createCommandRegistry({
    log,
    sink,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });
  const documents = createDocumentManager({
    log,
    sink,
    onLanguageActivation: (id) => hostRef.current?.onLanguage(id),
  });
  const fs = createFileSystem({ log });

  const keymap = createKeymapState(log);
  const config = createConfigService({
    log,
    sink,
    workspaceRoot,
    onKeybindingsChange: (entries) => keymap.setUserEntries(entries),
  });
  // Core's own settings (`editor.lineNumbers`, `editor.tabSize` — Req 9.5,
  // design.md §8.3's EditorView gutter/indentation) have no extension
  // manifest to flow through `loadExtensions`' `contributes.configuration`
  // handling (`host/registration.ts`), so register them directly, right
  // after the service exists — same seam an extension's schema would use,
  // just called once from the composition root instead of from manifest
  // registration (`config/coreDefaults.ts`'s TSDoc).
  registerCoreConfiguration(config);
  const context = createContextService();

  const slotRegistry = createSlotRegistry({
    log,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });
  const layoutState = createLayoutStateService({ log, sink });
  const theme = createBaseTheme();

  const api = createTecodeApi({
    commands,
    documents,
    fs,
    rootUri: pathToUri(workspaceRoot),
    config,
    context,
    sink,
    slotRegistry,
  });

  // Must run before any extension module is imported (see this function's
  // TSDoc).
  registerTecodeAlias(api);

  return {
    log,
    sink,
    commands,
    documents,
    fs,
    config,
    context,
    api,
    slotRegistry,
    layoutState,
    theme,
    workspaceRoot,
    keymap,
    hostRef,
  };
}

/** What {@link runDeferredPhase} produced. */
export interface DeferredStartupResult {
  extensionHost: ExtensionHost;
  loadResult: LoadExtensionsResult;
}

/** Options for {@link runDeferredPhase}. */
export interface RunDeferredPhaseOptions {
  /** The argv-resolved file to open once extensions have registered (Req
   * 12.1's "open the initial file"). `undefined` for a directory/no-arg
   * launch. */
  initialFilePath?: string;
  /** Built-in manifests to discover alongside `user`/`workspace`
   * extensions. Defaults to `@tecode/builtin`'s `builtinManifests`
   * (currently `[]` — see that module's TSDoc); overridable for tests. */
  builtins?: Manifest[];
  /** Discovery's filesystem seam passthrough — production never sets
   * this; tests use it for hermeticity (matches `discovery.test.ts`'s
   * `createHermeticFs`, which blocks scanning the *real* user extensions
   * directory during an in-process test). */
  fs?: DiscoveryFs;
}

/**
 * Task 1.15's deferred phase (design.md §3's step 2, scheduled via
 * `queueMicrotask` by {@link runTecode} after the first frame): discover →
 * validate → register every extension (`loadExtensions`), fire
 * `onStartup` activations, then open the argv-resolved initial file
 * (firing `onLanguage:*` via `documents.openDocument`).
 *
 * Exported separately from {@link runTecode} (which drives the full CLI,
 * including `process.exit` in headless mode) so it can be exercised
 * in-process in tests without any risk of exiting the test runner itself.
 */
export async function runDeferredPhase(
  root: AssemblyRoot,
  options: RunDeferredPhaseOptions = {},
): Promise<DeferredStartupResult> {
  const loadResult = await loadExtensions({
    log: root.log,
    sink: root.sink,
    commands: root.commands,
    configRegistrar: root.config,
    builtins: options.builtins ?? builtinManifests,
    workspaceRoot: root.workspaceRoot,
    fs: options.fs,
  });

  // Feed registration's extension keybindings into the keymap's extension
  // layer now that they are known (Phase 2's plan) — the user layer was
  // already wired synchronously via ConfigService's onKeybindingsChange.
  root.keymap.setExtensionEntries(loadResult.extensionKeybindings);

  const extensionHost = createExtensionHost({
    extensions: buildExtensionRecords(loadResult.loaded),
    api: root.api,
    log: root.log,
    sink: root.sink,
  });
  // Fulfills every forward reference `buildAssemblyRoot` built
  // (`hostRef`) — commands/documents/slotRegistry can now actually reach
  // activation.
  root.hostRef.current = extensionHost;

  await extensionHost.activateStartupExtensions();

  if (options.initialFilePath) {
    // Fires onLanguage:* via DocumentManagerDeps.onLanguageActivation,
    // which is exactly hostRef.current.onLanguage now that it is assigned
    // above.
    await root.documents.openDocument(pathToUri(options.initialFilePath));
  }

  return { extensionHost, loadResult };
}

/** Emit one structured, single-line JSON metric to stdout — the
 * CI-parseable timing/order channel this task's plan calls for.
 * `HostLog` (`@tecode/core`'s `host/errors.ts`) has no dedicated
 * metrics/info level (only `error`/`warning`), so shoehorning a timing
 * line into it would misuse that schema; stdout is what both the manual
 * smoke check and the subprocess integration test actually parse. */
function emitMetric(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Emit a step marker, only when `TECODE_VERBOSE=1` (this task's plan:
 * "verbose behind an env flag") — the baseline `tecode.timing` first-frame
 * metric below is always emitted regardless. */
function emitVerboseStep(startedAt: number, step: string): void {
  if (process.env["TECODE_VERBOSE"] !== "1") return;
  emitMetric("tecode.step", { step, ms: performance.now() - startedAt });
}

/** Options for {@link runTecode}. */
export interface RunTecodeOptions {
  /** Forces headless mode on/off. Defaults to `TECODE_HEADLESS=1` or "no
   * real TTY on stdout" (this task's adaptation) — see this module's
   * TSDoc. */
  headless?: boolean;
  /** Overrides the render seam — tests substitute their own to observe
   * ordering without a real terminal OR the built-in headless no-op.
   * Defaults to {@link renderShellHeadless} when `headless`, else
   * {@link renderShellToTerminal}. */
  renderShell?: RenderShell;
  /** Overrides the built-in manifest list passed to `loadExtensions` —
   * tests only; production always uses `@tecode/builtin`'s
   * `builtinManifests`. */
  builtins?: Manifest[];
  /** Overrides `process.cwd()` — tests only. */
  cwd?: string;
}

/** Sets up graceful-shutdown handling (Phase 3's "wire process-exit
 * disposeAll"). A synchronous Node/Bun `"exit"` handler cannot await async
 * cleanup, so this listens for `SIGINT`/`SIGTERM` instead — the standard
 * pattern for a CLI that needs to flush/dispose before actually exiting —
 * and calls `process.exit(0)` itself once cleanup settles. Idempotent: a
 * second signal while shutdown is already in flight is a no-op. */
function wireProcessExit(root: AssemblyRoot): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await root.layoutState.flush();
    root.config.dispose();
    await root.hostRef.current?.disposeAll();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
}

/** What {@link runTecode} produced, for a non-headless (real) run — a
 * headless run instead calls `process.exit(0)` itself once the deferred
 * phase completes and never returns this. */
export interface RunTecodeResult {
  root: AssemblyRoot;
  extensionHost: ExtensionHost;
  loadResult: LoadExtensionsResult;
  firstFrameMs: number;
}

/**
 * Run the full startup sequence (Req 12.1, 12.2; design.md §3, §15): the
 * sync phase (argv → {@link buildAssemblyRoot} → config ready → terminal
 * capabilities → render the Shell = "first frame"), then the deferred
 * phase ({@link runDeferredPhase}, scheduled via `queueMicrotask` so it
 * never runs synchronously ahead of the first frame above it), with
 * startup-to-first-frame timing instrumentation throughout.
 *
 * **Headless mode** (`TECODE_HEADLESS=1`, or no real TTY on stdout at
 * all): the render seam defaults to {@link renderShellHeadless} (never
 * opens a TTY) and, once the deferred phase completes, this function
 * flushes layout state, disposes the config service's file watchers and
 * the extension host, emits a final `tecode.headlessExit` metric, and
 * calls `process.exit(0)` itself — `ConfigService`'s real `fs.watch`
 * handles would otherwise keep the event loop (and the process) alive
 * forever with no UI to justify it. This is what makes `TECODE_HEADLESS=1
 * bun packages/cli/src/main.ts <path>` usable as a scriptable smoke check
 * and what the subprocess integration test relies on to observe a clean
 * exit.
 */
export async function runTecode(
  argv: readonly string[],
  options: RunTecodeOptions = {},
): Promise<RunTecodeResult> {
  const startedAt = performance.now();
  const headless = options.headless ?? (process.env["TECODE_HEADLESS"] === "1" || !process.stdout.isTTY);

  const log = createHostLog();
  const cwd = options.cwd ?? process.cwd();
  const target: StartupTarget = await resolveStartupTarget(argv, cwd, log);

  const root = buildAssemblyRoot(target.workspaceRoot, { log });
  await root.config.ready;
  emitVerboseStep(startedAt, "config-ready");

  // Sync-phase terminal capability detection (design.md §3) — a stub
  // (Task 4.2 owns the real probe; see terminalCapabilities.ts's TSDoc for
  // why nothing consumes the result yet).
  detectTerminalCapabilities();

  wireProcessExit(root);

  const renderShell = options.renderShell ?? (headless ? renderShellHeadless : renderShellToTerminal);
  await renderShell({
    slotRegistry: root.slotRegistry,
    layoutState: root.layoutState,
    context: root.context,
    commands: root.commands,
    theme: root.theme,
    documents: root.documents,
    config: root.config,
  });

  const firstFrameMs = performance.now() - startedAt;
  root.log.append("warning", {
    message: `[tecode:timing] first-frame ${firstFrameMs.toFixed(2)}ms`,
  });
  // `ts` is a raw performance.now() reading — directly comparable, within
  // this same process, against any other same-process reading (e.g. the
  // subprocess integration test's fixture extension logging its own
  // module-load time) without needing a shared wall-clock epoch.
  emitMetric("tecode.timing", { phase: "first-frame", ms: firstFrameMs, ts: performance.now() });

  // Deferred phase (design.md §3's step 2): queueMicrotask guarantees this
  // never runs synchronously ahead of the render above — the microtask
  // queue only drains after the current synchronous stack (including the
  // `await renderShell(...)` continuation) has yielded.
  const deferred = await new Promise<DeferredStartupResult>((resolveDeferred, rejectDeferred) => {
    queueMicrotask(() => {
      runDeferredPhase(root, {
        initialFilePath: target.initialFilePath,
        builtins: options.builtins,
      }).then(resolveDeferred, rejectDeferred);
    });
  });
  emitVerboseStep(startedAt, "deferred-complete");

  if (headless) {
    emitMetric("tecode.headlessExit", {
      loaded: deferred.loadResult.loaded.length,
      skipped: deferred.loadResult.skipped.length,
      ms: performance.now() - startedAt,
    });
    await root.layoutState.flush();
    root.config.dispose();
    await deferred.extensionHost.disposeAll();
    process.exit(0);
  }

  return { root, extensionHost: deferred.extensionHost, loadResult: deferred.loadResult, firstFrameMs };
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
  await runTecode(argv);
}

// `import.meta.main` is Bun's "am I the entry point" check (true only when
// this file itself was executed, e.g. `bun run main.ts`; false when another
// module — such as this file's own test — imports it). Without this guard,
// importing `main.ts` for testing `buildAssemblyRoot`/`runDeferredPhase`
// would also run `main(process.argv.slice(2))` as an unwanted side effect,
// against the *importing* process's real argv, real `HOME`, and (in
// non-headless mode) a real TTY.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error("tecode failed to start:", cause);
    process.exit(1);
  });
}
