/**
 * Proves `samples/settings.json` and `samples/keybindings.json` (Issue
 * #38 "5.2 User documentation and release") actually load cleanly, not
 * just that they happen to be syntactically valid JSON. Two separate
 * claims, both exercised here against REAL production code rather than
 * hand-rolled assertions about the files' text:
 *
 * 1. Each file parses as JSONC via `@tecode/core`'s own `parseJsonc`
 *    (`config/jsonc.ts`) — the exact parser `ConfigService` and
 *    `keymap/fallbackKeybindings.ts` use for every settings/keybindings
 *    file this codebase ever reads, not `JSON.parse` standing in for it.
 * 2. Each file's CONTENT survives the real load path with zero warnings:
 *    `samples/settings.json` is fed through a real `createConfigService`
 *    (registered against BOTH core's own schema, `registerCoreConfiguration`,
 *    and every built-in extension's `contributes.configuration`, via a
 *    real `loadExtensions` call — the same two callers `packages/cli/src/
 *    main.ts`'s `buildAssemblyRoot`/`runDeferredPhase` composition root
 *    exercises); `samples/keybindings.json` is fed into a real
 *    `createBindingTable` as the `user` layer, layered under the same
 *    `defaults`/`fallback`/`extension` layers `main.ts` builds. A sample
 *    key with a schema-mismatched type, or a keybinding entry `compileEntry`
 *    would skip, fails THIS test instead of shipping silently broken.
 *
 * **The commented-out `editor.wordWrap`/`files.autoSave` lines**
 * (`samples/settings.json`'s own TSDoc-style header — Req 9.5 names both,
 * neither is implemented, see this repo's README "Settings reference"
 * table): `parseJsonc` strips `//` comments before `JSON.parse` ever runs
 * (`config/jsonc.ts`'s `stripComments`), so a commented-out JSON *line*
 * inside the object is invisible to the parser — there is nothing special
 * to handle here, and this test's "every parsed key round-trips" loop
 * below simply never sees those two keys, exactly as if they were absent.
 * A dedicated assertion below confirms this explicitly rather than relying
 * on that being obviously true.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KeybindingContribution } from "@tecode/api";
import { builtinManifests } from "@tecode/builtin";
import {
  BUNDLED_FALLBACK_KEYBINDINGS,
  createBindingTable,
  createCommandRegistry,
  createConfigService,
  createHostLog,
  createNoopStatusSink,
  getUserConfigDir,
  getUserExtensionsDir,
  loadExtensions,
  MODAL_DEFAULT_KEYBINDINGS,
  parseJsonc,
  registerCoreConfiguration,
  TAB_DEFAULT_KEYBINDINGS,
  type ConfigServiceFs,
  type DiscoveryFs,
} from "@tecode/core";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SETTINGS_SAMPLE_PATH = resolve(REPO_ROOT, "samples/settings.json");
const KEYBINDINGS_SAMPLE_PATH = resolve(REPO_ROOT, "samples/keybindings.json");
const EMACS_SAMPLE_PATH = resolve(REPO_ROOT, "samples/keybindings.emacs.json");
const WINDOWS_SAMPLE_PATH = resolve(REPO_ROOT, "samples/keybindings.windows.json");

/** `@tecode/core`'s public surface exports `getUserConfigDir` but not the
 * two file-specific helpers (`getUserSettingsPath`/`getUserKeybindingsPath`
 * are internal to `host/paths.ts`, re-exported only from `host/index.ts`,
 * not from the top-level `core/index.ts` this package is allowed to
 * import) — rebuilt here exactly the way `host/paths.ts` itself builds
 * them (`join(getUserConfigDir(), "settings.json")` /
 * `join(getUserConfigDir(), "keybindings.json")`), matching
 * `extensionRecords.ts`'s own precedent of deriving a config-dir-relative
 * path from `getUserConfigDir()` rather than needing every specific path
 * helper exported. */
function userSettingsPath(): string {
  return join(getUserConfigDir(), "settings.json");
}
function userKeybindingsPath(): string {
  return join(getUserConfigDir(), "keybindings.json");
}

/** An `ENOENT` matching the shape `errorCode()` helpers across this
 * codebase (`config/service.ts`, `host/discovery.ts`, ...) look for. */
function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

/**
 * A `ConfigServiceFs` that serves `samples/settings.json`'s text for the
 * REAL user settings path and `samples/keybindings.json`'s text for the
 * REAL user keybindings path — everything else (the workspace settings
 * layer is never consulted here since no `workspaceRoot` is passed) is
 * `ENOENT`. Matches `config/service.test.ts`'s own `createFakeFs` seam
 * shape (in-memory, keyed by exact path), just pre-seeded with the two
 * sample files' real content instead of ad-hoc test fixtures.
 */
