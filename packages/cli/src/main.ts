import pkg from "../package.json";
import type { FileSystem, Tecode } from "@tecode/api";
import {
  createCommandRegistry,
  createConfigService,
  createContextService,
  createDocumentManager,
  createFileSystem,
  createHostLog,
  createNoopStatusSink,
  createTecodeApi,
  pathToUri,
  registerTecodeAlias,
  type CommandRegistry,
  type ConfigService,
  type ContextService,
  type DocumentManager,
  type HostLog,
  type StatusSink,
} from "@tecode/core";

/**
 * Every core service {@link buildAssemblyRoot} wires together, plus the
 * assembled `tecode` object itself — returned so a caller (currently just
 * this module's own `main`; Task 1.15's startup sequence next) can hold
 * onto `config` for `ready`/`dispose()` without reaching back into the
 * module's internals.
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
}

/**
 * Build the `tecode` composition root and register the `"tecode"` module
 * alias (Req 10.1, 10.2; design.md §12, §17; Task 1.13's "Bun module alias
 * registration" note). `packages/cli` is the one place allowed to import
 * `@tecode/core` directly (`eslint.config.mjs`'s layering rule) — this
 * function is that wiring.
 *
 * **This is deliberately a small slice of design.md §17's full startup
 * sequence**, not that sequence itself: argv parsing (file vs. directory),
 * the sync-before-first-frame phase, rendering the UI shell, deferred
 * extension discovery/activation, the initial file open, and startup-timing
 * instrumentation are all Task 1.15's job. That task should *call* this
 * function (or extend it) rather than duplicate its ordering — the one
 * invariant it establishes and Task 1.15 must preserve is
 * {@link registerTecodeAlias} running immediately after
 * {@link createTecodeApi} and strictly before any extension module is
 * imported (Req 1.4, design.md §2): an extension's `import ... from
 * "tecode"` resolves only once the alias is registered.
 *
 * `workspaceRoot` defaults to `process.cwd()` as a placeholder for Task
 * 1.15's real argv-driven file/directory resolution (design.md §17's
 * "Argv parsing (file/directory)" step) — nothing here interprets `argv`
 * yet.
 */
export function buildAssemblyRoot(workspaceRoot: string = process.cwd()): AssemblyRoot {
  const log = createHostLog();
  // No UI shell exists yet (Task 1.14) to back a real StatusSink — matches
  // every other core composition point that hasn't reached its UI task.
  const sink = createNoopStatusSink();

  const commands = createCommandRegistry({ log, sink });
  const documents = createDocumentManager({ log, sink });
  const fs = createFileSystem({ log });
  const config = createConfigService({ log, sink, workspaceRoot });
  const context = createContextService();

  const api = createTecodeApi({
    commands,
    documents,
    fs,
    rootUri: pathToUri(workspaceRoot),
    config,
    context,
    sink,
  });

  // Must run before any extension module is imported (see this function's
  // TSDoc) — no extension loading exists yet (Task 1.15/2.x), so this is
  // simply the last step here today.
  registerTecodeAlias(api);

  return { log, sink, commands, documents, fs, config, context, api };
}

function main(argv: string[]): void {
  if (argv.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
  buildAssemblyRoot();
}

// `import.meta.main` is Bun's "am I the entry point" check (true only when
// this file itself was executed, e.g. `bun run main.ts`; false when another
// module — such as this file's own test — imports it). Without this guard,
// importing `main.ts` for testing `buildAssemblyRoot` would also run
// `main(process.argv.slice(2))` as an unwanted side effect, against the
// *importing* process's real argv and real `HOME`.
if (import.meta.main) {
  main(process.argv.slice(2));
}
