/**
 * Shutdown-on-normal-quit tests (Issue #84, Req 12.3, design.md §3's
 * shutdown point).
 *
 * A real interactive Ctrl+C quit cannot be exercised here: `createCliRenderer`
 * needs a real TTY, which bun test's sandboxed stdout never provides, and
 * `main.ts` forces the no-op `renderShellHeadless` whenever stdout isn't
 * one (`renderShell.test.ts`'s own TSDoc makes the identical call for
 * `renderShellToTerminal`). So these tests exercise the SEAM instead of
 * the terminal:
 *
 * - The first test spawns a real `bun` subprocess (matching
 *   `main.integration.test.ts`'s own spawn-and-parse pattern) running a
 *   small fixture that calls `runTecode` with its `renderShell` seam
 *   overridden to CAPTURE, rather than open, the real `onDestroy`
 *   callback, then fires that captured callback directly — proving
 *   `runTecode` really does wire `onDestroy` to `shutdown()` end to end,
 *   against a REAL `layoutState.flush()` write to disk. A genuine
 *   subprocess (not just an env-var mutation of THIS test's own process)
 *   is required here, not merely for isolation: Bun's `os.homedir()` —
 *   which `getUserLayoutStatePath()` depends on — is resolved once at
 *   process start and does not observe a later `process.env.HOME`
 *   mutation, so only a fresh process actually started with `HOME`
 *   pointed at a temp directory lets this test observe the write without
 *   touching the real machine's `~/.config/tecode/state.json`.
 * - The remaining tests exercise `createShutdown` — the shared, memoized,
 *   timeout-bounded sequence `wireProcessExit` builds (`main.ts`'s TSDoc)
 *   — directly, against a hand-rolled fake `ShutdownRoot`, for the
 *   idempotency and timeout guarantees that don't need a real terminal, a
 *   real filesystem, or even a real `AssemblyRoot`.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostLog, type ChordScheduler } from "@tecode/core";
import { createShutdown, SHUTDOWN_TIMEOUT_MS, type ShutdownRoot } from "./main";

// Spawning bun as a subprocess (cold module resolution/transpilation) can
// exceed bun:test's 5s default — matches `main.integration.test.ts`'s own
// reasoning for the identical call.
setDefaultTimeout(30_000);

/** A fake scheduler (matches `keymap/chords.test.ts`'s/
 * `ui/chordPendingIndicator.test.ts`'s own): `fire()` runs every
 * still-armed timeout synchronously, so `SHUTDOWN_TIMEOUT_MS`'s real
 * multi-second wait never has to elapse in a test. */