function createSampleConfigFs(settingsText: string, keybindingsText: string): ConfigServiceFs {
  const files = new Map<string, string>([
    [userSettingsPath(), settingsText],
    [userKeybindingsPath(), keybindingsText],
  ]);
  return {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw enoent(path);
      return content;
    },
    watch() {
      // Live reload is irrelevant to "does the sample load once, cleanly"
      // — a no-op handle is all `createConfigService`'s `startWatchers()`
      // needs.
      return { close() {} };
    },
  };
}

/**
 * A `DiscoveryFs` that blocks the REAL `~/.config/tecode/extensions`
 * directory (`host/discovery.test.ts`'s own `createHermeticFs` precedent)
 * so this test never depends on — or is perturbed by — whatever extensions
 * happen to be installed on the machine actually running it. No
 * `workspaceRoot` is passed to `loadExtensions` below, so the workspace
 * extensions directory is never scanned in the first place.
 */
function createHermeticDiscoveryFs(): DiscoveryFs {
  const blockedUserExtensionsDir = getUserExtensionsDir();
  return {
    async readdir(path) {
      if (path === blockedUserExtensionsDir) throw enoent(path);
      throw enoent(path);
    },
    async stat(path) {
      throw enoent(path);
    },
  };
}

/**
 * Build the same three services `main.ts`'s composition root builds —
 * `ConfigService`, `CommandRegistry`, the extension layer via
 * `loadExtensions` — against the two sample files, and a `BindingTable`
 * layered exactly like `main.ts` layers `createKeymapState`'s table
 * (`defaults`: `MODAL_DEFAULT_KEYBINDINGS` + `TAB_DEFAULT_KEYBINDINGS`;
 * `fallback`: `BUNDLED_FALLBACK_KEYBINDINGS`; `extension`: every built-in
 * manifest's `contributes.keybindings`; `user`: the sample's own entries,
 * captured off `ConfigService`'s real `onKeybindingsChange` hook exactly
 * as `main.ts` wires it to `keymap.setUserEntries`).
 */
async function loadSamplesThroughRealPath(settingsText: string, keybindingsText: string) {
  const configLog = createHostLog();
  const sink = createNoopStatusSink();
  let userKeybindingEntries: unknown[] = [];

  const config = createConfigService({
    log: configLog,
    sink,
    fs: createSampleConfigFs(settingsText, keybindingsText),
    onKeybindingsChange: (entries) => {
      userKeybindingEntries = entries.slice();
    },
  });
  // Same order as `main.ts`'s `buildAssemblyRoot`: register core's own
  // schema synchronously, right after the service exists.
  registerCoreConfiguration(config);

  const registrationLog = createHostLog();
  const commands = createCommandRegistry({ log: registrationLog, sink });

  // Both `config.ready` (settings/keybindings files) and `loadExtensions`
  // (every built-in's `contributes.configuration`/`keybindings`) run
  // concurrently in a real startup too — `registerConfiguration`'s own
  // "a registration can land after the initial load finished" re-validation
  // (`config/service.ts`) is exactly what makes awaiting both, in either
  // completion order, still deterministic here.
  const [, loadResult] = await Promise.all([
    config.ready,
    loadExtensions({
      log: registrationLog,
      sink,
      commands,
      configRegistrar: config,
      builtins: builtinManifests,
      fs: createHermeticDiscoveryFs(),
    }),
  ]);

  const bindingTableLog = createHostLog();
  const table = createBindingTable(
    {
      defaults: [...MODAL_DEFAULT_KEYBINDINGS, ...TAB_DEFAULT_KEYBINDINGS],
      fallback: BUNDLED_FALLBACK_KEYBINDINGS,
      extension: loadResult.extensionKeybindings,
      user: userKeybindingEntries as KeybindingContribution[],
    },
    { log: bindingTableLog },
  );

  return { config, configLog, registrationLog, bindingTableLog, table, userKeybindingEntries };
}

