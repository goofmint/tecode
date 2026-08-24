/**
 * External extension loading (GitHub issue #32; Req 2.1, 2.4-2.6, 2.8,
 * 10.3, 10.4; design.md §4.4): real, on-disk external extensions — from
 * BOTH sources Req 2.1 names, each immediate subdirectory of
 * `~/.config/tecode/extensions` (`user`) and of
 * `<workspaceRoot>/.tecode/extensions` (`workspace`) — loaded via
 * `import(pathToFileURL(file).href)` — load, activate, and contribute a
 * working command AND view; a broken sibling (parse error, throwing
 * `activate`, invalid manifest) is isolated with a surfaced error and
 * never blocks the healthy one.
 *
 * Drives `externalExtensionLoadHarness.ts` as a genuine spawned child
 * process with `HOME` set (at launch) to a disposable temp directory —
 * see that harness's own TSDoc for why this is the only way to exercise a
 * real "user"-sourced `index.ts` dynamic import hermetically (a runtime
 * `$HOME` mutation does not work under Bun, and `extensionRecords.ts` has
 * no injectable import seam for `index.ts`, unlike `discovery.ts`'s
 * manifest-only `DiscoveryFs`/`importModule` seams).
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cold subprocess module resolution/transpilation (matches
// `main.integration.test.ts`'s own override of the same 5s default).
setDefaultTimeout(30_000);

async function writeFixture(
  extensionsDir: string,
  name: string,
  manifestSource: string,
  indexSource?: string,
): Promise<void> {
  const dir = join(extensionsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.ts"), manifestSource, "utf8");
  if (indexSource !== undefined) {
    await writeFile(join(dir, "index.ts"), indexSource, "utf8");
  }
}

interface HarnessResult {
  loadedIds: string[];
  skipped: { extensionId: string; reason: string }[];
  states: Record<string, string | undefined>;
  commandResult: unknown;
  sidebarViewResolved: boolean;
  errorLogMessages: string[];
  fatal?: string;
}

async function runHarness(
  homeDir: string,
  commandId: string,
  viewId: string,
  workspaceRoot = "",
): Promise<HarnessResult> {
  const harnessPath = join(import.meta.dir, "externalExtensionLoadHarness.ts");
  const proc = Bun.spawn({
    cmd: ["bun", "run", harnessPath, commandId, viewId, workspaceRoot],
    env: {
      ...process.env,
      HOME: homeDir,
      APPDATA: homeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  expect(line, `harness printed no JSON line; exitCode=${exitCode}, stderr:\n${stderr}`).toBeDefined();
  const result = JSON.parse(line!) as HarnessResult;
  expect(result.fatal, `harness reported a fatal error: ${result.fatal}; stderr:\n${stderr}`).toBeUndefined();
  return result;
}

test("a real user-sourced extension loads, activates, and contributes a working command AND view (Req 2.1, 2.5, 2.6, 10.4)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-extload-home-"));
  try {
    const extensionsDir = join(homeDir, ".config", "tecode", "extensions");
    await writeFixture(
      extensionsDir,
      "healthy",
      `export default {
        id: "fixture.healthy",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "fixture.healthy.run", title: "Run" }],
          views: [{ id: "fixture.healthy.view", title: "Healthy View", slot: "sidebar" }],
        },
      } as const;\n`,
      `export function activate(ctx: { api: { commands: { register: Function }; ui: { registerView: Function } } }) {
        ctx.api.commands.register("fixture.healthy.run", () => "healthy-ran");
        ctx.api.ui.registerView("sidebar.view", "fixture.healthy.view", () => null);
      }\n`,
    );

    const result = await runHarness(homeDir, "fixture.healthy.run", "fixture.healthy.view");

    expect(result.loadedIds).toContain("fixture.healthy");
    expect(result.states["fixture.healthy"]).toBe("active");
    expect(result.commandResult).toBe("healthy-ran");
    expect(result.sidebarViewResolved).toBe(true);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a broken sibling (parse error / throwing activate / invalid manifest) is isolated, with errors surfaced, and never blocks the healthy extension (Req 2.4)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-extload-home-"));
  try {
    const extensionsDir = join(homeDir, ".config", "tecode", "extensions");

    await writeFixture(
      extensionsDir,
      "healthy",
      `export default {
        id: "fixture.healthy",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "fixture.healthy.run", title: "Run" }],
          views: [{ id: "fixture.healthy.view", title: "Healthy View", slot: "sidebar" }],
        },
      } as const;\n`,
      `export function activate(ctx: { api: { commands: { register: Function }; ui: { registerView: Function } } }) {
        ctx.api.commands.register("fixture.healthy.run", () => "healthy-ran");
        ctx.api.ui.registerView("sidebar.view", "fixture.healthy.view", () => null);
      }\n`,
    );

    // (a) a syntax error in index.ts — Bun's runtime transpile of this
    // file throws when `loadModule()` dynamically imports it.
    await writeFixture(
      extensionsDir,
      "syntax-error",
      `export default {
        id: "fixture.syntax-error",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      } as const;\n`,
      `export function activate() {\n  const x = ;\n}\n`,
    );

    // (b) an activate() that throws.
    await writeFixture(
      extensionsDir,
      "throwing-activate",
      `export default {
        id: "fixture.throwing-activate",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      } as const;\n`,
      `export function activate() {\n  throw new Error("boom from fixture.throwing-activate");\n}\n`,
    );

    // (c) an invalid manifest (empty id fails validation — matches
    // `registration.test.ts`'s own "broken" fixture).
    await writeFixture(extensionsDir, "invalid-manifest", `export default { id: "" } as const;\n`);

    const result = await runHarness(homeDir, "fixture.healthy.run", "fixture.healthy.view");

    // The healthy extension is completely unaffected by its three broken
    // siblings.
    expect(result.loadedIds).toContain("fixture.healthy");
    expect(result.states["fixture.healthy"]).toBe("active");
    expect(result.commandResult).toBe("healthy-ran");
    expect(result.sidebarViewResolved).toBe(true);

    // The invalid manifest never reaches "loaded" at all — it is
    // reported in `skipped` with a reason (Req 2.4). Its manifest's own
    // `id` is empty (invalid), so `discovery.ts` falls back to the
    // directory name ("invalid-manifest") for attribution.
    expect(result.loadedIds).not.toContain("fixture.invalid-manifest");
    const invalidSkip = result.skipped.find((s) => s.extensionId === "invalid-manifest");
    expect(invalidSkip, JSON.stringify(result.skipped)).toBeDefined();
    expect(invalidSkip?.reason).toContain("id");

    // The syntax-error and throwing-activate extensions ARE discovered,
    // validated, and registered (their manifests are fine) but end up
    // "failed" once `activateStartupExtensions()` tries to run their
    // index.ts (host/activation.ts's real `ActivationState`).
    expect(result.loadedIds).toContain("fixture.syntax-error");
    expect(result.states["fixture.syntax-error"]).toBe("failed");
    expect(result.loadedIds).toContain("fixture.throwing-activate");
    expect(result.states["fixture.throwing-activate"]).toBe("failed");

    // Both failures were surfaced through the HostLog, not swallowed.
    expect(result.errorLogMessages.some((m) => m.includes("fixture.syntax-error"))).toBe(true);
    expect(
      result.errorLogMessages.some(
        (m) => m.includes("fixture.throwing-activate") && m.includes("boom from fixture.throwing-activate"),
      ),
    ).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a real workspace-sourced extension under <workspaceRoot>/.tecode/extensions loads, activates, and contributes a working command AND view (Req 2.1, 10.4)", async () => {
  // A temp HOME with NO user extensions at all, so anything the harness
  // reports can only have come from the workspace source — this is what
  // makes the assertion about `workspace` specifically, rather than about
  // "some external extension somewhere".
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-extload-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tecode-extload-ws-"));
  try {
    await writeFixture(
      join(workspaceRoot, ".tecode", "extensions"),
      "ws",
      `export default {
        id: "fixture.workspace",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "fixture.workspace.run", title: "Run" }],
          views: [{ id: "fixture.workspace.view", title: "Workspace View", slot: "sidebar" }],
        },
      } as const;\n`,
      `export function activate(ctx: { api: { commands: { register: Function }; ui: { registerView: Function } } }) {
        ctx.api.commands.register("fixture.workspace.run", () => "workspace-ran");
        ctx.api.ui.registerView("sidebar.view", "fixture.workspace.view", () => null);
      }\n`,
    );

    const result = await runHarness(
      homeDir,
      "fixture.workspace.run",
      "fixture.workspace.view",
      workspaceRoot,
    );

    expect(result.loadedIds).toEqual(["fixture.workspace"]);
    expect(result.states["fixture.workspace"]).toBe("active");
    expect(result.commandResult).toBe("workspace-ran");
    expect(result.sidebarViewResolved).toBe(true);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
