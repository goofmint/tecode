import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir as nodeReaddir,
  readFile,
  rm,
  stat as nodeStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_THEME_ID,
  createHostLog,
  EXTENSIONS_RELOAD_COMMAND_ID,
  getUserExtensionsDir,
  KEYBINDINGS_ENSURE_FILE_COMMAND_ID,
  KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID,
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
  OPEN_FILE_COMMAND_ID,
  pathToUri,
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
  THEME_SELECT_COMMAND_ID,
  type DiscoveryFs,
} from "@tecode/core";
import pkg from "../package.json";
import { resolveStartupTarget } from "./argv";
import { buildAssemblyRoot, runDeferredPhase } from "./main";

/** A {@link DiscoveryFs} backed by the real filesystem, except the real
 * user extensions directory, which is always reported as missing
 * (matches `packages/core/src/host/discovery.test.ts`'s `createHermeticFs`
 * — Bun's `os.homedir()` does not honor a runtime `process.env.HOME`
 * mutation, so an in-process test cannot rely on the HOME-redirect trick
 * below to keep `discover()`'s `user` layer scan off the real machine's
 * `~/.config/tecode/extensions`; this blocks that one path explicitly
 * instead). */
function createHermeticDiscoveryFs(): DiscoveryFs {
  const blockedUserDir = getUserExtensionsDir();
  return {
    async readdir(path) {
      if (path === blockedUserDir) {
        throw Object.assign(new Error("ENOENT (blocked for test hermeticity)"), { code: "ENOENT" });
      }
      return nodeReaddir(path);
    },
    async stat(path) {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

test("--version prints the package version and exits 0", async () => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(stdout.trim()).toBe(pkg.version);
  expect(exitCode).toBe(0);
});

test("buildAssemblyRoot wires every core service and registers the 'tecode' module alias", async () => {
  // Importing main.ts (above) does not itself run `main()` — see main.ts's
  // `import.meta.main` guard — so calling buildAssemblyRoot() directly
  // here is safe and does not depend on this test file's own argv.
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-root-"));
  // Redirect the user-level config directory into this test's temp dir
  // (matches config/service.test.ts's real-filesystem test) so this never
  // reads or watches the real user's ~/.config/tecode files.
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    // Every namespace reachable via the assembled api.
    expect(Object.keys(root.api)).toEqual([
      "commands",
      "workspace",
      "window",
      "editor",
      "ui",
      "config",
      "context",
      "languages",
      "themes",
      "clipboard",
      "terminal",
    ]);

    expect(root.api.workspace.rootUri).toBe(pathToUri(dir));
    expect(Object.isFrozen(root.api)).toBe(true);

    // New in Task 1.15: the UI/keymap wiring buildAssemblyRoot now adds
    // alongside Task 1.13's api assembly.
    expect(root.slotRegistry).toBeDefined();
    expect(root.layoutState).toBeDefined();
    expect(root.theme.colors).toBeDefined();
    // Task 3.1: the `defaults` layer is no longer empty — `modal.*`'s 4
    // keybindings (`down`/`up`/`return`/`escape`) are seeded synchronously
    // by `createKeymapState(log, MODAL_DEFAULT_KEYBINDINGS)`, ahead of any
    // extension/user layer. Task 3.5 adds `tab.*`'s own 5 default keys
    // (`ctrl+tab`, `ctrl+pagedown`, `ctrl+shift+tab`, `ctrl+pageup`,
    // `ctrl+w` — `ui/tabCommands.ts`'s `TAB_DEFAULT_KEYBINDINGS`) to the
    // same layer, and Issue #105 adds `sidebarWidth`'s own 2 default keys
    // (`ctrl+k [`, `ctrl+k ]` — `ui/sidebarWidthCommands.ts`'s
    // `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS`): 4 + 5 + 2 = 11 distinct keys.
    expect(root.keymap.getTable().entries().size).toBe(11);
    const resolvedModalClose = root.keymap
      .getTable()
      .lookup("escape", (key) => key === "quickPickFocus" || key === "inputBoxFocus");
    expect(resolvedModalClose?.command).toBe("modal.close");
    expect(resolvedModalClose?.layer).toBe("defaults");
    expect(root.hostRef.current).toBeUndefined();

    // Task 2.6's theme wiring: the registry always has the built-in base
    // theme available synchronously, and the service starts on it (the
    // configured `workbench.colorTheme` is applied by `runTecode` itself,
    // after `config.ready` — buildAssemblyRoot's own TSDoc), and
    // `tecode.themes.current` reflects the same live service, not a
    // hardcoded stub.
    expect(root.themeRegistry.get(BASE_THEME_ID)).toBeDefined();
    expect(root.themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(root.api.themes.current).toBe(root.themeService.get());
    expect(root.themeConfigSync).toBeDefined();
    expect(root.themeSelectCommand).toBeDefined();
    expect(root.commands.list().some((c) => c.id === "theme.select")).toBe(true);

    // Task 2.2's key-routing wiring: the chord machine, editor session, and
    // input router this task adds alongside Task 1.15's original wiring.
    expect(root.chordMachine).toBeDefined();
    expect(root.editorSession).toBeDefined();
    expect(root.editorSession.getActiveDocumentUri()).toBeUndefined();
    expect(root.editorInputRouter).toBeDefined();
    expect(root.editorLangIdSync).toBeDefined();
    // No active document yet, so editorLangId reads as unset.
    expect(root.context.get("editorLangId")).toBeUndefined();
    // A stroke with no bindings at all reports "passthrough" — proves the
    // chord machine is live against `keymap`'s (currently empty) table.
    expect(root.chordMachine.handleStroke("a")).toBe("passthrough");

    // buildAssemblyRoot's own TSDoc documents that registerTecodeAlias runs
    // as its last step; `create.contract.test.ts` is where the resulting
    // `"tecode"` module-alias resolution is exercised end-to-end (the one
    // sanctioned dynamic `import("tecode")` test call site) — this test
    // stays focused on cli's composition wiring itself.
  } finally {
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- buildAssemblyRoot's `configDir` deps (Req 9.6, Issue #81 Phase 1's
// `--config <dir>` flag) — the end-to-end proof that a `--config`
// directory's `settings.json`/`keybindings.json` genuinely take effect,
// not just that the string was threaded through unchanged. ---

test("buildAssemblyRoot's configDir makes a --config directory's settings.json genuinely take effect", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "tecode-cli-config-"));
  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({ "editor.tabSize": 2 }),
    "utf8",
  );

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir, { configDir });
    await root.config.ready;

    // The value actually came from configDir's settings.json, not from
    // core's own default (4, `config/coreDefaults.ts`) — proof the
    // override was genuinely read, not merely accepted and ignored.
    expect(root.config.get<number>("editor.tabSize")).toBe(2);
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("buildAssemblyRoot's configDir makes a --config directory's keybindings.json genuinely take effect", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "tecode-cli-config-"));
  await writeFile(
    join(configDir, "keybindings.json"),
    JSON.stringify([{ key: "ctrl+alt+k", command: "fixture.fromConfigDir" }]),
    "utf8",
  );

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir, { configDir });
    await root.config.ready;

    expect(root.config.getKeybindingEntries()).toEqual([
      { key: "ctrl+alt+k", command: "fixture.fromConfigDir" },
    ]);
    // buildAssemblyRoot wires onKeybindingsChange straight into
    // keymap.setUserEntries — this proves the whole chain, not just
    // ConfigService's own raw entry array.
    const resolved = root.keymap.getTable().lookup("ctrl+alt+k", () => undefined);
    expect(resolved?.command).toBe("fixture.fromConfigDir");
    expect(resolved?.layer).toBe("user");
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("buildAssemblyRoot's configDir makes sidebarWidthSettingsWriter target the --config directory's settings.json (CodeRabbit PR #111 Finding 2)", async () => {
  // Regression test: `sidebarWidthSettingsWriter` used to be built with no
  // `path` at all, so it always fell back to `getUserSettingsPath()`
  // regardless of `--config` — reads came from the override (via
  // `ConfigService`'s own `settingsPath`) but writes went to the default
  // user file, so a resize commit never survived a restart under
  // `--config`. This proves the writer's actual disk write lands in
  // `configDir`, not the real user settings path.
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "tecode-cli-config-"));
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ "editor.tabSize": 2 }), "utf8");

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir, { configDir });
    await root.config.ready;

    root.sidebarWidthSettingsWriter.write(77);
    await root.sidebarWidthSettingsWriter.flush();

    const written = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    expect(written["workbench.sidebarWidth"]).toBe(77);
    // The pre-existing key from configDir's settings.json survived the
    // text-splice, and the real user settings path was never touched.
    expect(written["editor.tabSize"]).toBe(2);
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("forward-referenced activateExtension is a safe no-op before the deferred phase assigns hostRef", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-root-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;
    root.commands.registerLazy("fixture.stillLazy", { extensionId: "nobody-home" });
    // No host has been assigned yet (hostRef.current is undefined) —
    // execute() must resolve (never hang/throw) and report "not activated
    // yet" rather than crash on a missing activateExtension hook.
    const result = await root.commands.execute("fixture.stillLazy");
    expect(result).toBeUndefined();
  } finally {
    root.config.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDeferredPhase loads a workspace extension, activates it on startup, wires its keybindings, and opens the initial file", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-cli-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = homeDir;
  process.env["APPDATA"] = homeDir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    const extensionDir = join(workspaceDir, ".tecode", "extensions", "fixture");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "manifest.ts"),
      `export default {
        id: "fixture.startup-order",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "fixture.hello", title: "Fixture Hello" }],
          keybindings: [{ key: "ctrl+alt+t", command: "fixture.hello" }],
        },
      };\n`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "index.ts"),
      `export function activate(ctx) {
        ctx.subscriptions.push(
          ctx.api.commands.register("fixture.hello", () => "hello-from-fixture"),
        );
      }\n`,
      "utf8",
    );

    const targetFile = join(workspaceDir, "notes.txt");
    await writeFile(targetFile, "hello", "utf8");

    const { extensionHost, loadResult } = await runDeferredPhase(root, {
      initialFilePath: targetFile,
      fs: createHermeticDiscoveryFs(),
      // Isolate this test to the workspace fixture extension only — the
      // real `@tecode/builtin` `builtinManifests` (Task 2.3's `editor-core`
      // onward) would otherwise also load here and inflate `loadResult`.
      builtins: [],
    });

    expect(loadResult.loaded.map((e) => e.extensionId)).toEqual(["fixture.startup-order"]);
    expect(loadResult.skipped).toEqual([]);
    expect(extensionHost.getState("fixture.startup-order")).toBe("active");
    // hostRef is now fulfilled — commands/documents/slotRegistry's forward
    // references reach the real host.
    expect(root.hostRef.current).toBe(extensionHost);

    // The extension's activate(ctx) registered a real command.
    expect(await root.api.commands.execute("fixture.hello")).toBe("hello-from-fixture");

    // Its contributes.keybindings landed in the keymap's extension layer.
    const resolved = root.keymap.getTable().lookup("ctrl+alt+t", () => undefined);
    expect(resolved?.command).toBe("fixture.hello");
    expect(resolved?.layer).toBe("extension");

    // The argv-resolved initial file was opened.
    expect(root.documents.documents.some((d) => d.uri === pathToUri(targetFile))).toBe(true);

    await extensionHost.disposeAll();
  } finally {
    root.config.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}, 15_000);

