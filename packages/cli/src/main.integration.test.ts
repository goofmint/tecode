/**
 * Subprocess startup-sequence integration test (Req 12.1, 12.2; design.md
 * §3, §15, §16; tasks.md's Task 1.15: "Integration test: startup renders
 * before any extension activates; timing check with headroom over
 * 100ms").
 *
 * Spawns the real `packages/cli/src/main.ts` entry point as a genuine
 * child process (`Bun.spawn`, matching `layering.test.ts`'s
 * spawn-and-parse pattern) with `TECODE_HEADLESS=1` — never grabs a real
 * TTY — and a disposable on-disk fixture extension + temp `HOME`, always
 * cleaned up in `finally`.
 *
 * **Proving ordering without a shared clock**: the fixture extension's
 * `index.ts` logs its own module-load time as one JSON line on stdout, in
 * the very same child process `main.ts` runs in — so its `performance.now()`
 * reading is directly comparable to the `tecode.timing` first-frame
 * event's `ts` (both measured from the same process-start reference
 * point), with no cross-process clock synchronization needed.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spawning bun as a subprocess (cold module resolution/transpilation) can
// exceed bun:test's 5s default, independent of the app's own <100ms
// startup budget being asserted below.
setDefaultTimeout(30_000);

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
      // Not one of our structured lines (e.g. a stray console warning) —
      // ignore rather than fail the whole parse.
    }
  }
  return lines;
}

test("headless startup renders the shell before any extension's index.ts loads, and reports first-frame timing", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-integration-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-integration-ws-"));

  try {
    const extensionDir = join(workspaceDir, ".tecode", "extensions", "fixture");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "manifest.ts"),
      `export default {
        id: "fixture.startup-order",
        version: "0.0.1",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      };\n`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "index.ts"),
      `console.log(JSON.stringify({ event: "fixture.moduleLoaded", ts: performance.now() }));
      export function activate() {
        console.log(JSON.stringify({ event: "fixture.activated", ts: performance.now() }));
      }\n`,
      "utf8",
    );

    const mainPath = join(import.meta.dir, "main.ts");
    const proc = Bun.spawn({
      cmd: ["bun", "run", mainPath, workspaceDir],
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

    expect(exitCode).toBe(0);

    const lines = parseJsonLines(stdout);
    const firstFrame = lines.find((l) => l.event === "tecode.timing" && l.phase === "first-frame");
    const moduleLoaded = lines.find((l) => l.event === "fixture.moduleLoaded");
    const activated = lines.find((l) => l.event === "fixture.activated");
    const headlessExit = lines.find((l) => l.event === "tecode.headlessExit");

    expect(firstFrame, `expected a tecode.timing first-frame line; stderr:\n${stderr}`).toBeDefined();
    expect(moduleLoaded, `expected the fixture's own module-load line; stderr:\n${stderr}`).toBeDefined();
    expect(activated).toBeDefined();
    expect(headlessExit).toBeDefined();

    // The core ordering assertion (Req 12.1, 12.2): the shell's first
    // frame happened strictly before the extension's index.ts was ever
    // imported, and before it activated.
    const firstFrameTs = firstFrame?.["ts"] as number;
    const moduleLoadedTs = moduleLoaded?.["ts"] as number;
    const activatedTs = activated?.["ts"] as number;
    expect(firstFrameTs).toBeLessThan(moduleLoadedTs);
    expect(moduleLoadedTs).toBeLessThanOrEqual(activatedTs);

    // Timing budget (design.md §15's <100ms). tasks.md's Task 1.15 asks
    // for a "timing check with headroom over 100 ms" — a strict <100
    // bound would flake on loaded CI runners, so this enforces 10x the
    // budget (measured locally: ~6–15ms), tight enough to catch any real
    // startup regression.
    const firstFrameMs = firstFrame?.["ms"] as number;
    expect(firstFrameMs).toBeGreaterThanOrEqual(0);
    expect(firstFrameMs).toBeLessThan(1_000);

    // 8, not 1: the workspace fixture extension AND the real `@tecode/
    // builtin` `editor-core` (Task 2.3, `onStartup`) AND `themes-default`
    // (Task 2.7) AND `languages-basic` (Task 2.9) AND `command-palette`
    // (Task 3.2, `onStartup`) AND `explorer` (Task 3.3,
    // `onCommand:explorer.focus`) AND `statusbar` (Task 3.4, `onStartup`)
    // AND `keybindings-editor` (Task 4.3, `onStartup`) —
    // `themes-default`/`languages-basic`/`explorer` are never ACTIVATED by
    // a headless run with no keystrokes (no `onStartup` for the first two;
    // `explorer.focus` is never executed here), but every manifest still
    // counts as LOADED/registered regardless of activation — all load
    // during this real (no `builtins` override) subprocess run.
    expect(headlessExit?.["loaded"]).toBe(8);
    expect(headlessExit?.["skipped"]).toBe(0);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
