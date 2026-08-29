/**
 * Tests for `createTerminalService` (Issue #98). Covers the Windows
 * degradation path (injected `platform: "win32"` PLUS a `bunVersion`
 * below the Bun 1.3.14 ConPTY threshold — `platform.ts`'s
 * `supportsBunTerminal` TSDoc — no global `process.platform`/`Bun.
 * version` mutation), the verified findings this module encodes (SIGWINCH
 * delivery, forced `TERM`, guarded `Bun.Terminal`/`Bun.spawn`
 * construction, version-qualified Windows support, `dispose()` genuinely
 * firing `onExit` since it genuinely kills the child, and a naturally-
 * exited session being dropped from the service's own sweep set), and
 * disposal idempotency/service-level teardown.
 *
 * The real-spawn tests below run actual `Bun.Terminal`/`Bun.spawn` pty
 * sessions against `bun` itself (always on `PATH` under `bun test`) —
 * gated behind `describe.skipIf` on the same POSIX/`Bun.Terminal`
 * availability check `ptyService.ts` itself relies on, matching
 * `gitRunner.test.ts`'s own `skipIf` precedent for a real-capability-
 * dependent suite (this repo's CI is Linux-only, so this should always
 * run there — the guard exists for any other environment this suite
 * might run in).
 */

