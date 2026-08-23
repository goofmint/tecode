import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir as nodeReaddir, rm, stat as nodeStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserExtensionsDir, pathToUri, type DiscoveryFs } from "@tecode/core";
import pkg from "../package.json";
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
    ]);

    expect(root.api.workspace.rootUri).toBe(pathToUri(dir));
    expect(Object.isFrozen(root.api)).toBe(true);

    // New in Task 1.15: the UI/keymap wiring buildAssemblyRoot now adds
    // alongside Task 1.13's api assembly.
    expect(root.slotRegistry).toBeDefined();
    expect(root.layoutState).toBeDefined();
    expect(root.theme.colors).toBeDefined();
    expect(root.keymap.getTable().entries().size).toBe(0);
    expect(root.hostRef.current).toBeUndefined();

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
    await rm(dir, { recursive: true, force: true });
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

