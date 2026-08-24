/**
 * Compiled-binary smoke test (Issue #35 "4.4 Compiled binary builds"; Req
 * 8.5, 10.4, 13.2; design.md §4.4, §17). Exercises a REAL `bun build
 * --compile` output — not `bun run packages/cli/src/main.ts` like every
 * other subprocess test in this package (`main.integration.test.ts`,
 * `externalExtensionLoading.test.ts`) — because only a compiled binary can
 * prove the two things those other tests structurally cannot: that
 * embedded-asset resolution (Task 2.8's asset-URI indirection —
 * `languageAssetsFs.ts`/`themeAssetsFs.ts`'s overlays, `main.ts`'s
 * `web-tree-sitter` runtime-wasm embed) still works once every one of
 * those assets has been baked into a `/$bunfs/...` virtual filesystem
 * instead of read off real files, and that `bun build --compile`'s own
 * module bundling hasn't broken the SEPARATE, deliberately-NOT-embedded
 * path Task 4.1 relies on: an external extension's `.ts` source loading
 * via a genuine runtime `import()` of a real on-disk file
 * (`pathToFileURL(file).href` — design.md §4.4's "External extensions load
 * via `import(pathToFileURL(file).href)`... Bun's runtime transpiles TS/TSX
 * on the fly") from OUTSIDE the compiled binary's own embedded module
 * graph.
 *
 * **The `TECODE_BIN` convention** (new to this repo — no other test uses
 * it): this suite needs an actual compiled binary on disk, which `bun
 * test` cannot produce itself (a `bun build --compile` invocation takes
 * real wall-clock time and writes a ~110 MB file — `scripts/release.ts`'s
 * own TSDoc measured `bun-linux-x64` at 114,968,726 bytes) — building one
 * as a `beforeAll` here would make every ordinary `bun test` run minutes
 * slower and disk-hungrier for a check the normal edit-test loop has no
 * need for. Instead, this suite reads the `TECODE_BIN` environment
 * variable naming a pre-built binary and skips ENTIRELY (`describe.skipIf`,
 * matching `gitRunner.test.ts`'s own environment-gated `hasGit` skip) when
 * it is unset — so the baseline `bun test` run (no `TECODE_BIN`) is
 * unaffected, and a human or CI job opts in explicitly:
 *
 * ```
 * bun run release bun-linux-x64
 * TECODE_BIN=dist/tecode-linux-x64 bun test packages/cli/src/compiledBinary.smoke.test.ts
 * ```
 *
 * `scripts/release.ts`'s own TSDoc documents this same convention from the
 * build side, so either file is a valid entry point for a reader trying to
 * find out how to actually run this suite.
 *
 * **Finding 3 of Issue #35's PR review — proving embedded-asset resolution,
 * not just "nothing crashed"**: an earlier version of this test opened
 * only a WORKSPACE DIRECTORY, never an actual file — its own comment
 * conceded headless mode "never opens [a file] without an argv file path".
 * `languages-basic`'s embedded grammar WASM/`.scm` queries were therefore
 * never exercised at all; `exitCode === 0` plus "no `tree-sitter.wasm` in
 * stderr" proved nothing about Req 8.5. Worse, "assert no degradation
 * warning" alone would have been VACUOUS: if the language never resolves
 * at all, there is also no warning — silence is not success.
 *
 * The fix (`main.ts`'s `runTecode` TSDoc has the full story): `tecode.
 * headlessExit` now also reports `activated` (every extension id that
 * genuinely reached `"active"`, per `ExtensionHost.getState` — not merely
 * "registered") and `logWarnings`/`logErrors` (a `HostLog` entry count).
 * `"activated"` test below spawns the binary against the fixture `.ts`
 * FILE itself (not its directory) — the one argv shape that actually opens
 * a document (`argv.ts`'s `resolveStartupTarget`) and so actually fires
 * `onLanguage:typescript`, activating `languages-basic` and triggering its
 * real embedded grammar-WASM + `.scm`-query load
 * (`highlightService.ts`'s `getOrLoadLanguageAssets`, awaited via this
 * task's new `HighlightService.whenIdle()` before `runTecode` ever reports
 * the metric or exits — without that wait, the load is fire-and-forget and
 * the metric would race it, see that method's TSDoc).
 *
 * This suite proves the `logWarnings`/`logErrors` check is not vacuous by
 * comparing the FILE-open run against a same-shape DIRECTORY-open run
 * (below), rather than asserting a bare `0` — `main.ts`'s own headless
 * startup logs a fixed set of warnings that have nothing to do with
 * language loading at all (e.g. "could not watch user settings" on a
 * brand-new `HOME` with no `settings.json` yet), so an absolute `0` would
 * be wrong for reasons unrelated to this task on ANY headless run, real
 * embedded-asset regression or not. Comparing the two runs isolates
 * exactly the delta opening the `.ts` file causes: {@link
 * https://internal/issue-35-pr75-finding-3 this task's own manual
 * verification} built a real `bun-linux-x64` binary, sabotaged
 * `languages-basic/manifest.ts`'s `typescript` grammar path to a
 * nonexistent file, and confirmed the file-open run's `logWarnings`
 * climbed by exactly 1 over the directory-only baseline (the grammar's
 * one-time degradation warning) while `activated` STILL listed
 * `tecode.languages-basic` — proof that `activated` alone is exactly the
 * vacuous check this task's finding warned about, and that the
 * `logWarnings` delta is what actually catches a broken embedded asset.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGUAGES_BASIC_EXTENSION_ID } from "@tecode/builtin/languages-basic/manifest";

// A compiled binary's cold start (loading a ~110 MB executable off disk for
// the first time) plus this test's own temp-directory setup can exceed
// bun:test's 5s default, independent of the app's own <100ms first-frame
// budget — matches `main.integration.test.ts`'s identical override. This
// suite spawns the binary TWICE (file-open + directory-open), so the
// budget below covers both.
setDefaultTimeout(45_000);

const bin = process.env["TECODE_BIN"];

interface JsonLine {
  event: string;
  [key: string]: unknown;
}

function parseJsonLines(output: string): JsonLine[] {
  const lines: JsonLine[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(trimmed) as JsonLine);
    } catch {
      // Not one of our structured lines — ignore rather than fail the
      // whole parse (matches `main.integration.test.ts`'s own parser).
    }
  }
  return lines;
}

/** Plant a healthy, `onStartup` external extension under the REAL user
 * extensions directory (`@tecode/core`'s `getUserExtensionsDir`) inside
 * `homeDir` — same fixture shape as `externalExtensionLoading.test.ts`'s
 * `writeFixture`, exercising Task 4.1's runtime `import()` loading
 * mechanism from INSIDE a compiled binary rather than a plain `bun run`
 * process. Returns the fixture's manifest id, for assertions.
 *
 * This CANNOT just call `getUserExtensionsDir()` itself: that function
 * reads `process.platform`/`process.env["APPDATA"]` from THIS (the test
 * runner's) process, but what actually matters is what the CHILD binary
 * resolves — and the child is spawned below with both `HOME` and `APPDATA`
 * overridden to `homeDir`. On the same host OS the two agree, so
 * mirroring the rule locally by hand (source of truth: `packages/core/
 * src/host/paths.ts`'s `getUserConfigDir`/`getUserExtensionsDir` — POSIX:
 * `~/.config/tecode`; `win32`: `%APPDATA%\tecode`, i.e. `join(APPDATA,
 * "tecode")`) is both correct and the only option: unconditionally
 * hardcoding the POSIX `.config` shape here (as an earlier version of this
 * test did — Finding 2) would plant the fixture where a Windows-built/run
 * binary's own `getUserExtensionsDir()` never looks, silently failing to
 * discover it and failing this test's assertions for the wrong reason. */
