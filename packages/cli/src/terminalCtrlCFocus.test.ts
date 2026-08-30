/**
 * Tests for {@link wireCtrlCInterceptToTerminalFocus} (Issue #113): the
 * pure sync logic behind `renderShell.tsx`'s `ShellRenderDeps.
 * onCtrlCInterceptControlReady`, pulled out of `runTecode`'s inline
 * `renderShell({...})` call precisely so it is unit-testable — see that
 * function's own TSDoc in `main.ts` for why a real interactive Ctrl+C
 * cannot be exercised here at all (no real TTY in `bun test`, matching
 * `shutdownOnDestroy.test.ts`'s identical reasoning for `onDestroy`).
 *
 * Uses a REAL {@link createContextService} (not a hand-rolled fake) —
 * `ContextService.onDidChange`'s exact "fires with the key that changed,
 * only when the value actually changes" contract is load-bearing here
 * (this module's own "never per-keystroke, only on a real
 * `"terminalFocus"` change" requirement), and `context.test.ts` already
 * proves that contract holds for the real implementation, so re-deriving
 * it with a fake here would only risk the fake drifting from the real
 * behavior it stands in for.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextService } from "@tecode/core";
import { wireCtrlCInterceptToTerminalFocus } from "./main";

// Spawning bun as a subprocess (cold module resolution/transpilation) can
// exceed bun:test's 5s default — matches `shutdownOnDestroy.test.ts`'s own
// reasoning for the identical call.
setDefaultTimeout(30_000);

/** Captures every `setEnabled(...)` call, in order — lets a test assert
 * both the FINAL state and how many times it actually flipped (the
 * "never per-keystroke" claim needs the call count, not just the last
 * value). */
function createEnabledRecorder(): { setEnabled: (enabled: boolean) => void; calls: boolean[] } {
  const calls: boolean[] = [];
  return { setEnabled: (enabled) => calls.push(enabled), calls };
}

describe("wireCtrlCInterceptToTerminalFocus (Issue #113)", () => {
  test("applies the current (unfocused) state immediately, synchronously, on call", () => {
    const context = createContextService();
    const { setEnabled, calls } = createEnabledRecorder();

    wireCtrlCInterceptToTerminalFocus(context, setEnabled);

    // No "terminalFocus" key set at all yet (the real first-frame case —
    // Shell has not even mounted) — `exitOnCtrlC` must be ENABLED
    // (Ctrl+C quits), matching every other part of the editor today.
    expect(calls).toEqual([true]);
  });

  test("applies the current (already-focused) state immediately, synchronously, on call", () => {
    const context = createContextService();
    context.set("terminalFocus", true);
    const { setEnabled, calls } = createEnabledRecorder();

    wireCtrlCInterceptToTerminalFocus(context, setEnabled);

    // Cheap correctness insurance (this module's own TSDoc) for a case
    // that is not reachable at today's one real call site, but must not
    // silently disagree with the CURRENT context value if it ever were.
    expect(calls).toEqual([false]);
  });

  test("disables interception the moment terminalFocus becomes true, and re-enables it the moment it stops being true", () => {
    const context = createContextService();
    const { setEnabled, calls } = createEnabledRecorder();
    wireCtrlCInterceptToTerminalFocus(context, setEnabled);
    calls.length = 0; // Only the CHANGES below matter to this assertion.

    context.set("terminalFocus", true);
    expect(calls).toEqual([false]);

    context.set("terminalFocus", false);
    expect(calls).toEqual([false, true]);
  });

  test("never fires on an unrelated context key change — only 'terminalFocus' is watched", () => {
    const context = createContextService();
    const { setEnabled, calls } = createEnabledRecorder();
    wireCtrlCInterceptToTerminalFocus(context, setEnabled);
    calls.length = 0;

    context.set("editorFocus", true);
    context.set("explorerFocus", true);

    expect(calls).toEqual([]);
  });

  test("a re-set of terminalFocus to the SAME value never fires — matches ContextService.set's own no-op-on-unchanged-value contract", () => {
    const context = createContextService();
    context.set("terminalFocus", true);
    const { setEnabled, calls } = createEnabledRecorder();
    wireCtrlCInterceptToTerminalFocus(context, setEnabled);
    calls.length = 0;

    context.set("terminalFocus", true); // Same value again.

    expect(calls).toEqual([]);
  });

  test("disposing the returned subscription stops further sync — a later terminalFocus flip no longer flips exitOnCtrlC", () => {
    const context = createContextService();
    const { setEnabled, calls } = createEnabledRecorder();
    const subscription = wireCtrlCInterceptToTerminalFocus(context, setEnabled);
    calls.length = 0;

    subscription.dispose();
    context.set("terminalFocus", true);

    expect(calls).toEqual([]);
  });
});