test("Issue #88 end to end: `tecode README2.md` on a non-existent path opens an editable empty buffer, and saving it creates the real file on disk — through argv resolution, not just DocumentManager in isolation", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-cli-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = homeDir;
  process.env["APPDATA"] = homeDir;

  const targetFile = join(workspaceDir, "README2.md");
  // The load-bearing assumption under test: this file does NOT exist yet.
  await expect(nodeStat(targetFile)).rejects.toBeDefined();

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    // Real argv resolution (Req 5.6, Req 12.4, Issue #88) — the whole
    // point of this test is exercising `resolveStartupTarget` too, not
    // just handing `documentManager` a pre-resolved path.
    const log = createHostLog();
    const target = await resolveStartupTarget([targetFile], workspaceDir, log);
    expect(target).toEqual({ workspaceRoot: workspaceDir, initialFilePath: targetFile });
    expect(log.entries()).toEqual([]);

    root = buildAssemblyRoot(target.workspaceRoot);
    try {
      await root.config.ready;

      const { extensionHost, loadResult } = await runDeferredPhase(root, {
        initialFilePath: target.initialFilePath,
        fs: createHermeticDiscoveryFs(),
        builtins: [],
      });
      expect(loadResult.skipped).toEqual([]);

      // Opened as a new, empty, non-dirty document — not "No editor open."
      const uri = pathToUri(targetFile);
      const doc = root.documents.documents.find((d) => d.uri === uri);
      expect(doc).toBeDefined();
      expect(doc!.getText()).toBe("");
      expect(doc!.readonly).toBe(false);
      expect(doc!.dirty).toBe(false);

      // Opening alone must not have touched the real filesystem.
      await expect(nodeStat(targetFile)).rejects.toBeDefined();

      // Edit, then save through the real DocumentManager/real fs.
      doc!.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "# README2\n",
        },
      ]);
      const saved = await root.documents.save(uri);
      expect(saved).toBe(true);
      expect(doc!.dirty).toBe(false);

      // The real file now exists on disk with the expected content.
      const onDisk = await readFile(targetFile, "utf8");
      expect(onDisk).toBe("# README2\n");

      await extensionHost.disposeAll();
    } finally {
      root.config.dispose();
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}, 15_000);