describe("samples/settings.json (Issue #38)", () => {
  test("parses as JSONC via the repo's real parser", async () => {
    const raw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(raw);
    expect(parsed.ok).toBe(true);
  });

  test("loads through a real ConfigService (core + every built-in's configuration schema) with zero warnings or errors", async () => {
    const raw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const keybindingsRaw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const { configLog, registrationLog } = await loadSamplesThroughRealPath(raw, keybindingsRaw);

    expect(configLog.entries()).toEqual([]);
    expect(registrationLog.entries()).toEqual([]);
  });

  test("every key the sample actually sets round-trips through the merged config view", async () => {
    const raw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const keybindingsRaw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { config } = await loadSamplesThroughRealPath(raw, keybindingsRaw);
    for (const [key, value] of Object.entries(parsed.value)) {
      // Serialized comparison rather than `expect(actual).toEqual(value)`
      // directly: both sides are `unknown` (the settings file's own JSON
      // shape, and `ConfigService.get`'s default `T = unknown` return
      // type), which bun:test's overload resolution does not accept
      // as-is. Every sample value here is a JSON primitive, so this is
      // exactly as strict as a direct structural comparison would be.
      expect(JSON.stringify(config.get(key))).toBe(JSON.stringify(value));
    }
  });

  test("the commented-out editor.wordWrap/files.autoSave lines are genuinely invisible to the parser (Req 9.5 traceability, not live settings)", async () => {
    const raw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const parsed = parseJsonc<Record<string, unknown>>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(Object.prototype.hasOwnProperty.call(parsed.value, "editor.wordWrap")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.value, "files.autoSave")).toBe(false);
  });
});

describe("samples/keybindings.json (Issue #38)", () => {
  test("parses as a JSONC array via the repo's real parser", async () => {
    const raw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const parsed = parseJsonc<unknown>(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.isArray(parsed.value)).toBe(true);
  });

  test("loads through a real BindingTable (defaults + fallback + every built-in's keybindings + this file as the user layer) with zero warnings", async () => {
    const settingsRaw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const raw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const { bindingTableLog } = await loadSamplesThroughRealPath(settingsRaw, raw);

    expect(bindingTableLog.entries()).toEqual([]);
  });

  test("every non-removal entry actually wins at its own key, as the user layer (highest precedence)", async () => {
    const settingsRaw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const raw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const parsed = parseJsonc<KeybindingContribution[]>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { table } = await loadSamplesThroughRealPath(settingsRaw, raw);
    const alwaysTrue = () => true;

    for (const entry of parsed.value) {
      if (entry.command.startsWith("-")) continue; // a removal has no resolved command of its own to check.
      const resolved = table.lookup(entry.key, alwaysTrue);
      expect(resolved?.command).toBe(entry.command);
      expect(resolved?.layer).toBe("user");
    }
  });

  test("sanity: the sample's own removal entry actually clears the default it targets (proves the removal isn't a silent no-op)", async () => {
    const settingsRaw = await readFile(SETTINGS_SAMPLE_PATH, "utf8");
    const raw = await readFile(KEYBINDINGS_SAMPLE_PATH, "utf8");
    const { table } = await loadSamplesThroughRealPath(settingsRaw, raw);

    // ctrl+d is editor-core's default for addSelectionToNextFindMatch
    // (packages/builtin/editor-core/manifest.ts) — the sample's own
    // "-editor.action.addSelectionToNextFindMatch" entry removes it, so
    // nothing should resolve there any more.
    expect(table.lookup("ctrl+d", () => true)).toBeUndefined();
  });
});

/** Every real command id known to a full startup (`main.ts`'s own
 * composition — same two core-defaults arrays plus every built-in
 * manifest's `contributes.commands`, mirroring this file's own
 * `loadSamplesThroughRealPath` composition and the now-removed
 * `keybindingPresets.test.ts`'s identical "derive from the real sources,
 * don't hand-copy a list" approach, Issue #115). */
const ALL_COMMAND_IDS = new Set<string>([
  ...MODAL_DEFAULT_KEYBINDINGS.map((e) => e.command),
  ...TAB_DEFAULT_KEYBINDINGS.map((e) => e.command),
  ...builtinManifests.flatMap((m) => (m.contributes.commands ?? []).map((c) => c.id)),
]);

/** The target command of a `KeybindingContribution.command`, stripping a
 * leading `"-"` removal marker if present (`bindingTable.ts`'s
 * `compileEntry` does the same before validating). */
function targetCommand(raw: string): string {
  return raw.startsWith("-") ? raw.slice(1) : raw;
}

/**
 * Shared assertions for `samples/keybindings.emacs.json`/
 * `samples/keybindings.windows.json` (Issue #115, replacing the removed
 * `keybindings.preset` "emacs"/"windows" bundled schemes) — these are now
 * just plain, copyable `keybindings.json` starting points, so they get
 * the SAME "parses, loads cleanly, every command id is real" coverage as
 * `samples/keybindings.json` above, house style (no `describe.each`
 * precedent in this codebase) kept as two explicit `describe` blocks
 * below rather than parameterized here. A sample that stops parsing, or
 * that references a command id that no longer exists, fails CI instead of
 * shipping silently broken. Loaded with an empty `settings.json` (`"{}"`)
 * rather than the shared sample, since neither file has anything to do
 * with settings — only the `user` keybinding layer is under test here.
 */
