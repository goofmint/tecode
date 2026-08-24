import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir as nodeReaddir,
  rm,
  stat as nodeStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigurationContribution, Disposable, Manifest } from "@tecode/api";
import { createCommandRegistry } from "../commands/registry";
import type { DiscoveryFs } from "./discovery";
import { createHostLog, type HostError } from "./errors";
import { getUserExtensionsDir } from "./paths";
import {
  loadExtensions,
  registerExtension,
  type ConfigRegistrar,
} from "./registration";

/** A `StatusSink` stub that records every error it receives (matches
 * `commands/registry.test.ts`'s `createRecordingSink`). */
function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

/** A minimal, real, in-memory {@link ConfigRegistrar}: just enough of
 * `ConfigService.registerConfiguration`'s contract (Task 1.10) to prove
 * `registerExtension`/`loadExtensions` call it correctly — records every
 * property registered and every `dispose()`. */
function createRecordingConfigRegistrar(): ConfigRegistrar & {
  registered: ConfigurationContribution[];
  disposedCount: number;
} {
  const registered: ConfigurationContribution[] = [];
  let disposedCount = 0;
  return {
    registered,
    get disposedCount() {
      return disposedCount;
    },
    registerConfiguration(contribution) {
      registered.push(contribution);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          disposedCount += 1;
        },
      };
    },
  };
}

function fullManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "demo.ext",
    version: "1.0.0",
    apiVersion: "1.0",
    activationEvents: ["onStartup"],
    contributes: {
      commands: [{ id: "demo.run", title: "Run Demo" }],
      keybindings: [{ key: "ctrl+shift+r", command: "demo.run" }],
      views: [{ id: "demo.view", title: "Demo", slot: "sidebar" }],
      languages: [
        { id: "demo-lang", extensions: [".demo"], grammar: "g.wasm", highlights: "h.scm" },
      ],
      themes: [{ id: "demo-theme", label: "Demo Theme", path: "theme.json" }],
      configuration: { properties: { "demo.enabled": { type: "boolean", default: true } } },
    },
    ...overrides,
  };
}

describe("registerExtension", () => {
  test("registers each contributed command as lazy, attributed to the extension", async () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    registerExtension("demo.ext", fullManifest(), { commands, log });

    expect(commands.list()).toEqual([
      { id: "demo.run", title: "Run Demo", category: undefined, when: undefined },
    ]);
    const result = await commands.execute("demo.run");
    expect(result).toBeUndefined();
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings.some((w) => w.error.message.includes("demo.ext"))).toBe(true);
  });

  test("returns keybindings stamped with the owning extensionId, for the caller to accumulate into KeymapLayers.extension", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = registerExtension("demo.ext", fullManifest(), { commands, log });

    expect(result.keybindings).toEqual([
      { key: "ctrl+shift+r", command: "demo.run", extensionId: "demo.ext" },
    ]);
  });

  test("overwrites any extensionId already present on a contribution with the host's own — registerExtension is the only trustworthy source", () => {
    // In real startup this field is never populated this way — validate.ts's
    // `validateKeybindingContribution` rebuilds every entry as exactly
    // `{ key, command, when }` before registerExtension ever sees it
    // (`manifest.ts`'s `KeybindingContribution.extensionId` TSDoc). This
    // test instead proves registerExtension's OWN half of that guarantee
    // directly: even a contribution that already carries a (spoofed)
    // `extensionId` is unconditionally re-stamped with the real owner,
    // never trusted as-is.
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const manifest = fullManifest({
      contributes: {
        ...fullManifest().contributes,
        keybindings: [
          { key: "ctrl+shift+r", command: "demo.run", extensionId: "someone.else" },
        ],
      },
    });

    const result = registerExtension("demo.ext", manifest, { commands, log });

    expect(result.keybindings).toEqual([
      { key: "ctrl+shift+r", command: "demo.run", extensionId: "demo.ext" },
    ]);
  });

  test("collects views/languages/themes attributed to the extension", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = registerExtension("demo.ext", fullManifest(), { commands, log });

    expect(result.views).toEqual([
      { extensionId: "demo.ext", view: { id: "demo.view", title: "Demo", slot: "sidebar" } },
    ]);
    expect(result.languages).toEqual([
      {
        extensionId: "demo.ext",
        language: { id: "demo-lang", extensions: [".demo"], grammar: "g.wasm", highlights: "h.scm" },
      },
    ]);
    expect(result.themes).toEqual([
      { extensionId: "demo.ext", theme: { id: "demo-theme", label: "Demo Theme", path: "theme.json" } },
    ]);
  });

  test("calls the injected configRegistrar for contributes.configuration", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const configRegistrar = createRecordingConfigRegistrar();

    const result = registerExtension("demo.ext", fullManifest(), {
      commands,
      log,
      configRegistrar,
    });

    expect(configRegistrar.registered).toEqual([
      { properties: { "demo.enabled": { type: "boolean", default: true } } },
    ]);
    expect(result.disposables.length).toBeGreaterThanOrEqual(2); // 1 command + 1 config
  });

  test("omitting configRegistrar simply skips configuration registration (not an error)", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = registerExtension("demo.ext", fullManifest(), { commands, log });

    expect(log.entries()).toEqual([]);
    expect(result.disposables).toHaveLength(1); // just the command
  });

  test("a throwing configRegistrar is caught and logged; commands still register", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const configRegistrar: ConfigRegistrar = {
      registerConfiguration(): Disposable {
        throw new Error("registrar exploded");
      },
    };

    registerExtension("demo.ext", fullManifest(), {
      commands,
      log,
      configRegistrar,
    });

    expect(commands.list()).toHaveLength(1);
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings.some((w) => w.error.message.includes("registrar exploded"))).toBe(true);
  });

  test("a manifest with no contributions registers nothing and returns empty collections", () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const manifest: Manifest = {
      id: "empty.ext",
      version: "1.0.0",
      apiVersion: "1.0",
      activationEvents: ["onStartup"],
      contributes: {},
    };

    const result = registerExtension("empty.ext", manifest, { commands, log });

    expect(result).toEqual({
      disposables: [],
      keybindings: [],
      views: [],
      languages: [],
      themes: [],
    });
  });
});