test("runDeferredPhase reports a bad extension without failing startup (Req 2.4)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-cli-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = homeDir;
  process.env["APPDATA"] = homeDir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    const extensionDir = join(workspaceDir, ".tecode", "extensions", "broken");
    await mkdir(extensionDir, { recursive: true });
    // Missing required fields ("version", "apiVersion", ...) — validation
    // should skip it, not throw.
    await writeFile(join(extensionDir, "manifest.ts"), "export default { id: 'broken' };\n", "utf8");

    const { extensionHost, loadResult } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
      // Isolate this test to the broken workspace extension only — see the
      // sibling test above's identical `builtins: []` comment.
      builtins: [],
    });

    expect(loadResult.loaded).toEqual([]);
    expect(loadResult.skipped.length).toBe(1);
    expect(loadResult.skipped[0]?.extensionId).toBe("broken");
    await extensionHost.disposeAll();
  } finally {
    root.config.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}, 15_000);

// --- Issue #72: core commands are reserved BEFORE any extension can load ---
//
// The whole reserved-id guarantee (`commands/registry.ts`'s `registerCore`)
// depends on one assembly-order fact: `buildAssemblyRoot`'s synchronous
// phase registers all 13 core command ids via `registerCore` BEFORE
// `runDeferredPhase`'s `loadExtensions` call ever runs (this file's own
// `buildAssemblyRoot`/`runDeferredPhase` pair — the deferred phase is only
// ever invoked separately, after the sync phase already returned). These
// two tests pin that fact directly, rather than trusting it as an
// unverified assumption the unit-level `registry.test.ts` cases can't see.
const RESERVED_CORE_COMMAND_IDS = [
  OPEN_FILE_COMMAND_ID,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  KEYBINDINGS_ENSURE_FILE_COMMAND_ID,
  KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID,
  EXTENSIONS_RELOAD_COMMAND_ID,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  THEME_SELECT_COMMAND_ID,
];

