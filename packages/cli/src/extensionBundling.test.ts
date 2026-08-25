/**
 * Real-bundle validation for the extension-authoring guide's bundling
 * section (`docs/extension-authoring-guide.md` §3; Issue #37; Req 10.3,
 * 10.4; design.md §4.4). Closes a gap `extensionRecords.test.ts`'s own
 * "prefers a pre-bundled index.js" test leaves open: that test substitutes
 * LITERAL file contents for `index.js`/`index.ts` (`'export const MARKER =
 * "js"'`) to prove the *preference* logic in isolation — it never runs a
 * real `bun build`, never involves a real npm dependency, and calls
 * `buildExtensionRecord` directly rather than going through discovery/
 * validation/registration/activation. This file runs the actual procedure
 * an extension author follows: `bun install` a dependency, `bun build
 * ./index.ts --outfile=index.js --target=bun --format=esm`, delete every
 * source artifact the bundle made redundant, and drive the resulting bare
 * `manifest.ts` + `index.js` pair through the real pipeline via
 * `externalExtensionLoadHarness.ts` (the same established pattern
 * `externalExtensionLoading.test.ts` and this task's own
 * `extensionAuthoringGuideWalkthrough.test.ts` use).
 *
 * **Why the dependency is a local `file:` package, not a live npm-registry
 * fetch**: a real `bun install` against the public registry works fine in
 * this environment (verified manually against the real `ms` package while
 * authoring this test — it resolves through this environment's proxy in
 * well under a second) but would make this test's pass/fail depend on
 * network reachability and registry uptime at TEST TIME, in whatever
 * environment eventually runs `bun test` — exactly the kind of flakiness
 * this repo's testing conventions avoid, and CI environments in particular
 * often have no route to the public registry at all. A `file:`-protocol
 * dependency goes through the exact same `bun install` → real
 * `node_modules` → real `bun build` bundling mechanics as a registry
 * package (bundling doesn't know or care where a resolved package's source
 * came from) while keeping the whole test hermetic and fast (both
 * subprocess calls below complete in single-digit milliseconds). This is
 * the "explain what you did instead" this task's own instructions ask
 * for, not a quieter substitute for what's being proven: the thing that
 * could plausibly break — `bun build`'s bundling of a real dependency
 * graph into one ESM file the host's `import()` can load — still happens
 * for real, via a real subprocess.
 *
 * **Why NOT committed as a fixture asset**: this repo's own convention
 * (this task's validation checklist) is that `git status` stays clean of
 * "bundled fixture output that should be generated at test time" — so
 * every artifact below (the dependency package, the extension's
 * `node_modules`, and the bundled `index.js` itself) is generated fresh,
 * in a temp directory, inside this test, and torn down in `finally`.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cold subprocess module resolution/transpilation, PLUS a real `bun
// install` and a real `bun build` inside this same test — matches
// `externalExtensionLoading.test.ts`'s own override of the 5s default,
// generously, since none of those three steps is slow on its own (each
// verified independently at single-digit-to-low-double-digit
// milliseconds while authoring this test) but they do run in sequence.
setDefaultTimeout(30_000);

interface HarnessResult {
  loadedIds: string[];
  skipped: { extensionId: string; reason: string }[];
  states: Record<string, string | undefined>;
  commandResult: unknown;
  sidebarViewResolved: boolean;
  errorLogMessages: string[];
  configValue: unknown;
  fatal?: string;
}

/** Run a subprocess and fail the test immediately, with its full output,
 * if it exits non-zero — every step here (`bun install`, `bun build`)
 * needs to have actually succeeded for the rest of the test to mean
 * anything, so a silent failure here must not be allowed to surface later
 * as a confusing "extension failed to load" instead. */