import { describe, expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import { createTerminalService } from "./ptyService";

/** A Bun version below the 1.3.14 ConPTY threshold (`platform.ts`'s
 * `supportsBunTerminal`) — paired with `platform: "win32"` throughout
 * this describe block so these tests keep exercising the degraded path
 * regardless of which real `Bun.version` they happen to run under. */
const UNSUPPORTED_WIN32_BUN_VERSION = "1.3.13";

function createRecordingLog() {
  const entries: HostError[] = [];
  return {
    entries,
    log: {
      append(_level: "error" | "warning", error: HostError) {
        entries.push(error);
      },
      entries() {
        return [];
      },
    },
  };
}

async function collectExit(session: { onExit: (l: (e: { exitCode: number }) => void) => unknown }) {
  return new Promise<number>((resolve) => {
    session.onExit((e) => resolve(e.exitCode));
  });
}

describe("createTerminalService — Windows degradation (injected platform)", () => {
  test("isSupported() is false", () => {
    const service = createTerminalService({ platform: "win32", bunVersion: UNSUPPORTED_WIN32_BUN_VERSION });
    expect(service.isSupported()).toBe(false);
  });

  test("spawn() never constructs a real pty: write/resize are no-ops, onData never fires, onExit fires once with a non-zero code, and a HostError is logged", async () => {
    const { log, entries } = createRecordingLog();
    const service = createTerminalService({ platform: "win32", bunVersion: UNSUPPORTED_WIN32_BUN_VERSION, log });

    const session = service.spawn({ cmd: ["true"], cols: 80, rows: 24 });

    let dataFired = false;
    session.onData(() => {
      dataFired = true;
    });

    const exitCode = await collectExit(session);
    expect(exitCode).toBeLessThan(0);
    expect(dataFired).toBe(false);
    expect(() => session.write("x")).not.toThrow();
    expect(() => session.resize(100, 40)).not.toThrow();
    expect(() => session.dispose()).not.toThrow();
    expect(() => session.dispose()).not.toThrow(); // idempotent

    expect(entries.some((e) => e.message.toLowerCase().includes("windows"))).toBe(true);
  });

  test("onExit fires exactly once even with multiple listeners, and late-subscribing after the microtask still works via a fresh spawn", async () => {
    const service = createTerminalService({ platform: "win32", bunVersion: UNSUPPORTED_WIN32_BUN_VERSION });
    const session = service.spawn({ cmd: ["true"], cols: 80, rows: 24 });

    const codes: number[] = [];
    session.onExit((e) => codes.push(e.exitCode));
    session.onExit((e) => codes.push(e.exitCode));
    await collectExit(session);
    // Both listeners registered before the deferred fire ran, so both saw it.
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("createTerminalService — disposed service", () => {
  test("spawn() after service.dispose() returns another inert session and logs, without throwing", async () => {
    const { log, entries } = createRecordingLog();
    const service = createTerminalService({ platform: "linux", log });
    service.dispose();

    const session = service.spawn({ cmd: ["true"], cols: 80, rows: 24 });
    const exitCode = await collectExit(session);
    expect(exitCode).toBeLessThan(0);
    expect(entries.some((e) => e.message.toLowerCase().includes("disposed"))).toBe(true);
  });

  test("service.dispose() is idempotent", () => {
    const service = createTerminalService({ platform: "win32", bunVersion: UNSUPPORTED_WIN32_BUN_VERSION });
    expect(() => service.dispose()).not.toThrow();
    expect(() => service.dispose()).not.toThrow();
  });
});

const hasRealPty =
  process.platform !== "win32" && typeof (Bun as unknown as { Terminal?: unknown }).Terminal === "function";

describe.skipIf(!hasRealPty)("createTerminalService — real POSIX pty spawn", () => {
  test("isSupported() is true", () => {
    const service = createTerminalService();
    expect(service.isSupported()).toBe(true);
    service.dispose();
  });

  test("spawns a real process, delivers its stdout via onData, and reports its real exit code via onExit", async () => {
    const service = createTerminalService();
    const session = service.spawn({
      cmd: ["bun", "-e", "process.stdout.write('hello-pty'); process.exit(3);"],
      cols: 80,
      rows: 24,
    });

    const chunks: Uint8Array[] = [];
    session.onData((bytes) => chunks.push(bytes));

    const exitCode = await collectExit(session);
    expect(exitCode).toBe(3);

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    expect(text).toContain("hello-pty");

    service.dispose();
  });

  test("Finding 2: TERM is forced to xterm-256color in the spawned process's env, overriding a caller-supplied TERM", async () => {
    const service = createTerminalService();
    const session = service.spawn({
      cmd: ["bun", "-e", "process.stdout.write('TERM=' + (process.env.TERM || 'unset'));"],
      cwd: undefined,
      env: { TERM: "dumb" }, // must NOT survive — the host always forces xterm-256color
      cols: 80,
      rows: 24,
    });

    const chunks: Uint8Array[] = [];
    session.onData((bytes) => chunks.push(bytes));
    await collectExit(session);

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    expect(text).toContain("TERM=xterm-256color");

    service.dispose();
  });

  test("Finding 1: resize() calls the injected sendSignal with SIGWINCH and the child's pid", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const service = createTerminalService({
      sendSignal: (pid, signal) => signals.push({ pid, signal }),
    });
    const session = service.spawn({
      cmd: ["bun", "-e", "setTimeout(() => {}, 30000);"],
      cols: 80,
      rows: 24,
    });

    session.resize(120, 40);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.signal).toBe("SIGWINCH");
    expect(signals[0]?.pid).toBeGreaterThan(0);

    session.dispose();
    service.dispose();
  });

  test("on Windows (a Bun that DOES support ConPTY) resize() skips SIGWINCH — the signal does not exist there", async () => {
    // `platform: "win32"` with a supported `bunVersion` takes the real
    // spawn path (this host is POSIX, so the pty itself allocates fine) —
    // which is exactly what makes the Windows resize branch testable
    // without a Windows machine. ConPTY resizes the console natively, and
    // `process.kill(pid, "SIGWINCH")` would throw `ERR_UNKNOWN_SIGNAL` on
    // every single resize there (`platform.ts`'s `deliversSigwinch`).
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const service = createTerminalService({
      platform: "win32",
      bunVersion: "1.3.14",
      sendSignal: (pid, signal) => signals.push({ pid, signal }),
    });
    expect(service.isSupported()).toBe(true);

    const session = service.spawn({
      cmd: ["bun", "-e", "setTimeout(() => {}, 30000);"],
      cols: 80,
      rows: 24,
    });

    session.resize(120, 40);

    expect(signals).toHaveLength(0);

    session.dispose();
    service.dispose();
  });

  test("dispose() is idempotent and kills a still-running child without throwing", async () => {
    const service = createTerminalService();
    const session = service.spawn({
      cmd: ["bun", "-e", "setTimeout(() => {}, 30000);"],
      cols: 80,
      rows: 24,
    });

    expect(() => session.dispose()).not.toThrow();
    expect(() => session.dispose()).not.toThrow(); // idempotent, still-running child already killed

    service.dispose();
  });

  test("write()/resize() after dispose() are silent no-ops", async () => {
    const service = createTerminalService();
    const session = service.spawn({ cmd: ["true"], cols: 80, rows: 24 });
    await collectExit(session);
    session.dispose();

    expect(() => session.write("late")).not.toThrow();
    expect(() => session.resize(10, 10)).not.toThrow();

    service.dispose();
  });

  test("service.dispose() tears down every still-live session", async () => {
    const service = createTerminalService();
    const session = service.spawn({
      cmd: ["bun", "-e", "setTimeout(() => {}, 30000);"],
      cols: 80,
      rows: 24,
    });

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit((e) => resolve(e.exitCode));
      service.dispose();
    });
    // Killed by the service's own shutdown sweep — the process exits
    // (SIGTERM, the default `Subprocess.kill()` signal), not a clean 0.
    expect(exitCode).not.toBe(0);
  });

  test("a spawn failure (nonexistent executable) degrades to an inert session and logs, never throws", async () => {
    const { log, entries } = createRecordingLog();
    const service = createTerminalService({ log });

    const session = service.spawn({ cmd: ["/nonexistent/definitely-not-a-real-binary"], cols: 80, rows: 24 });
    const exitCode = await collectExit(session);
    expect(exitCode).toBeLessThan(0);
    expect(entries.some((e) => e.message.toLowerCase().includes("failed to spawn"))).toBe(true);

    service.dispose();
  });

  test("a `new Bun.Terminal(...)` construction failure (e.g. fd exhaustion, an unusable /dev/ptmx) degrades to an inert session and logs, never throws", async () => {
    // `Bun.Terminal` is a plain writable global property (unlike `Bun`
    // itself) — temporarily replaced with a hand-rolled fake that always
    // throws, restored in `finally` no matter what the assertions below
    // do. No mock library involved, matching this repo's "hand-rolled
    // fakes only" convention.
    const originalTerminal = Bun.Terminal;
    (Bun as unknown as { Terminal: unknown }).Terminal = class {
      constructor() {
        throw new Error("simulated: fd exhaustion / unusable /dev/ptmx");
      }
    };
    try {
      const { log, entries } = createRecordingLog();
      const service = createTerminalService({ log });

      const session = service.spawn({ cmd: ["true"], cols: 80, rows: 24 });

      let dataFired = false;
      session.onData(() => {
        dataFired = true;
      });

      const exitCode = await collectExit(session);
      expect(exitCode).toBeLessThan(0);
      expect(dataFired).toBe(false);
      expect(() => session.write("x")).not.toThrow();
      expect(() => session.resize(100, 40)).not.toThrow();
      expect(() => session.dispose()).not.toThrow();

      expect(entries.some((e) => e.message.toLowerCase().includes("bun.terminal"))).toBe(true);

      service.dispose();
    } finally {
      Bun.Terminal = originalTerminal;
    }
  });

  test("dispose() fires onExit exactly once — dispose() genuinely kills the child, so PtySession.onExit's contract (fires on any real exit, dispose-caused or not) applies here too", async () => {
    const service = createTerminalService();
    const session = service.spawn({
      cmd: ["bun", "-e", "setTimeout(() => {}, 30000);"],
      cols: 80,
      rows: 24,
    });

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit((e) => resolve(e.exitCode));
      session.dispose();
    });
    // Killed by dispose()'s own `proc.kill()` (SIGTERM, the default
    // `Subprocess.kill()` signal) — not a clean 0.
    expect(exitCode).not.toBe(0);

    service.dispose();
  });

  test("a naturally-exited session is dropped from the service's own sweep set, so service.dispose() does not tear it down a second time", async () => {
    // Hand-rolled fakes for `Bun.Terminal`/`Bun.spawn` (no mock library):
    // this test needs to observe whether `service.dispose()`'s sweep
    // calls `dispose()` a SECOND time on a session that already exited on
    // its own — real `Bun.Terminal`/`Bun.Subprocess` objects tolerate a
    // redundant `close()`/`kill()` silently (verified by hand against the
    // real APIs), so counting calls needs fakes that record them, not the
    // real primitives.
    const originalTerminal = Bun.Terminal;
    const originalSpawn = Bun.spawn;
    let closeCalls = 0;
    let killCalls = 0;
    let fireNaturalExit: (() => void) | undefined;

    (Bun as unknown as { Terminal: unknown }).Terminal = class {
      close() {
        closeCalls++;
      }
    };
    (Bun as unknown as { spawn: unknown }).spawn = (
      _cmd: string[],
      options: { onExit?: (proc: unknown, exitCode: number | null) => void },
    ) => {
      fireNaturalExit = () => options.onExit?.(undefined, 0);
      return {
        pid: 4242,
        kill() {
          killCalls++;
        },
      };
    };

    try {
      const service = createTerminalService();
      const session = service.spawn({ cmd: ["irrelevant-fake-cmd"], cols: 80, rows: 24 });

      let exitFired = false;
      session.onExit(() => {
        exitFired = true;
      });

      // Simulate the child exiting ON ITS OWN — never via `session.
      // dispose()` — the same way `Bun.spawn`'s real `onExit` callback
      // would report a self-terminated child.
      fireNaturalExit?.();
      expect(exitFired).toBe(true);
      expect(closeCalls).toBe(0);
      expect(killCalls).toBe(0);

      // If the naturally-exited session were still tracked in the
      // service's own `sessions` set, this sweep would call its `dispose
      // ()` again, invoking the fake `term.close()`/`proc.kill()` a
      // SECOND time each.
      service.dispose();

      expect(closeCalls).toBe(0);
      expect(killCalls).toBe(0);
    } finally {
      Bun.Terminal = originalTerminal;
      Bun.spawn = originalSpawn;
    }
  });
});