describe("runTecode wires onCtrlCInterceptControlReady end to end (Issue #113)", () => {
  test("runTecode's real renderShell({...}) call hands the render seam a setEnabled that already tracks root.context's terminalFocus key", async () => {
    // `wireCtrlCInterceptToTerminalFocus` on its own (above) proves the
    // SYNC LOGIC; it says nothing about whether `runTecode` actually wires
    // it up at its one real call site — a deleted or mis-wired
    // `onCtrlCInterceptControlReady: (setEnabled) => wireCtrlCInterceptToTerminalFocus(root.context, setEnabled)`
    // line in `main.ts`'s `renderShell({...})` call would leave every test
    // above passing while Issue #113 stayed completely unfixed in the real
    // editor. Same subprocess-isolation shape as `shutdownOnDestroy.
    // test.ts`'s own `renderShell` fixture (that file's own TSDoc explains
    // why: a real interactive Ctrl+C needs a real TTY bun test's sandboxed
    // stdout never provides, and `runTecode`'s `wireProcessExit` registers
    // real `process.once("SIGINT"/"SIGTERM", ...)` handlers that must never
    // leak onto the shared `bun test` runner process — a subprocess is
    // required, not merely for isolation of state, but to keep those
    // handlers off THIS process entirely).
    const homeDir = await mkdtemp(join(tmpdir(), "tecode-ctrlc-home-"));
    const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-ctrlc-ws-"));

    try {
      const mainPath = join(import.meta.dir, "main.ts");
      const fixturePath = join(workspaceDir, "ctrlc-fixture.ts");
      await writeFile(
        fixturePath,
        `import { runTecode } from ${JSON.stringify(mainPath)};

        async function main() {
          let capturedSetEnabled;
          const result = await runTecode([], {
            headless: false,
            builtins: [],
            renderShell: async (deps) => {
              deps.onCtrlCInterceptControlReady?.((enabled) => {
                capturedSetEnabled = enabled;
              });
            },
          });

          const seenBeforeFocus = capturedSetEnabled;
          result.root.context.set("terminalFocus", true);
          const seenWhileFocused = capturedSetEnabled;
          result.root.context.set("terminalFocus", false);
          const seenAfterBlur = capturedSetEnabled;

          console.log(JSON.stringify({ event: "fixture.result", seenBeforeFocus, seenWhileFocused, seenAfterBlur }));
          process.exit(0);
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

      const resultLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as {
              event?: string;
              seenBeforeFocus?: boolean;
              seenWhileFocused?: boolean;
              seenAfterBlur?: boolean;
            };
          } catch {
            return null;
          }
        })
        .find((line) => line?.event === "fixture.result");

      expect(resultLine, `fixture stderr:\n${stderr}\nstdout:\n${stdout}`).toBeDefined();
      // Before any focus change: exitOnCtrlC must already be ENABLED
      // (Ctrl+C quits, today's universal default) — proves the initial,
      // synchronous `sync()` call inside `wireCtrlCInterceptToTerminalFocus`
      // actually ran as part of `runTecode`'s own startup, not merely when
      // called directly in the unit tests above.
      expect(resultLine?.seenBeforeFocus).toBe(true);
      // While the terminal panel is focused: exitOnCtrlC must be DISABLED
      // — this is the actual Issue #113 fix.
      expect(resultLine?.seenWhileFocused).toBe(false);
      // Once focus leaves the terminal: exitOnCtrlC must be re-ENABLED —
      // an interactive Ctrl+C must still quit the editor everywhere else.
      expect(resultLine?.seenAfterBlur).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