async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode, `${cmd.join(" ")} (cwd=${cwd}) exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
}

/** Drive `externalExtensionLoadHarness.ts` as a child process against
 * `homeDir` as its `HOME`/`APPDATA` and execute `commandId` once the
 * pipeline has activated, returning its single JSON result line. Same
 * subprocess technique and failure reporting as
 * `externalExtensionLoading.test.ts`'s own helper — here it is what proves
 * the BUNDLED `index.js` (with `index.ts` and `node_modules` deleted) is
 * genuinely what the host loaded and ran. */
async function runHarness(homeDir: string, commandId: string): Promise<HarnessResult> {
  const harnessPath = join(import.meta.dir, "externalExtensionLoadHarness.ts");
  const proc = Bun.spawn({
    cmd: ["bun", "run", harnessPath, commandId, "", ""],
    env: { ...process.env, HOME: homeDir, APPDATA: homeDir },
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

test("a real bun build with a real npm dependency bundles into index.js, and the host loads/activates the bundled index.js alone (Req 10.3, 10.4, design.md §4.4)", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "tecode-ext-bundling-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-ext-bundling-home-"));
  try {
    // 1. A throwaway "npm package" the extension depends on — real
    // package.json + real module code, just not published anywhere.
    const depDir = join(workDir, "fixture-shout-lib");
    await mkdir(depDir, { recursive: true });
    await writeFile(
      join(depDir, "package.json"),
      JSON.stringify({ name: "fixture-shout-lib", version: "1.0.0", main: "index.js", type: "module" }),
      "utf8",
    );
    await writeFile(
      join(depDir, "index.js"),
      `export function shout(s) {\n  return s.toUpperCase() + "!";\n}\n`,
      "utf8",
    );

    // 2. The extension itself, built DIRECTLY where the harness will scan
    // for it (`<homeDir>/.config/tecode/extensions/bundled-dep`) — no
    // separate build-then-copy step, so there is only ever one directory
    // whose node_modules/index.ts get deleted in step 5 below: manifest.ts
    // (plain data, never bundled — Req 2.2) + a package.json depending on
    // the fixture package by an absolute file: specifier + index.ts
    // importing it.
    const extensionDir = join(homeDir, ".config", "tecode", "extensions", "bundled-dep");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "manifest.ts"),
      `export default {
        id: "example.bundled-dep",
        version: "0.1.0",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {
          commands: [{ id: "bundledDep.shout", title: "Shout" }],
        },
      } as const;\n`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "package.json"),
      JSON.stringify({
        name: "bundled-dep-fixture",
        version: "0.0.1",
        dependencies: { "fixture-shout-lib": `file:${depDir}` },
      }),
      "utf8",
    );
    await writeFile(
      join(extensionDir, "index.ts"),
      `import { shout } from "fixture-shout-lib";
      export function activate(ctx: { api: { commands: { register: Function } } }) {
        ctx.api.commands.register("bundledDep.shout", () => shout("hi"));
      }\n`,
      "utf8",
    );

    // 3. A REAL `bun install` — offline (a `file:` specifier is a plain
    // filesystem copy/symlink, no registry round-trip needed), but it goes
    // through the genuine package manager, producing a genuine
    // node_modules/fixture-shout-lib.
    await run(["bun", "install"], extensionDir);

    // 4. A REAL `bun build`, the exact invocation the guide's §3
    // documents, bundling index.ts AND fixture-shout-lib's code into one
    // ESM file.
    await run(
      ["bun", "build", "./index.ts", "--outfile=index.js", "--target=bun", "--format=esm"],
      extensionDir,
    );

    // 5. Delete every artifact the bundle made redundant — exactly what an
    // extension author ships is manifest.ts + index.js, nothing else. If
    // the host's `loadUserOrWorkspaceModule` needed node_modules or
    // index.ts to still be present, this test would fail from here on.
    await rm(join(extensionDir, "node_modules"), { recursive: true, force: true });
    await rm(join(extensionDir, "index.ts"));
    await rm(join(extensionDir, "package.json"));
    await rm(join(extensionDir, "bun.lock"), { force: true });
    await rm(join(extensionDir, "bun.lockb"), { force: true });

    // 6. Drive the bare manifest.ts + index.js pair through the real
    // pipeline, exactly as `externalExtensionLoading.test.ts`'s harness
    // does for an unbundled fixture.
    const result = await runHarness(homeDir, "bundledDep.shout");

    expect(result.skipped).toEqual([]);
    expect(result.loadedIds).toContain("example.bundled-dep");
    expect(result.states["example.bundled-dep"]).toBe("active");
    // "HI!" proves the bundled dependency's actual code ran inside the
    // host process, not just that SOME file was importable.
    expect(result.commandResult).toBe("HI!");
    expect(result.errorLogMessages).toEqual([]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
