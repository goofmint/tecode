/**
 * `createTerminalService`: the implementation behind `tecode.terminal`
 * (Issue #98) — spawns child processes attached to a real pty via `Bun.
 * Terminal`/`Bun.spawn`. Follows `clipboard.ts`'s injectable, disposable,
 * never-throwing shape: `createTerminalService()` with no arguments is a
 * complete, working service; `log` only adds visibility into failures that
 * would otherwise be silently swallowed.
 *
 * **Three verified findings this module exists specifically to encode** —
 * each one silently breaks the feature if skipped, so each gets its own
 * paragraph rather than a single "see the issue" pointer:
 *
 * 1. **`term.resize()` updates the pty's winsize but never delivers
 *    `SIGWINCH`.** A shell polling `stty size` sees the new size
 *    immediately; a Node child's `SIGWINCH` handler never fires, and Node
 *    caches `process.stdout.columns` until that signal arrives — so a
 *    Node-based full-screen program (Claude Code among them) keeps
 *    drawing at the OLD size forever after a resize with no other
 *    symptom. {@link PtySession.resize} therefore calls `term.resize()`
 *    AND sends `SIGWINCH` to the child by hand (`deps.sendSignal`, this
 *    module's TSDoc below on why that call is injected rather than a bare
 *    `process.kill`).
 * 2. **`TerminalOptions.name` does NOT set `TERM` in the child.** It
 *    inherits whatever the host process's own `TERM` is, which degrades a
 *    thin-terminfo program's rendering. `spawn` always forces `TERM:
 *    "xterm-256color"` on `Bun.spawn`'s own `env` (last, unconditionally —
 *    see {@link PtySpawnOptions.env}'s TSDoc for why a caller-supplied
 *    `TERM` cannot override this).
 * 3. **`Bun.Terminal` is POSIX-only.** tecode ships a `bun-windows-x64`
 *    binary, so this module never constructs one unless {@link
 *    isPosixPlatform} says so — `spawn` degrades to {@link
 *    createInertSession} on Windows instead of throwing (`platform.ts`'s
 *    TSDoc explains the injectable platform check this relies on).
 *
 * **Never crashes the process** (matches `fileSystem.ts`'s `watch`/
 * `clipboard.ts`'s `write`): a spawn failure, a `term.close()` throw, or
 * killing an already-dead process is caught, reported through `deps.log`
 * when supplied, and swallowed — a dead or misbehaving pty must never take
 * the editor down. `PtySession.dispose()` is idempotent, matching every
 * other disposable in this codebase.
 */

import type { Disposable, Event, Listener, PtyExitEvent, PtySession, PtySpawnOptions, TerminalNamespace } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import { isPosixPlatform } from "./platform";

/** The exit code an inert/degraded {@link PtySession} reports on {@link
 * PtySession.onExit} (Windows, a disposed service, or a real spawn
 * failure) — a real child process exit code is always `>= 0`, so a
 * negative sentinel is unambiguous to a caller distinguishing "the child
 * ran and exited" from "this never really ran at all". */
const UNSUPPORTED_EXIT_CODE = -1;

/** Dependencies for {@link createTerminalService}. Every field is
 * optional. */