// --- loadExtensions: full discover -> validate -> register pipeline --------

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

/** Same hermetic-fs technique as `discovery.test.ts` — see its TSDoc for
 * why a real `$HOME` mutation does not work under Bun here. Blocks the
 * real user extensions directory (ENOENT) so every `loadExtensions` test
 * is independent of whatever (if anything) is really there. */
function createHermeticFs(): DiscoveryFs {
  const blockedUserDir = getUserExtensionsDir();
  return {
    async readdir(path) {
      if (path === blockedUserDir) {
        throw Object.assign(new Error("ENOENT (blocked for test hermeticity)"), {
          code: "ENOENT",
        });
      }
      return nodeReaddir(path);
    },
    async stat(path) {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

async function writeManifestFixture(
  extensionsDir: string,
  name: string,
  manifestSource: string,
): Promise<string> {
  const extensionDir = join(extensionsDir, name);
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "manifest.ts"), manifestSource, "utf8");
  return extensionDir;
}

function manifestLiteral(manifest: Manifest): string {
  return `export default ${JSON.stringify(manifest)} as const;\n`;
}

describe("loadExtensions", () => {
  test("loads a real, valid workspace extension end to end: registered command, keybindings, config, pending contributions", async () => {
    const workspace = await makeTempDir("tecode-load-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(extensionsDir, "demo", manifestLiteral(fullManifest()));

    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const configRegistrar = createRecordingConfigRegistrar();

    const result = await loadExtensions({
      log,
      sink,
      commands,
      configRegistrar,
      workspaceRoot: workspace,
      fs: createHermeticFs(),
    });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.extensionId).toBe("demo.ext");
    expect(result.loaded[0]?.source).toBe("workspace");
    expect(result.skipped).toEqual([]);

    expect(commands.list().map((c) => c.id)).toEqual(["demo.run"]);
    expect(result.extensionKeybindings).toEqual([
      { key: "ctrl+shift+r", command: "demo.run", extensionId: "demo.ext" },
    ]);
    expect(result.pendingViews).toHaveLength(1);
    expect(result.pendingLanguages).toHaveLength(1);
    expect(result.pendingThemes).toHaveLength(1);
    expect(configRegistrar.registered).toHaveLength(1);
    expect(result.disposables.length).toBeGreaterThanOrEqual(2);
  });

  test("an invalid manifest is skipped with a reason, and does not block other extensions from loading (Req 2.4)", async () => {
    const workspace = await makeTempDir("tecode-load-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(
      extensionsDir,
      "broken",
      "export default { id: \"\" } as const;\n",
    );
    await writeManifestFixture(
      extensionsDir,
      "fine",
      manifestLiteral({
        id: "still.fine",
        version: "1.0.0",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      }),
    );

    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = await loadExtensions({
      log,
      sink,
      commands,
      workspaceRoot: workspace,
      fs: createHermeticFs(),
    });

    expect(result.loaded.map((e) => e.extensionId)).toEqual(["still.fine"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.sourcePath).toContain("broken");
    expect(result.skipped[0]?.reason).toContain("id:");
    expect(errors.some((e) => e.path?.includes("broken"))).toBe(true);
  });

  test("an API-version-incompatible manifest is skipped with a reason, not a crash (Req 2.7)", async () => {
    const workspace = await makeTempDir("tecode-load-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(
      extensionsDir,
      "future",
      manifestLiteral({
        id: "future.ext",
        version: "1.0.0",
        apiVersion: "99.0",
        activationEvents: ["onStartup"],
        contributes: {},
      }),
    );

    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = await loadExtensions({
      log,
      sink,
      commands,
      workspaceRoot: workspace,
      fs: createHermeticFs(),
    });

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.extensionId).toBe("future.ext");
    expect(result.skipped[0]?.reason).toContain("major version mismatch");
  });

  test("never imports any extension's index.ts across a full loadExtensions run", async () => {
    const workspace = await makeTempDir("tecode-load-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    const extensionDir = await writeManifestFixture(
      extensionsDir,
      "demo",
      manifestLiteral({
        id: "proof.demo",
        version: "1.0.0",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      }),
    );
    const markerPath = join(extensionDir, "MARKER");
    await writeFile(
      join(extensionDir, "index.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "imported");\n`,
      "utf8",
    );

    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });

    const result = await loadExtensions({
      log,
      sink,
      commands,
      workspaceRoot: workspace,
      fs: createHermeticFs(),
    });

    expect(result.loaded).toHaveLength(1);
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  test("builtins are loaded the same way as user/workspace extensions", async () => {
    const workspace = await makeTempDir("tecode-load-ws-");
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const builtin: Manifest = {
      id: "builtin.demo",
      version: "0.1.0",
      apiVersion: "1.0",
      activationEvents: ["onStartup"],
      contributes: { commands: [{ id: "builtin.run", title: "Run" }] },
    };

    const result = await loadExtensions({
      log,
      sink,
      commands,
      builtins: [builtin],
      workspaceRoot: workspace,
      fs: createHermeticFs(),
    });

    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.source).toBe("builtin");
    expect(commands.list().map((c) => c.id)).toEqual(["builtin.run"]);
  });
});
