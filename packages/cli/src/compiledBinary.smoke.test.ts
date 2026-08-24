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
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A compiled binary's cold start (loading a ~110 MB executable off disk for
// the first time) plus this test's own temp-directory setup can exceed
// bun:test's 5s default, independent of the app's own <100ms first-frame
// budget — matches `main.integration.test.ts`'s identical override.
setDefaultTimeout(30_000);

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

describe.skipIf(!bin)("compiled binary smoke test (TECODE_BIN)", () => {
  test("opens a workspace, embedded assets resolve with no external files, and an external extension loads (Req 8.5, 10.4, 13.2)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "tecode-compiled-smoke-home-"));
    const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-compiled-smoke-ws-"));

    try {
      // A healthy external extension under the REAL user extensions
      // directory (`@tecode/core`'s `getUserExtensionsDir` —
      // `~/.config/tecode/extensions`), declaring `onStartup` so it
      // activates during this headless run with no keystrokes needed —
      // same fixture shape as `externalExtensionLoading.test.ts`'s
      // `writeFixture`, exercising Task 4.1's runtime `import()` loading
      // mechanism from INSIDE a compiled binary rather than a plain `bun
      // run` process.
      const extensionDir = join(homeDir, ".config", "tecode", "extensions", "smoke-fixture");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        join(extensionDir, "manifest.ts"),
        `export default {
          id: "fixture.compiled-smoke",
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

      // A real TS file so the workspace has something for `languages-basic`
      // (embedded grammar/highlights) to resolve a language for, even
      // though headless mode never opens it without an argv file path —
      // this proves the DIRECTORY-open path (Req 12.1's directory launch),
      // matching this task's own "opens a directory" completion wording.
      await writeFile(join(workspaceDir, "sample.ts"), "export const answer: number = 42;\n", "utf8");

      const proc = Bun.spawn({
        cmd: [bin!, workspaceDir],
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

      expect(exitCode, `expected clean exit; stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);

      // The exact failure mode Finding 4 (`main.ts`'s `treeSitterRuntimeWasmPath`
      // TSDoc) exists to prevent: `web-tree-sitter`'s `Parser.init()` trying
      // to resolve its runtime wasm off a real filesystem path that does not
      // exist inside a compiled binary. Neither substring should appear —
      // in practice, a healthy compiled binary emits 0 bytes on stderr for
      // this whole run (verified by hand for this task).
      expect(stderr).not.toContain("tree-sitter.wasm");
      expect(stderr.toLowerCase()).not.toContain("abort");

      const lines = parseJsonLines(stdout);
      const headlessExit = lines.find((l) => l.event === "tecode.headlessExit");
      const fixtureActivated = lines.find((l) => l.event === "fixture.compiledSmokeActivated");

      expect(headlessExit, `expected a tecode.headlessExit line; stdout:\n${stdout}`).toBeDefined();
      expect(fixtureActivated, `external extension never activated; stdout:\n${stdout}`).toBeDefined();

      // 8: the 7 real `@tecode/builtin` built-ins (`main.integration.
      // test.ts`'s own count) PLUS this test's external user extension —
      // proof that embedded built-ins and a genuinely-external, on-disk
      // extension both loaded successfully in the SAME compiled-binary run.
      expect(headlessExit?.["loaded"]).toBe(8);
      expect(headlessExit?.["skipped"]).toBe(0);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