test("buildAssemblyRoot registers every reserved core command id before runDeferredPhase (loadExtensions) ever runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-order-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    // runDeferredPhase (and therefore loadExtensions) has NOT been called
    // at this point — buildAssemblyRoot's synchronous phase is the only
    // thing that has run. Every reserved id is already registered.
    const ids = new Set(root.commands.list().map((c) => c.id));
    for (const id of RESERVED_CORE_COMMAND_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  } finally {
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an extension cannot shadow a core command: a manifest declaring tab.close is rejected, and a runtime register() override is rejected too, end to end through runDeferredPhase", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-cli-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-cli-ws-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = homeDir;
  process.env["APPDATA"] = homeDir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    // Before any extension loads, tab.close is already the real core
    // command (Req 6.5's tab.close, `ui/tabCommands.ts`).
    expect(root.commands.list().some((c) => c.id === TAB_CLOSE_COMMAND)).toBe(true);

    const extensionDir = join(workspaceDir, ".tecode", "extensions", "shadow-attempt");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "manifest.ts"),
      `export default {
        id: "fixture.shadow-attempt",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "${TAB_CLOSE_COMMAND}", title: "Evil Close" }]
        },
      };\n`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "index.ts"),
      `export function activate(ctx) {
        ctx.subscriptions.push(
          ctx.api.commands.register("${TAB_CLOSE_COMMAND}", () => "shadowed-by-extension"),
        );
      }\n`,
      "utf8",
    );

    const { extensionHost, loadResult } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
      builtins: [],
    });

    expect(loadResult.loaded.map((e) => e.extensionId)).toEqual(["fixture.shadow-attempt"]);
    expect(extensionHost.getState("fixture.shadow-attempt")).toBe("active");

    // Neither the manifest's contributes.commands declaration (registerLazy)
    // NOR the runtime tecode.commands.register call in activate() managed to
    // take over tab.close — the real core registration is still the one in
    // the registry.
    //
    // The registry entry's OWN metadata is what proves that, and it has to
    // be asserted rather than just the execute() result: with no open
    // document the real core handler is itself a no-op returning
    // `undefined`, and a successful manifest takeover would leave a
    // handler-less lazy entry whose execute() ALSO returns `undefined`
    // (the "not activated yet" path) — so `result !== "shadowed-by-
    // extension"` alone holds even when the core command has in fact been
    // destroyed. `title` distinguishes them unambiguously: "Close Editor"
    // is `ui/tabCommands.ts`'s own meta, "Evil Close" is the manifest's.
    expect(root.commands.list().find((c) => c.id === TAB_CLOSE_COMMAND)?.title).toBe(
      "Close Editor",
    );

    const result = await root.api.commands.execute(TAB_CLOSE_COMMAND);
    expect(result).not.toBe("shadowed-by-extension");

    await extensionHost.disposeAll();
  } finally {
    root.config.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}, 15_000);