export interface TerminalServiceDeps {
  /** Structured log for spawn/resize/dispose failures (design.md §14).
   * Omitted (the default) swallows these silently — every method here
   * still never throws either way. */
  log?: HostLog;
  /** The platform to gate pty construction on — defaults to the real
   * `process.platform` (`platform.ts`'s `isPosixPlatform`). Inject
   * `"win32"` in a test to exercise the Windows-degradation path with no
   * global `process.platform` mutation. */
  platform?: NodeJS.Platform;
  /**
   * Sends a POSIX signal to a pid — defaults to `process.kill`. Injected
   * (rather than calling `process.kill` directly) so a test can assert
   * `resize()` actually sends `SIGWINCH` (finding 1 above) without a real
   * spawned process to receive it — `process.kill` on a pid that does not
   * exist throws `ESRCH`, which would make that assertion depend on
   * timing a real child's lifetime instead of just recording the call.
   */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

/** {@link createTerminalService}'s return type: the `TerminalNamespace`
 * extension code sees (`isSupported`/`spawn`), plus a host-only {@link
 * dispose} — `create.ts` narrows this away when assembling the frozen
 * `tecode.terminal` namespace extensions actually receive (matches
 * `clipboard.ts`'s `Clipboard` extending `ClipboardNamespace` with its own
 * host-only setters). */
export interface TerminalService extends TerminalNamespace {
  /**
   * Dispose every currently-live `PtySession` this service has spawned,
   * and mark the service itself shut down — a subsequent {@link
   * TerminalNamespace.spawn} call still returns a (now permanently inert)
   * session rather than throwing. The intended shutdown-sequence hook
   * (design.md §14's "flush ... dispose every core-owned service"): unlike
   * `createClipboard` (no real OS resource to release), a pty holds a real
   * child process, so leaving one running past process exit is a real
   * leak, not just an inert object. Idempotent.
   */
  dispose(): void;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `clipboard.ts`'s/`fileSystem.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

function makeEvent<T>(listeners: Set<Listener<T>>): Event<T> {
  return (listener) => {
    listeners.add(listener);
    let disposed = false;
    const disposable: Disposable = {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      },
    };
    return disposable;
  };
}

/**
 * An inert `PtySession`: `write`/`resize` are no-ops, `onData` never
 * fires, and `onExit` fires exactly once with `exitCode` shortly after
 * construction (deferred to a microtask — see this function's call sites
 * for why: a caller that subscribes to `onExit` immediately after
 * receiving the session from `spawn()`, before this call site's own
 * microtask queue runs again, always observes it, matching {@link
 * PtySession.onExit}'s own documented "always observes it" guarantee).
 * `dispose()` is a no-op — there is nothing real to release.
 */
function createInertSession(exitCode: number): PtySession {
  const exitListeners = new Set<Listener<PtyExitEvent>>();
  queueMicrotask(() => {
    for (const listener of Array.from(exitListeners)) {
      try {
        listener({ exitCode });
      } catch {
        // No `log` reachable from this standalone helper — see call
        // sites, which log the ORIGINATING failure themselves before
        // building this fallback session; a listener throwing on top of
        // that has nowhere further to go (matches this codebase's other
        // guarded event dispatch).
      }
    }
  });
  return {
    write() {},
    resize() {},
    onData: makeEvent(new Set<Listener<Uint8Array>>()),
    onExit: makeEvent(exitListeners),
    dispose() {},
  };
}

/**
 * Build a {@link TerminalService} (Issue #98). `deps.log`/`deps.platform`/
 * `deps.sendSignal` are optional — see {@link TerminalServiceDeps}.
 */
export function createTerminalService(deps: TerminalServiceDeps = {}): TerminalService {
  const posix = isPosixPlatform(deps.platform);
  const sendSignal = deps.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  let serviceDisposed = false;
  const sessions = new Set<{ dispose(): void }>();

  function logSafely(err: HostError): void {
    if (!deps.log) return;
    try {
      deps.log.append("warning", err);
    } catch {
      // Swallowed — see this module's TSDoc's never-throw discipline.
    }
  }

  function isSupported(): boolean {
    return posix;
  }

  /** Build a real, `Bun.Terminal`-backed `PtySession` for `options`. Only
   * ever called once `posix`/`serviceDisposed` have already been checked
   * by {@link spawn}. */
  function spawnReal(options: PtySpawnOptions): PtySession {
    const dataListeners = new Set<Listener<Uint8Array>>();
    const exitListeners = new Set<Listener<PtyExitEvent>>();
    let disposed = false;

    function fireData(bytes: Uint8Array): void {
      for (const listener of Array.from(dataListeners)) {
        try {
          listener(bytes);
        } catch (cause) {
          logSafely({ message: `PtySession onData listener threw: ${describeError(cause)}` });
        }
      }
    }

    function fireExit(exitCode: number): void {
      for (const listener of Array.from(exitListeners)) {
        try {
          listener({ exitCode });
        } catch (cause) {
          logSafely({ message: `PtySession onExit listener threw: ${describeError(cause)}` });
        }
      }
    }

    const term = new Bun.Terminal({
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data(_t, bytes) {
        fireData(bytes);
      },
    });

    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(options.cmd, {
        terminal: term,
        cwd: options.cwd,
        // `TERM` is forced LAST, unconditionally — finding 2 (this
        // module's TSDoc): `TerminalOptions.name` above does NOT set it,
        // and a thin inherited `TERM` silently degrades a full-screen
        // program's rendering with no other symptom.
        env: { ...process.env, ...options.env, TERM: "xterm-256color" },
        onExit(_subprocess, exitCode) {
          fireExit(exitCode ?? UNSUPPORTED_EXIT_CODE);
        },
      });
    } catch (cause) {
      logSafely({
        message: `Failed to spawn pty process "${options.cmd.join(" ")}": ${describeError(cause)}`,
      });
      try {
        term.close();
      } catch {
        // The terminal never successfully attached to a process — best
        // effort only.
      }
      return createInertSession(UNSUPPORTED_EXIT_CODE);
    }

    function write(data: string): void {
      if (disposed) return;
      try {
        term.write(data);
      } catch (cause) {
        logSafely({ message: `PtySession write failed: ${describeError(cause)}` });
      }
    }

    function resize(cols: number, rows: number): void {
      if (disposed) return;
      try {
        term.resize(cols, rows);
      } catch (cause) {
        logSafely({ message: `PtySession resize(${cols}, ${rows}) failed: ${describeError(cause)}` });
      }
      // Finding 1 (this module's TSDoc): `term.resize()` alone never
      // reaches a Node child's `SIGWINCH` handler. Sent even if the
      // `resize()` call above failed — the pty's winsize and the child's
      // own idea of its size are two independent things, and a child
      // that is still alive deserves the signal regardless.
      try {
        sendSignal(proc.pid, "SIGWINCH");
      } catch (cause) {
        logSafely({ message: `PtySession SIGWINCH delivery to pid ${proc.pid} failed: ${describeError(cause)}` });
      }
    }

    const sessionHandle = {
      dispose() {
        if (disposed) return;
        disposed = true;
        sessions.delete(sessionHandle);
        try {
          term.close();
        } catch (cause) {
          logSafely({ message: `PtySession term.close() failed: ${describeError(cause)}` });
        }
        try {
          proc.kill();
        } catch (cause) {
          // Includes killing an already-dead process — this module's
          // TSDoc's "never crashes" contract covers exactly this case.
          logSafely({ message: `PtySession process.kill() failed: ${describeError(cause)}` });
        }
      },
    };
    sessions.add(sessionHandle);

    return {
      write,
      resize,
      onData: makeEvent(dataListeners),
      onExit: makeEvent(exitListeners),
      dispose: sessionHandle.dispose,
    };
  }

  function spawn(options: PtySpawnOptions): PtySession {
    if (!posix) {
      logSafely({ message: "Integrated terminal is not supported on this platform (Windows)." });
      return createInertSession(UNSUPPORTED_EXIT_CODE);
    }
    if (serviceDisposed) {
      logSafely({ message: "Cannot spawn a pty: the terminal service has already been disposed." });
      return createInertSession(UNSUPPORTED_EXIT_CODE);
    }
    return spawnReal(options);
  }

  function dispose(): void {
    if (serviceDisposed) return;
    serviceDisposed = true;
    // Snapshot before iterating: each session's own dispose() removes
    // itself from `sessions` mid-loop (matches `documentManager.ts`'s
    // `fire`/this module's own `fireData`/`fireExit`).
    for (const session of Array.from(sessions)) {
      try {
        session.dispose();
      } catch (cause) {
        logSafely({ message: `TerminalService shutdown: a session's dispose() threw: ${describeError(cause)}` });
      }
    }
  }

  return { isSupported, spawn, dispose };
}
