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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  calls: { flush: number; sidebarWidthFlush: number; dispose: number; disposeAll: number };
} {
  const calls = { flush: 0, sidebarWidthFlush: 0, dispose: 0, disposeAll: 0 };
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
    sidebarWidthSettingsWriter: {
      flush: async () => {
        calls.sidebarWidthFlush++;
      },
    },
    config: disposable(),
    chordPendingIndicator: disposable(),
    chordMachine: disposable(),
    findService: disposable(),
    editorSession: disposable(),
    editorLangIdSync: disposable(),
    themeConfigSync: disposable(),
    sidebarWidthConfigSync: disposable(),
    keybindingPresetConfigSync: disposable(),
    clipboardConfigSync: disposable(),
    terminal: disposable(),
    showPanelCommand: disposable(),
    themeSelectCommand: disposable(),
    openFileCommand: disposable(),
    tabCommands: disposable(),
    extensionsReloadCommand: disposable(),
    keybindingsCommands: disposable(),
    sidebarWidthCommands: disposable(),
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
    //
    // `onDestroy` now itself calls `process.exit(0)` once `shutdown()`
    // settles (`void shutdown().finally(() => process.exit(0))` — see the
    // "onDestroy calls process.exit(0)..." test below for why), and that
    // settling can happen within a couple of microtask ticks once
    // `performShutdown()`'s last `await` resolves — far faster than any
    // real timer this fixture could poll on. So rather than racing that
    // exit with a `setTimeout`-based poll loop (which lost this exact
    // race when first tried — the internal exit consistently won),
    // this fixture registers a SYNCHRONOUS `process.on("exit", ...)`
    // listener before firing `onDestroy`. Node/Bun always runs "exit"
    // listeners synchronously as part of process teardown — whether
    // triggered by our own explicit `process.exit(0)` or by the process
    // draining naturally — so by the time it runs, `shutdown()` (real
    // fix) or nothing at all (mutated-away wiring) has already
    // deterministically finished happening; verified empirically that
    // Bun reliably flushes a `console.log` made inside this handler to a
    // piped stdout in both cases.
    //
    // `theme.select`'s command registration — disposed synchronously by
    // `performShutdown`, with no OTHER path that ever removes it — is the
    // decisive signal, not `state.json`'s content: `layoutState.update()`
    // below arms a REAL 250ms debounced write regardless of whether
    // `shutdown()` ever runs, so if `onDestroy` were entirely missing
    // (this file's mutation check), the process would still eventually
    // exit once that real timer elapses and fire this SAME "exit"
    // listener — with `theme.select` still registered (proving the
    // teardown never ran) even though `state.json` might, by then, have
    // been written anyway by the unrelated debounce. `hasThemeSelect`
    // is asserted false; `state.json`'s content is asserted only as a
    // bonus confirmation, meaningful precisely because `hasThemeSelect`
    // already established the real teardown ran.
    await writeFile(
      fixturePath,
      `import { runTecode } from ${JSON.stringify(mainPath)};
      import { readFileSync } from "node:fs";

      async function main() {
        let capturedOnDestroy;
        const result = await runTecode([], {
          headless: false,
          builtins: [],
          renderShell: async (deps) => {
            capturedOnDestroy = deps.onDestroy;
          },
        });

        // Dirty the layout state (Req 6.4) so flush() has a real pending
        // write to perform — flush() is a no-op write-wise when nothing is
        // pending (layoutState.ts's own flush/update TSDoc).
        result.root.layoutState.update({ sidebarWidth: 987 });

        process.on("exit", () => {
          const hasThemeSelect = result.root.commands
            .list()
            .some((c) => c.id === "theme.select");
          let stateContent = null;
          try {
            stateContent = readFileSync(${JSON.stringify(statePath)}, "utf8");
          } catch {}
          console.log(JSON.stringify({ event: "fixture.exit", hasThemeSelect, stateContent }));
        });

        capturedOnDestroy?.();
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

    const exitEvent = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; hasThemeSelect?: boolean; stateContent?: string | null };
        } catch {
          return null;
        }
      })
      .find((line) => line?.event === "fixture.exit");

    expect(exitEvent, `fixture stderr:\n${stderr}\nstdout:\n${stdout}`).toBeDefined();
    // The decisive assertion (this test's own TSDoc): theme.select's
    // command registration is gone ONLY if the real teardown sequence
    // (shutdown()) actually ran.
    expect(exitEvent?.hasThemeSelect).toBe(false);

    const written = JSON.parse(exitEvent?.stateContent ?? "null") as { sidebarWidth?: number } | null;
    expect(written?.sidebarWidth).toBe(987);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("onDestroy calls process.exit(0) once shutdown() settles, even when layoutState.flush() itself never resolves", async () => {
  // This is the gap CodeRabbit found in PR #87: `SHUTDOWN_TIMEOUT_MS`
  // bounds the `shutdown()` PROMISE, not the pending I/O it raced
  // against. A hung `layoutState.flush()` never lets `performShutdown()`
  // reach any of its `dispose()` calls, so whatever real handles those
  // would have closed (`ConfigService`'s `fs.watch` when the watched
  // files exist, the extension host, etc.) stay open — this fixture
  // models that directly with its own live, ref'd `setInterval` (rather
  // than depending on, say, `settings.json` happening to exist in this
  // hermetic temp `HOME` for a real watcher to attach to) so the failure
  // mode is reproduced deterministically. Without an explicit
  // `process.exit(0)` once `shutdown()` settles, a still-live handle like
  // this would keep the real process running forever — this test proves
  // the fix (`onDestroy: () => { void shutdown().finally(() => process.exit(0)); }`)
  // exits anyway, and bounds its own wait (killing the child rather than
  // hanging this test) so a regression fails cleanly instead of hanging
  // the whole suite.
  const homeDir = await mkdtemp(join(tmpdir(), "tecode-shutdown-hang-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-shutdown-hang-ws-"));

  try {
    const mainPath = join(import.meta.dir, "main.ts");
    const fixturePath = join(workspaceDir, "shutdown-hang-fixture.ts");
    await writeFile(
      fixturePath,
      `import { runTecode } from ${JSON.stringify(mainPath)};

      async function main() {
        let capturedOnDestroy;
        const result = await runTecode([], {
          headless: false,
          builtins: [],
          renderShell: async (deps) => {
            capturedOnDestroy = deps.onDestroy;
          },
        });

        // A genuinely hung flush(): a promise that never settles, exactly
        // like a stuck real fs write, WITH a real, still-armed, ref'd
        // timer behind it — a bare unresolved promise holds no libuv
        // handle and costs the event loop nothing on its own, so this
        // interval stands in for whatever real resource(s)
        // performShutdown()'s later dispose() calls would otherwise have
        // closed (ConfigService's fs.watch, the extension host, ...) had
        // \`await root.layoutState.flush()\` ever gotten a chance to
        // resolve and let them run.
        result.root.layoutState.flush = () =>
          new Promise(() => {
            setInterval(() => {}, 1000);
          });

        console.log(JSON.stringify({ event: "fixture.ready" }));
        capturedOnDestroy?.();
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

    // SHUTDOWN_TIMEOUT_MS (2s, real/un-mocked here — this is a real
    // subprocess) is when `shutdown()` itself is expected to give up;
    // this margin is generous headroom above that for the subprocess to
    // then actually call `process.exit` and for Bun to report it exited.
    const raceTimeoutMs = SHUTDOWN_TIMEOUT_MS + 6_000;
    let timedOut = false;
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(-1);
        }, raceTimeoutMs);
      }),
    ]);
    if (timedOut) {
      // Don't leave a hung child (with its own hung timers/watchers)
      // running in the background just because this assertion is about
      // to fail.
      proc.kill();
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().catch(() => "(stdout unavailable)"),
      new Response(proc.stderr).text().catch(() => "(stderr unavailable)"),
    ]);

    expect(
      timedOut,
      `fixture did not exit within ${raceTimeoutMs}ms — onDestroy's shutdown() likely settled (after ${SHUTDOWN_TIMEOUT_MS}ms) without ever calling process.exit, leaving the fixture's still-live handle open. stdout:\n${stdout}\nstderr:\n${stderr}`,
    ).toBe(false);
    expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
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
  expect(calls.sidebarWidthFlush).toBe(1);
  expect(calls.dispose).toBe(24); // one per disposable field in ShutdownRoot
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
  expect(calls.sidebarWidthFlush).toBe(1);
  expect(calls.dispose).toBe(24);
  expect(calls.disposeAll).toBe(1);

  // A THIRD call, after the sequence has already fully settled, is still
  // the same no-further-work no-op (this is what makes it safe to hit
  // from as many quit paths as ever call it).
  await shutdown();
  expect(calls.flush).toBe(1);
  expect(calls.sidebarWidthFlush).toBe(1);
  expect(calls.dispose).toBe(24);
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