test("buildAssemblyRoot's first-frame theme differs correctly between truecolor and 256-color terminals (Req 7.4)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-colordepth-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  const savedColorTerm = process.env["COLORTERM"];
  const savedTerm = process.env["TERM"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;

  let truecolorRoot: ReturnType<typeof buildAssemblyRoot>;
  let quantizedRoot: ReturnType<typeof buildAssemblyRoot>;
  try {
    process.env["COLORTERM"] = "truecolor";
    process.env["TERM"] = "xterm-256color";
    truecolorRoot = buildAssemblyRoot(dir);

    delete process.env["COLORTERM"];
    process.env["TERM"] = "xterm-256color";
    quantizedRoot = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
    if (savedColorTerm === undefined) delete process.env["COLORTERM"];
    else process.env["COLORTERM"] = savedColorTerm;
    if (savedTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = savedTerm;
  }

  try {
    // The base palette's own accent color, { r: 0, g: 122, b: 204 }
    // (`api/stubs.ts`'s BASE_COLORS), is not itself an xterm-256 palette
    // entry — quantization must visibly change it, proving the detected
    // color depth actually reached theme construction (this task's plan:
    // "256-color vs truecolor first-frame snapshots differ correctly").
    expect(truecolorRoot.theme.colors["statusBar.background"]).toEqual({ r: 0, g: 122, b: 204 });
    expect(quantizedRoot.theme.colors["statusBar.background"]).not.toEqual({ r: 0, g: 122, b: 204 });
    expect(quantizedRoot.theme.colors["statusBar.background"]).not.toEqual(
      truecolorRoot.theme.colors["statusBar.background"],
    );
  } finally {
    truecolorRoot!.config.dispose();
    truecolorRoot!.chordMachine.dispose();
    truecolorRoot!.editorSession.dispose();
    truecolorRoot!.editorLangIdSync.dispose();
    truecolorRoot!.themeConfigSync.dispose();
    truecolorRoot!.themeSelectCommand.dispose();
    quantizedRoot!.config.dispose();
    quantizedRoot!.chordMachine.dispose();
    quantizedRoot!.editorSession.dispose();
    quantizedRoot!.editorLangIdSync.dispose();
    quantizedRoot!.themeConfigSync.dispose();
    quantizedRoot!.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- applyKittyKeyboardVerdict (Req 4.7, design.md §6.5, Task 4.2) ---
//
// These exercise the WIRING from a Kitty-capability verdict, through
// `deps.loadFallbackKeybindings` (injected here — production's default
// wraps `@tecode/core`'s `loadFallbackKeybindings` against the real
// filesystem, `buildAssemblyRoot`'s own parameter TSDoc), to
// `keymap.setFallbackEntries` — `keymapState.test.ts` already proves
// `setFallbackEntries`'s own precedence behavior in isolation; this proves
// `main.ts` actually calls it with the right thing at the right time, with
// no real `CliRenderer`/terminal/filesystem involved at all.

test("applyKittyKeyboardVerdict(false) loads the injected fallback entries into the fallback layer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-kitty-verdict-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir, {
      loadFallbackKeybindings: () =>
        Promise.resolve([{ key: "ctrl+g", command: "workbench.action.showCommands" }]),
    });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.applyKittyKeyboardVerdict(false);
    const resolved = root.keymap.getTable().lookup("ctrl+g", () => undefined);
    expect(resolved?.command).toBe("workbench.action.showCommands");
    expect(resolved?.layer).toBe("fallback");
  } finally {
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyKittyKeyboardVerdict(true) clears the fallback layer to [] without even calling the loader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-kitty-verdict-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let loaderCalled = false;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir, {
      loadFallbackKeybindings: () => {
        loaderCalled = true;
        return Promise.resolve([{ key: "ctrl+g", command: "workbench.action.showCommands" }]);
      },
    });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.applyKittyKeyboardVerdict(true);
    expect(root.keymap.getTable().lookup("ctrl+g", () => undefined)).toBeUndefined();
    expect(loaderCalled).toBe(false);
  } finally {
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a slow false verdict's loader cannot clobber a newer true verdict (the real renderShell callback order)", async () => {
  // Reproduces exactly what `renderShell.tsx` does on a Kitty-capable
  // terminal: it calls back synchronously with `renderer.capabilities`,
  // which is still `null` at mount (the capability query is a round trip),
  // so the first verdict is a conservative `false` that starts an async
  // load; then the real answer arrives and produces `true`. If the slow
  // `false` load were allowed to apply after the `true` verdict cleared
  // the layer, a terminal that needs no fallback would be left with the
  // overlay active for the rest of the session.
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-kitty-verdict-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;

  let releaseLoader: () => void = () => {};
  const loaderGate = new Promise<void>((resolve) => {
    releaseLoader = resolve;
  });

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir, {
      loadFallbackKeybindings: async () => {
        await loaderGate;
        return [{ key: "ctrl+g", command: "workbench.action.showCommands" }];
      },
    });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    // Verdict 1: not-yet-known capabilities read as unsupported. Its
    // loader is deliberately still blocked on `loaderGate`.
    const slow = root.applyKittyKeyboardVerdict(false);
    // Verdict 2: the real answer says the terminal IS Kitty-capable.
    await root.applyKittyKeyboardVerdict(true);
    expect(root.keymap.getTable().lookup("ctrl+g", () => undefined)).toBeUndefined();

    // Now let the stale loader finish. It must discard its result.
    releaseLoader();
    await slow;
    expect(root.keymap.getTable().lookup("ctrl+g", () => undefined)).toBeUndefined();
  } finally {
    releaseLoader();
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyKittyKeyboardVerdict(false) never throws even when the loader itself throws — degrades to []", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-kitty-verdict-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir, {
      loadFallbackKeybindings: () => Promise.reject(new Error("boom")),
    });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await expect(root.applyKittyKeyboardVerdict(false)).resolves.toBeUndefined();
    expect(root.keymap.getTable().entries().size).toBe(11); // unchanged: modal + tab + sidebarWidth defaults only
    expect(root.log.entries().some((e) => e.level === "error")).toBe(true);
  } finally {
    root.config.dispose();
    root.chordMachine.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

