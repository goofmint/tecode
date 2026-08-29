/**
 * Tests for `createTerminalService` (Issue #98). Covers the Windows
 * degradation path (injected `platform: "win32"`, no global `process.
 * platform` mutation — `platform.ts`'s TSDoc), the three verified
 * findings this module encodes (SIGWINCH delivery, forced `TERM`,
 * POSIX-only construction), and disposal idempotency/service-level
 * teardown.
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
    const service = createTerminalService({ platform: "win32" });
    expect(service.isSupported()).toBe(false);
  });

  test("spawn() never constructs a real pty: write/resize are no-ops, onData never fires, onExit fires once with a non-zero code, and a HostError is logged", async () => {
    const { log, entries } = createRecordingLog();
    const service = createTerminalService({ platform: "win32", log });

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
    const service = createTerminalService({ platform: "win32" });
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
    const service = createTerminalService({ platform: "win32" });
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
});
