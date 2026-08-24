/**
 * Test-only composition-root harness (Req 2.1, 2.4-2.6, 10.4; design.md
 * §4.1-4.4) — runs the REAL `loadExtensions` → `buildExtensionRecords` →
 * `createExtensionHost` pipeline against whatever is actually on disk
 * under the CURRENT process's real user extensions directory
 * (`@tecode/core`'s `getUserExtensionsDir()`, i.e. `$HOME/.config/tecode/
 * extensions`) — never a fake or injected filesystem seam.
 *
 * **Why this is a separate spawned process, not an in-process test**:
 * `externalExtensionLoading.test.ts` spawns this file as a genuine child
 * process (`Bun.spawn`, matching `main.integration.test.ts`'s own
 * established technique) with `HOME` set — AT PROCESS LAUNCH, in
 * `Bun.spawn`'s `env` — to a disposable temp directory holding real
 * fixture extensions (real `manifest.ts`/`index.ts` files on disk). This
 * is the only way to redirect Bun's `os.homedir()` for a real dynamic
 * `import()` of a real "user"-sourced extension's `index.ts`:
 * `host/discovery.test.ts`'s own TSDoc documents that a runtime `$HOME`
 * mutation inside an already-running process does NOT take effect under
 * Bun (unlike Node), and `extensionRecords.ts`'s
 * `loadUserOrWorkspaceModule` — which performs that SECOND, `index.ts`-
 * loading dynamic import — has no injectable filesystem/import seam at
 * all: `discovery.ts`'s `DiscoveryFs`/`DiscoveryDeps.importModule` seams
 * (the ones `host/discovery.test.ts`'s `createHermeticFs` remaps) only
 * cover the FIRST import, of `manifest.ts`. Spawning a fresh process with
 * `HOME` set from the start is therefore the only way to exercise the
 * second import for real, hermetically — with zero risk to whatever (if
 * anything) actually lives under the host machine's real
 * `~/.config/tecode/extensions`.
 *
 * Reads three optional CLI args — a command id to `commands.execute()`
 * after startup activation, a `sidebar.view` id to check for a resolved
 * (non-lazy, real-component) registration, and a workspace root whose
 * `.tecode/extensions` directory should be scanned alongside the user one
 * (omitted/empty scans the user directory only) — and prints exactly ONE line of
 * JSON (a {@link HarnessResult}) to stdout, then exits 0. Any unexpected
 * throw from the harness's OWN setup (not the pipeline under test, which
 * is documented to never throw) is caught at the bottom, reported as
 * `{ fatal: <message> }` on stdout, and exits 1.
 */

import {
  createCommandRegistry,
  createConfigService,
  createContextService,
  createDocumentManager,
  createExtensionHost,
  createFileSystem,
  createHostLog,
  createNoopStatusSink,
  createSlotRegistry,
  createTecodeApi,
  loadExtensions,
  type ExtensionHost,
} from "@tecode/core";
import { buildExtensionRecords } from "./extensionRecords";

/** What this harness reports back to the spawning test, as one JSON line
 * on stdout. */
interface HarnessResult {
  /** Every extension id `loadExtensions` reported as loaded. */
  loadedIds: string[];
  /** Every extension `loadExtensions` skipped, with its reason (Req 2.4). */
  skipped: { extensionId: string; reason: string }[];
  /** Each loaded extension's real `ExtensionHost.getState(id)` after
   * `activateStartupExtensions()` has settled (Req 2.5, 2.6). */
  states: Record<string, string | undefined>;
  /** The resolved value of `commands.execute(<commandId arg>)`, run after
   * startup activation — proves the healthy fixture's contributed command
   * genuinely works, not just that it was registered. */
  commandResult: unknown;
  /** Whether the `<viewId arg>`'s `sidebar.view` entry has a real
   * (non-lazy) `component` after activation — proves the healthy
   * fixture's contributed view genuinely resolved, not just that a lazy
   * placeholder exists. */
  sidebarViewResolved: boolean;
  /** Every `HostLog` entry at `"error"` level accumulated across the whole
   * run — lets the test assert that a broken sibling's failure was
   * actually surfaced, not silently swallowed. */
  errorLogMessages: string[];
}

