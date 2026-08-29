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
 * 3. **`Bun.Terminal` needs Bun 1.3.14+ on Windows.** It was POSIX-only
 *    (Linux, macOS) through Bun 1.3.13; Bun 1.3.14 (2026-05-13) added
 *    ConPTY-backed (`CreatePseudoConsole`) support on Windows. tecode
 *    ships a `bun-windows-x64` binary, so this module never constructs a
 *    `Bun.Terminal` unless {@link supportsBunTerminal} says the running
 *    platform/Bun version actually supports it — `spawn` degrades to
 *    {@link createInertSession} when it does not, instead of throwing
 *    (`platform.ts`'s TSDoc explains the injectable platform/version
 *    check this relies on).
 *
 * 4. **`dispose()` must kill the child BEFORE closing the pty.** ConPTY's
 *    `ClosePseudoConsole` waits for its client to exit, and on Windows
 *    builds before 11 24H2 (26100) it waits indefinitely — so closing a
 *    pty whose child is still running hangs the calling thread and the
 *    kill that would have released it never runs, stalling the editor's
 *    whole shutdown sweep ({@link TerminalService.dispose}). POSIX is
 *    indifferent to the order (the child takes SIGHUP/EIO from the closed
 *    master either way), so `PtySession.dispose` kills first
 *    unconditionally rather than branching on the platform.
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
import { deliversSigwinch, supportsBunTerminal } from "./platform";

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
   * `process.platform` (`platform.ts`'s `supportsBunTerminal`). Inject
   * `"win32"` in a test to exercise the Windows-degradation path with no
   * global `process.platform` mutation. */
  platform?: NodeJS.Platform;
  /** The Bun version to gate Windows pty construction on — defaults to
   * the real `Bun.version` (`platform.ts`'s `supportsBunTerminal`).
   * Injected for the same reason as `platform` above: a test can exercise
   * both sides of the Bun 1.3.14 ConPTY threshold on `"win32"` with a
   * literal version string, with no global `Bun.version` mutation (which
   * is not even writable). Irrelevant on non-`"win32"` platforms — see
   * `supportsBunTerminal`'s own TSDoc.
   *
   * **Any test that injects `platform: "win32"` to reach the UNSUPPORTED
   * state must pin this too.** Left out, it falls back to whatever Bun is
   * running the suite, and the assertion silently becomes environment-
   * dependent: `create.terminal.test.ts` did exactly that and passed on a
   * 1.3.11 dev machine while failing on CI's `bun-version: latest`. */
  bunVersion?: string;
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
  const supported = supportsBunTerminal(deps.platform, deps.bunVersion);
  const sigwinch = deliversSigwinch(deps.platform);
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
    return supported;
  }

  /** Build a real, `Bun.Terminal`-backed `PtySession` for `options`. Only
   * ever called once `supported`/`serviceDisposed` have already been checked
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
      // A session that exits on its own (the child died/was killed by
      // something other than this module's own `dispose()`) must also
      // stop being tracked in `sessions` — otherwise `sessions` grows
      // without bound over a long editing session with repeated
      // respawns, since only `sessionHandle.dispose()` below used to
      // remove an entry. `sessionHandle` is referenced here even though
      // it is a `const` declared further down this same function: safe
      // because `fireExit` is only ever invoked from `Bun.spawn`'s own
      // `onExit` callback below, which — being how a child process exit
      // is reported — cannot fire until AFTER `spawnReal` has returned
      // and `sessionHandle` has been assigned. Idempotent: harmless if
      // `dispose()` already removed it (killing a still-live child also
      // makes this same callback fire).
      sessions.delete(sessionHandle);
      for (const listener of Array.from(exitListeners)) {
        try {
          listener({ exitCode });
        } catch (cause) {
          logSafely({ message: `PtySession onExit listener threw: ${describeError(cause)}` });
        }
      }
    }

    // `new Bun.Terminal(...)` can throw on its own — fd exhaustion, an
    // unusable `/dev/ptmx`, ... — same as `Bun.spawn` just below, so it
    // gets the identical guarded-`let`-assigned-inside-`try` shape rather
    // than being left to throw straight out of `spawnReal`/`spawn`/
    // `activate()` (this module's TSDoc's "Never crashes the process"
    // paragraph; `@tecode/api`'s `TerminalNamespace.spawn` "never throws"
    // contract).
    let term: Bun.Terminal;
    try {
      term = new Bun.Terminal({
        cols: options.cols,
        rows: options.rows,
        name: "xterm-256color",
        data(_t, bytes) {
          fireData(bytes);
        },
      });
    } catch (cause) {
      logSafely({
        message: `Failed to construct pty (Bun.Terminal) for "${options.cmd.join(" ")}": ${describeError(cause)}`,
      });
      return createInertSession(UNSUPPORTED_EXIT_CODE);
    }

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
      //
      // Skipped entirely where the signal does not exist (Windows —
      // `platform.ts`'s `deliversSigwinch`): ConPTY resizes the console
      // natively, so there is nothing to hand-deliver, and attempting it
      // would throw `ERR_UNKNOWN_SIGNAL` on EVERY resize and log a
      // warning the user can do nothing about.
      if (!sigwinch) return;
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
        // KILL FIRST, then close the pty — the order matters on Windows
        // and is harmless everywhere else (finding 4, this module's
        // TSDoc). ConPTY's `ClosePseudoConsole` waits for its client to
        // exit, and before Windows 11 24H2 (build 26100) it waits
        // INDEFINITELY, so closing while the child is still running hangs
        // here and `proc.kill()` below is never reached — the editor's
        // whole shutdown sweep stalls on it. Killing first means the
        // child is already gone (or going) by the time the pty closes.
        // On POSIX either order works: the child gets SIGHUP/EIO from the
        // closed master whichever way round it happens.
        try {
          proc.kill();
        } catch (cause) {
          // Includes killing an already-dead process — this module's
          // TSDoc's "never crashes" contract covers exactly this case.
          logSafely({ message: `PtySession process.kill() failed: ${describeError(cause)}` });
        }
        try {
          term.close();
        } catch (cause) {
          logSafely({ message: `PtySession term.close() failed: ${describeError(cause)}` });
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
    if (!supported) {
      logSafely({
        message: "Integrated terminal is not supported here: Bun.Terminal needs Bun 1.3.14 or newer on Windows.",
      });
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