function createFakeScheduler(): ChordScheduler & { fire(): void } {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  return {
    set(fn) {
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    fire() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

/** A hand-rolled fake {@link ShutdownRoot}: every disposable just counts
 * its own call into `calls`, so a test can invoke the returned
 * `shutdown()` any number of times, in any order relative to other
 * callers, and assert the real sequence still only ran once.
 * `flush` is overridable so the timeout test can hand it a `Promise` that
 * never settles, matching a genuinely hung `layoutState.flush()`. */
function createFakeShutdownRoot(overrides: { flush?: () => Promise<void> } = {}): {
  root: ShutdownRoot;
  log: ReturnType<typeof createHostLog>;
  calls: { flush: number; dispose: number; disposeAll: number };
} {
  const calls = { flush: 0, dispose: 0, disposeAll: 0 };
  const log = createHostLog();
  const disposable = (): { dispose: () => void } => ({
    dispose: () => {
      calls.dispose++;
    },
  });
  const root: ShutdownRoot = {
    log,
    layoutState: {
      flush:
        overrides.flush ??
        (async () => {
          calls.flush++;
        }),
    },
    config: disposable(),
    chordPendingIndicator: disposable(),
    chordMachine: disposable(),
    findService: disposable(),
    editorSession: disposable(),
    editorLangIdSync: disposable(),
    themeConfigSync: disposable(),
    keybindingPresetConfigSync: disposable(),
    themeSelectCommand: disposable(),
    openFileCommand: disposable(),
    tabCommands: disposable(),
    extensionsReloadCommand: disposable(),
    keybindingsCommands: disposable(),
    modalCommands: disposable(),
    modalService: disposable(),
    windowMessageService: disposable(),
    hostErrorSink: disposable(),
    highlightService: disposable(),
    languageRegistry: disposable(),
    hostRef: {
      current: {
        disposeAll: async () => {
          calls.disposeAll++;
        },
      },
    },
  };
  return { root, log, calls };
}

test("runTecode wires the render seam's onDestroy hook to shutdown(), which flushes layout state to disk", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-shutdown-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-shutdown-ws-"));

  try {
    const mainPath = join(import.meta.dir, "main.ts");
    const statePath = join(homeDir, ".config", "tecode", "state.json");
    const fixturePath = join(workspaceDir, "shutdown-fixture.ts");
    // A real interactive Ctrl+C never reaches this path in a test (this
    // file's own TSDoc) — `options.renderShell` is `runTecode`'s existing
    // injectable seam this fixture uses to CAPTURE, rather than open, the
    // real `onDestroy` callback, then fires it directly to simulate
    // OpenTUI's `exitOnCtrlC` path calling `CliRenderer.destroy()` on a
    // normal interactive quit (Issue #84) — `destroy()` synchronously
    // invokes `onDestroy`, which `runTecode` wires straight to
    // `shutdown()` (`main.ts`'s TSDoc).
    await writeFile(
      fixturePath,
      `import { runTecode } from ${JSON.stringify(mainPath)};
      import { readFileSync } from "node:fs";

      function hasThemeSelect(root) {
        return root.commands.list().some((c) => c.id === "theme.select");
      }

      async function main() {
        let capturedOnDestroy;
        const result = await runTecode([], {
          headless: false,
          builtins: [],
          renderShell: async (deps) => {
            capturedOnDestroy = deps.onDestroy;
          },
        });

        if (!hasThemeSelect(result.root)) {
          console.log(JSON.stringify({ event: "fixture.badPrecondition" }));
          process.exit(1);
        }

        // Dirty the layout state (Req 6.4) so flush() has a real pending
        // write to perform — flush() is a no-op write-wise when nothing is
        // pending (layoutState.ts's own flush/update TSDoc).
        result.root.layoutState.update({ sidebarWidth: 987 });
        capturedOnDestroy?.();

        // performShutdown (main.ts) disposes theme.select's command
        // registration STRICTLY AFTER awaiting layoutState.flush() to
        // completion — so waiting for theme.select to disappear from the
        // registry is a deterministic, race-free signal that flush()'s
        // own write has already landed on disk too, without racing
        // layoutState's own 250ms debounce timer (which would otherwise
        // write the SAME content on its own, defeating this test's whole
        // point of proving the DESTROY HOOK caused it).
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (!hasThemeSelect(result.root)) {
            const text = readFileSync(${JSON.stringify(statePath)}, "utf8");
            console.log(JSON.stringify({ event: "fixture.disposedAndFlushed", text }));
            process.exit(text.includes("987") ? 0 : 1);
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        console.log(JSON.stringify({ event: "fixture.timeout" }));
        process.exit(1);
      }
      main();
      `,
      "utf8",
    );

    const proc = Bun.spawn({
      cmd: ["bun", "run", fixturePath],
      cwd: workspaceDir,
      env: { ...process.env, HOME: homeDir, APPDATA: homeDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `fixture stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    expect(stdout).toContain("fixture.disposedAndFlushed");

    const written = JSON.parse(await readFile(statePath, "utf8")) as { sidebarWidth: number };
    expect(written.sidebarWidth).toBe(987);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("createShutdown's returned function is idempotent: destroy-then-signal runs the sequence exactly once", async () => {
  const { root, calls } = createFakeShutdownRoot();
  const shutdown = createShutdown(root);

  // "destroy" fires first (Issue #84's normal-quit path)...
  const destroyCall = shutdown();
  // ...then a SIGTERM/SIGINT races in while the first call is still
  // genuinely in flight — this must await the SAME real teardown, not
  // resolve early and let a signal handler's `process.exit(0)` cut it off
  // (`createShutdown`'s "memoized promise, not a boolean flag" TSDoc).
  const signalCall = shutdown();

  await Promise.all([destroyCall, signalCall]);

  expect(calls.flush).toBe(1);
  expect(calls.dispose).toBe(19); // one per disposable field in ShutdownRoot
  expect(calls.disposeAll).toBe(1);
});

test("createShutdown's returned function is idempotent: signal-then-destroy runs the sequence exactly once", async () => {
  const { root, calls } = createFakeShutdownRoot();
  const shutdown = createShutdown(root);

  // Same guarantee, opposite order: a signal fires first, then OpenTUI's
  // destroy hook fires while that first call is still in flight.
  const signalCall = shutdown();
  const destroyCall = shutdown();

  await Promise.all([signalCall, destroyCall]);

  expect(calls.flush).toBe(1);
  expect(calls.dispose).toBe(19);
  expect(calls.disposeAll).toBe(1);

  // A THIRD call, after the sequence has already fully settled, is still
  // the same no-further-work no-op (this is what makes it safe to hit
  // from as many quit paths as ever call it).
  await shutdown();
  expect(calls.flush).toBe(1);
  expect(calls.dispose).toBe(19);
  expect(calls.disposeAll).toBe(1);
});

test("createShutdown bounds the wait: a hung flush() still lets shutdown() settle, and logs a warning", async () => {
  const scheduler = createFakeScheduler();
  // A `flush()` that never resolves — matches a genuinely hung dispose in
  // production; `createShutdown` must not wait on it forever.
  const hungFlush = () => new Promise<void>(() => {});
  const { root, log, calls } = createFakeShutdownRoot({ flush: hungFlush });
  const shutdown = createShutdown(root, { scheduler, timeoutMs: SHUTDOWN_TIMEOUT_MS });

  let settled = false;
  const shutdownPromise = shutdown().then(() => {
    settled = true;
  });

  // Nothing has settled yet — the fake flush() never resolves on its own,
  // so without the timeout firing, this would hang forever.
  expect(settled).toBe(false);

  // Simulate SHUTDOWN_TIMEOUT_MS elapsing, without a real multi-second
  // wait (this file's own `createFakeScheduler` TSDoc).
  scheduler.fire();
  await shutdownPromise;

  expect(settled).toBe(true);
  expect(
    log
      .entries()
      .some((e) => e.level === "warning" && e.error.message.includes(`${SHUTDOWN_TIMEOUT_MS}ms`)),
  ).toBe(true);

  // The disposals after the hung flush() genuinely never ran — the
  // timeout lets `shutdown()` SETTLE without them, it does not fake
  // having run them.
  expect(calls.dispose).toBe(0);
  expect(calls.disposeAll).toBe(0);
});