async function writeExternalFixture(homeDir: string): Promise<string> {
  const fixtureId = "fixture.compiled-smoke";
  const userExtensionsDir =
    process.platform === "win32" ? join(homeDir, "tecode", "extensions") : join(homeDir, ".config", "tecode", "extensions");
  const extensionDir = join(userExtensionsDir, "smoke-fixture");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "manifest.ts"),
    `export default {
      id: "${fixtureId}",
      version: "0.0.1",
      apiVersion: "1.0",
      activationEvents: ["onStartup"],
      contributes: {},
    } as const;\n`,
    "utf8",
  );
  await writeFile(
    join(extensionDir, "index.ts"),
    `export function activate() {
      console.log(JSON.stringify({ event: "fixture.compiledSmokeActivated" }));
    }\n`,
    "utf8",
  );
  return fixtureId;
}

/** Spawn `bin` headless against `target` (a file OR a directory —
 * `argv.ts`'s `resolveStartupTarget` branches on which) with a fresh
 * `HOME`/`APPDATA`, parse its stdout JSON-line metrics, and return
 * everything both this suite's tests need. Shared so the file-open and
 * directory-open runs below use the byte-for-byte identical spawn shape —
 * the only variable between them is `target`. */
async function runHeadless(
  target: string,
  homeDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; lines: JsonLine[] }> {
  const proc = Bun.spawn({
    cmd: [bin!, target],
    env: {
      ...process.env,
      HOME: homeDir,
      APPDATA: homeDir,
      TECODE_HEADLESS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, lines: parseJsonLines(stdout) };
}

describe.skipIf(!bin)("compiled binary smoke test (TECODE_BIN)", () => {
  test("opening a REAL .ts file activates languages-basic and loads its embedded grammar/highlights with zero NEW HostLog warnings (Req 8.5, 10.4, 13.2)", async () => {
    const fileHomeDir = await mkdtemp(join(tmpdir(), "tecode-compiled-smoke-home-file-"));
    const dirHomeDir = await mkdtemp(join(tmpdir(), "tecode-compiled-smoke-home-dir-"));
    const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-compiled-smoke-ws-"));

    try {
      const fixtureId = await writeExternalFixture(fileHomeDir);
      await writeExternalFixture(dirHomeDir);

      const sampleFile = join(workspaceDir, "sample.ts");
      await writeFile(sampleFile, "export const answer: number = 42;\n", "utf8");

      // The DIRECTORY-open baseline (Req 12.1's directory launch still
      // matters — this task's own "keep a directory-launch assertion too")
      // — no file is opened, so `languages-basic` never activates and no
      // grammar ever loads. Its `logWarnings`/`logErrors` are the "nothing
      // to do with languages" floor every headless run of this binary
      // produces (this suite's own TSDoc) — the FILE-open run below is
      // compared against exactly this, not against a bare 0.
      const dirRun = await runHeadless(workspaceDir, dirHomeDir);
      expect(dirRun.exitCode, `expected clean exit; stdout:\n${dirRun.stdout}\nstderr:\n${dirRun.stderr}`).toBe(0);
      const dirHeadlessExit = dirRun.lines.find((l) => l.event === "tecode.headlessExit");
      expect(dirHeadlessExit, `expected a tecode.headlessExit line; stdout:\n${dirRun.stdout}`).toBeDefined();
      expect(dirHeadlessExit?.["loaded"]).toBe(8);
      expect(dirHeadlessExit?.["skipped"]).toBe(0);
      expect((dirHeadlessExit?.["activated"] as string[]) ?? []).not.toContain(LANGUAGES_BASIC_EXTENSION_ID);

      // The FILE-open run — the one that actually exercises embedded-asset
      // resolution (this suite's own TSDoc).
      const fileRun = await runHeadless(sampleFile, fileHomeDir);
      expect(fileRun.exitCode, `expected clean exit; stdout:\n${fileRun.stdout}\nstderr:\n${fileRun.stderr}`).toBe(0);

      // The exact failure mode Finding 4 (`main.ts`'s `treeSitterRuntimeWasmPath`
      // TSDoc) exists to prevent: `web-tree-sitter`'s `Parser.init()` trying
      // to resolve its runtime wasm off a real filesystem path that does not
      // exist inside a compiled binary. Neither substring should appear —
      // in practice, a healthy compiled binary emits 0 bytes on stderr for
      // this whole run (verified by hand for this task).
      expect(fileRun.stderr).not.toContain("tree-sitter.wasm");
      expect(fileRun.stderr.toLowerCase()).not.toContain("abort");

      const headlessExit = fileRun.lines.find((l) => l.event === "tecode.headlessExit");
      const fixtureActivated = fileRun.lines.find((l) => l.event === "fixture.compiledSmokeActivated");
      expect(headlessExit, `expected a tecode.headlessExit line; stdout:\n${fileRun.stdout}`).toBeDefined();
      expect(fixtureActivated, `external extension never activated; stdout:\n${fileRun.stdout}`).toBeDefined();

      // 8: the 7 real `@tecode/builtin` built-ins (`main.integration.
      // test.ts`'s own count) PLUS this test's external user extension —
      // proof that embedded built-ins and a genuinely-external, on-disk
      // extension both loaded successfully in the SAME compiled-binary run.
      expect(headlessExit?.["loaded"]).toBe(8);
      expect(headlessExit?.["skipped"]).toBe(0);

      // Positive evidence (this suite's own TSDoc, Finding 3): both
      // `languages-basic` (its real manifest id) and the external fixture
      // genuinely reached `"active"` — not merely "registered".
      const activated = (headlessExit?.["activated"] as string[]) ?? [];
      expect(activated, `expected languages-basic + fixture in activated: ${JSON.stringify(activated)}`).toEqual(
        expect.arrayContaining([LANGUAGES_BASIC_EXTENSION_ID, fixtureId]),
      );

      // The non-vacuous check: opening the `.ts` file produced NO NEW
      // `HostLog` warnings/errors over the directory-only baseline above —
      // i.e., the embedded grammar WASM + `.scm` query genuinely loaded
      // and compiled without `highlightService.ts`'s one-time degradation
      // warning ever firing. This suite's own TSDoc records sabotaging
      // `languages-basic`'s grammar path and confirming this exact
      // assertion is what catches it (a `+1` over baseline), while
      // `activated` above stays unchanged either way.
      expect(headlessExit?.["logWarnings"]).toBe(dirHeadlessExit?.["logWarnings"]);
      expect(headlessExit?.["logErrors"]).toBe(0);
      expect(dirHeadlessExit?.["logErrors"]).toBe(0);
    } finally {
      await rm(fileHomeDir, { recursive: true, force: true });
      await rm(dirHomeDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
