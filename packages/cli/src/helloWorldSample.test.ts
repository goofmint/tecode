/**
 * Guards against the Hello World sample (`samples/extensions/hello-world/`,
 * Issue #148) drifting out of sync with the real extension pipeline — the
 * same "load the real fixture through the real pipeline" idea
 * `extensionAuthoringGuideWalkthrough.test.ts` applies to the extension
 * authoring guide's own walkthrough code. Copies the actual sample files
 * on disk into a disposable temp `HOME`'s user extensions directory, runs
 * `externalExtensionLoadHarness.ts` against them (see that harness's own
 * TSDoc for why this must be a genuinely spawned child process), and
 * asserts the sample is discovered and registered, then actually activates
 * and runs when its one contributed command is invoked.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cold subprocess module resolution/transpilation (matches
// `externalExtensionLoading.test.ts`'s own override of the 5s default).
setDefaultTimeout(30_000);

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

// `packages/cli/src` is three levels below the repo root
// (`packages/cli/src` -> `packages/cli` -> `packages` -> root), so three
// `".."` segments resolve back to it.
const SAMPLE_DIR = join(import.meta.dir, "..", "..", "..", "samples", "extensions", "hello-world");

test("the real samples/extensions/hello-world/ sample loads, activates, and its command runs (Issue #148)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-hello-world-home-"));
  try {
    const targetDir = join(homeDir, ".config", "tecode", "extensions", "hello-world");
    await mkdir(targetDir, { recursive: true });
    // Only manifest.ts/index.ts are copied — discovery reads the
    // manifest, and the host's second import loads index.ts; README.md
    // is not part of the loaded pipeline.
    await cp(join(SAMPLE_DIR, "manifest.ts"), join(targetDir, "manifest.ts"));
    await cp(join(SAMPLE_DIR, "index.ts"), join(targetDir, "index.ts"));

    const result = await runHarness(homeDir, "helloWorld.sayHello", "");

    expect(result.loadedIds).toContain("example.hello-world");
    // The sample declares `activationEvents: ["onCommand:helloWorld.sayHello"]`
    // (per the guide's own recommendation for a command-only extension), so
    // it is only `"registered"` — discovered and its command contribution
    // live — at this snapshot, taken right after `activateStartupExtensions()`
    // and before the harness dispatches the command
    // (`externalExtensionLoadHarness.ts`'s own TSDoc: states reflect "after
    // `activateStartupExtensions()` has settled", which never touches an
    // `onCommand`-activated extension). `commandResult` below is what proves
    // it actually activates and runs, on demand, when invoked.
    expect(result.states["example.hello-world"]).toBe("registered");
    expect(result.commandResult).toBe("hello-world-ran");
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