/**
 * The Emacs sample's `ctrl+x ctrl+s` chord makes `ctrl+x` a chord PREFIX,
 * and `chords.ts`'s `handleIdleStroke` checks `hasSequencePrefix` FIRST,
 * unconditionally, before ever calling `lookup` — so editor-core's default
 * `ctrl+x` -> Cut stops firing directly the moment that chord exists. That
 * is faithful to real Emacs (C-x IS a prefix there, and cut is C-w), but it
 * means the sample MUST carry its own `ctrl+w` -> Cut entry or it silently
 * ships an editor with no working cut key. An earlier draft of this sample
 * claimed ctrl+x was unclaimed and shipped without that entry; this test
 * exists so that mistake cannot come back.
 *
 * Asserts against a REAL `BindingTable` built from the sample plus the two
 * default layers that actually collide with it, rather than re-reading the
 * file's text — the hazard is entirely about prefix-vs-exact resolution,
 * which only the table can answer.
 */
test("samples/keybindings.emacs.json keeps Cut reachable despite making ctrl+x a chord prefix", async () => {
  const raw = await readFile(EMACS_SAMPLE_PATH, "utf8");
  const parsed = parseJsonc<KeybindingContribution[]>(raw);
  expect(parsed.ok).toBe(true);

  const table = createBindingTable(
    {
      defaults: TAB_DEFAULT_KEYBINDINGS,
      fallback: [],
      extension: [
        { key: "ctrl+x", command: "editor.action.clipboardCut", when: "editorTextFocus" },
      ],
      user: parsed.ok ? parsed.value : [],
    },
    { log: createHostLog() },
  );

  const inEditor = (key: string) => (key === "editorTextFocus" ? true : undefined);
  const elsewhere = () => undefined;

  // ctrl+x really does become a prefix — the premise of the whole hazard.
  expect(table.hasSequencePrefix("ctrl+x", inEditor)).toBe(true);
  // ...so Cut has to live somewhere else, and the sample must provide it.
  expect(table.lookup("ctrl+w", inEditor)?.command).toBe("editor.action.clipboardCut");
  // The ctrl+w takeover is scoped: close-tab survives outside the editor.
  expect(table.lookup("ctrl+w", elsewhere)?.command).toBe("tab.close");
  // And the chord it all exists for still resolves.
  expect(table.lookup("ctrl+x ctrl+s", inEditor)?.command).toBe("editor.action.save");
});

function testKeybindingSamplePresetReplacement(samplePath: string): void {
  test("parses as a JSONC array via the repo's real parser", async () => {
    const raw = await readFile(samplePath, "utf8");
    const parsed = parseJsonc<unknown>(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.isArray(parsed.value)).toBe(true);
  });

  test("loads through a real BindingTable (defaults + fallback + every built-in's keybindings + this file as the user layer) with zero warnings", async () => {
    const raw = await readFile(samplePath, "utf8");
    const { bindingTableLog } = await loadSamplesThroughRealPath("{}", raw);

    expect(bindingTableLog.entries()).toEqual([]);
  });

  test("every entry's command (or -removal target) is a real command id", async () => {
    const raw = await readFile(samplePath, "utf8");
    const parsed = parseJsonc<KeybindingContribution[]>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(ALL_COMMAND_IDS.size).toBeGreaterThan(10); // sanity: the set isn't vacuous
    for (const entry of parsed.value) {
      expect(ALL_COMMAND_IDS.has(targetCommand(entry.command))).toBe(true);
    }
  });

  test("every non-removal entry actually wins at its own key, as the user layer (highest precedence)", async () => {
    const raw = await readFile(samplePath, "utf8");
    const parsed = parseJsonc<KeybindingContribution[]>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { table } = await loadSamplesThroughRealPath("{}", raw);
    const alwaysTrue = () => true;

    for (const entry of parsed.value) {
      if (entry.command.startsWith("-")) continue; // a removal has no resolved command of its own to check.
      const resolved = table.lookup(entry.key, alwaysTrue);
      expect(resolved?.command).toBe(entry.command);
      expect(resolved?.layer).toBe("user");
    }
  });
}

describe("samples/keybindings.emacs.json (Issue #115)", () => {
  testKeybindingSamplePresetReplacement(EMACS_SAMPLE_PATH);
});

describe("samples/keybindings.windows.json (Issue #115)", () => {
  testKeybindingSamplePresetReplacement(WINDOWS_SAMPLE_PATH);
});