async function main(): Promise<void> {
  const [, , commandIdArg, viewIdArg, workspaceRootArg] = process.argv;
  const commandId = commandIdArg ?? "";
  const viewId = viewIdArg ?? "";
  // Empty/absent means "scan the user directory only" — `loadExtensions`
  // skips the workspace source entirely when given no `workspaceRoot`
  // (`host/discovery.ts`'s `getWorkspaceExtensionsDir` call site).
  const workspaceRoot = workspaceRootArg ?? "";

  const log = createHostLog();
  const sink = createNoopStatusSink();
  const commands = createCommandRegistry({ log, sink });
  const documents = createDocumentManager({ log, sink });
  const fs = createFileSystem({ log });
  const context = createContextService();
  const config = createConfigService({ log, sink });
  await config.ready;

  // Forward-reference box (matches `main.ts`'s own `hostRef` pattern, and
  // that module's TSDoc on why): the slot registry's `activateExtension`
  // needs to reach the extension host, but the host isn't built until
  // every extension is discovered/registered — which itself needs
  // `slotRegistry` to already exist.
  const hostRef: { current?: ExtensionHost } = {};
  const slotRegistry = createSlotRegistry({
    log,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });

  const api = createTecodeApi({ commands, documents, fs, config, context, sink, slotRegistry });

  // The real pipeline under test (this module's TSDoc): no `fs`/
  // `importModule` override — `loadExtensions` scans the REAL
  // `getUserExtensionsDir()`, which resolves against THIS process's real
  // `$HOME` (set by the spawning test, at launch), plus — when the test
  // passed one — the REAL `getWorkspaceExtensionsDir(workspaceRoot)`
  // (`<workspaceRoot>/.tecode/extensions`, Req 2.1). Both sources go
  // through the same `import(pathToFileURL(file).href)` load path
  // (`extensionRecords.ts`'s `loadUserOrWorkspaceModule`, which treats
  // `user` and `workspace` identically), so covering workspace here
  // exercises it for real rather than by assertion about shared code.
  const loadResult = await loadExtensions({
    log,
    sink,
    commands,
    configRegistrar: config,
    builtins: [],
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });

  // `ui/slotRegistry.ts`'s `SlotRegistry.seedPendingViews` — the deferred-
  // phase wiring `packages/cli/src/main.ts`'s `runDeferredPhase` performs
  // for real, mirrored here (this harness's TSDoc).
  slotRegistry.seedPendingViews(loadResult.pendingViews);

  const records = buildExtensionRecords(loadResult.loaded);
  const host = createExtensionHost({ extensions: records, api, log, sink });
  hostRef.current = host;

  await host.activateStartupExtensions();

  const states: Record<string, string | undefined> = {};
  for (const loaded of loadResult.loaded) {
    states[loaded.extensionId] = host.getState(loaded.extensionId);
  }

  const commandResult = commandId ? await commands.execute(commandId) : undefined;

  const sidebarViewResolved = viewId
    ? slotRegistry.getView("sidebar.view", viewId)?.component !== undefined
    : false;

  const result: HarnessResult = {
    loadedIds: loadResult.loaded.map((l) => l.extensionId),
    skipped: loadResult.skipped.map((s) => ({ extensionId: s.extensionId, reason: s.reason })),
    states,
    commandResult,
    sidebarViewResolved,
    errorLogMessages: log
      .entries()
      .filter((e) => e.level === "error")
      .map((e) => e.error.message),
  };

  console.log(JSON.stringify(result));
  config.dispose();
}

main()
  .then(() => process.exit(0))
  .catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.log(JSON.stringify({ fatal: message }));
    process.exit(1);
  });
