/**
 * The connecting half of tecode's single-instance channel (Issue #158):
 * decides whether THIS invocation should hand its file to an
 * already-running instance ({@link resolveDelegateTarget}) and, if so, does
 * it ({@link delegateOpen}).
 *
 * The integrated terminal injects `TECODE_SOCK` into every shell it spawns
 * (`packages/builtin/terminal`), so a `tecode foo.ts` typed inside tecode
 * finds it in its own environment. Nothing else sets it, which is what
 * makes its mere presence a reliable "you are running inside a tecode
 * terminal" signal.
 *
 * **Fail-safe in exactly one direction.** Every failure — no
 * `TECODE_SOCK`, a stale socket whose owner died, a refused connection, a
 * malformed answer, a host that never answers — resolves to "not
 * delegated", and `main.ts` then starts normally. That is the behaviour
 * tecode had before this feature existed, so the worst outcome of a broken
 * channel is the old outcome. The opposite bias (refusing to start because
 * delegation failed) would turn a cosmetic convenience into a way to be
 * unable to open a file at all.
 */

import type { Socket } from "bun";
import {
  encodeIpcMessage,
  parseIpcResponse,
  takeCompleteLines,
  IPC_PROTOCOL_VERSION,
  type IpcResponse,
} from "./ipcProtocol";

/** The environment variable the integrated terminal injects, naming the
 * socket of the instance that owns that terminal (`packages/builtin/
 * terminal/index.ts`). */
export const IPC_SOCKET_ENV_VAR = "TECODE_SOCK";

/** How long {@link delegateOpen} waits for a response before giving up and
 * letting the caller start normally. Only applies to a NON-`wait` request:
 * a `--wait` client is deliberately blocking until the user closes the
 * document, which has no time bound at all. Exported so a test can assert
 * against it rather than a magic number. */
export const DELEGATE_TIMEOUT_MS = 2_000;

/** Everything {@link resolveDelegateTarget} needs to make its decision —
 * all plain values, so the decision itself is a pure function a test can
 * exercise without a socket, an environment, or a process. */
export interface DelegateTargetInput {
  /** Usually `process.env`. */
  env: Record<string, string | undefined>;
  /** `supportsTerminalIpc()` (`@tecode/core`'s `terminal/platform.ts`) —
   * passed in rather than called here so the OS branch stays confined to
   * that one module. */
  platformSupportsIpc: boolean;
  /** `--new-window` was passed: the user explicitly asked for a separate
   * instance, so nothing is delegated. */
  newWindow: boolean;
  /** `--wait` was passed (the `$EDITOR` case). */
  wait: boolean;
  /** `resolveStartupTarget`'s `initialFilePath` — `undefined` for a
   * directory argument or a bare `tecode`, neither of which has a file to
   * hand over. */
  initialFilePath?: string;
}

/** A resolved decision to delegate — everything {@link delegateOpen} needs,
 * with no remaining conditions to check. */
export interface DelegateTarget {
  socketPath: string;
  path: string;
  wait: boolean;
}

/**
 * Decide whether this invocation should delegate, and to where (this
 * module's TSDoc). Returns `undefined` — meaning "start normally" — unless
 * ALL of the following hold:
 *
 * - the platform has the IPC channel at all (`platformSupportsIpc`),
 * - `--new-window` was not passed,
 * - `TECODE_SOCK` names a non-empty path (i.e. this process really was
 *   launched from inside another instance's integrated terminal),
 * - and there is an actual file to open (`initialFilePath`). A bare
 *   `tecode` or a directory argument means "give me an editor", not "open
 *   this" — delegating it would leave the user staring at the instance
 *   they already had, with nothing to show that their command did
 *   anything.
 *
 * Pure and never throws.
 */
export function resolveDelegateTarget(input: DelegateTargetInput): DelegateTarget | undefined {
  if (!input.platformSupportsIpc) return undefined;
  if (input.newWindow) return undefined;
  if (input.initialFilePath === undefined || input.initialFilePath.length === 0) return undefined;
  const socketPath = input.env[IPC_SOCKET_ENV_VAR];
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  return { socketPath, path: input.initialFilePath, wait: input.wait };
}

/** The connection seam {@link delegateOpen} uses — defaults to
 * `Bun.connect({ unix })`, and a test substitutes an in-memory pair. Shaped
 * as "give me the handlers, hand me back something I can write to and
 * end", which is exactly `Bun.connect`'s own contract narrowed to the two
 * methods this module calls. */
export interface DelegateConnection {
  write(data: string): void;
  end(): void;
}

/** Callbacks {@link DelegateConnect} delivers back to {@link delegateOpen}. */
export interface DelegateConnectHandlers {
  data(chunk: string): void;
  close(): void;
  error(cause: unknown): void;
}

/** Opens a connection to `socketPath`, rejecting if it cannot. */
export type DelegateConnect = (
  socketPath: string,
  handlers: DelegateConnectHandlers,
) => Promise<DelegateConnection>;

/** Options for {@link delegateOpen} — every field has a production
 * default; tests override them. */
export interface DelegateOpenOptions {
  /** Defaults to a real `Bun.connect({ unix })`. */
  connect?: DelegateConnect;
  /** Defaults to `process.cwd()`; sent for diagnostics only (the host
   * resolves nothing against it — `ipcProtocol.ts`). */
  cwd?: string;
  /** Defaults to {@link DELEGATE_TIMEOUT_MS}; ignored entirely when
   * `target.wait` is `true`. */
  timeoutMs?: number;
}

/** The real {@link DelegateConnect}: `Bun.connect({ unix })`.
 *
 * The no-op `open` handler is NOT decorative: without one, Bun dispatches
 * this socket's `close` callback ahead of its `data` callback, which would
 * make every delegation look like "the peer hung up without answering" and
 * silently disable the whole feature. Declaring `open` keeps the callbacks
 * in their documented order (verified against Bun 1.3.14). */
const bunConnect: DelegateConnect = async (socketPath, handlers) => {
  const socket: Socket<undefined> = await Bun.connect({
    unix: socketPath,
    socket: {
      open() {
        // See this constant's TSDoc — required for correct event ordering.
      },
      data(_socket, chunk) {
        handlers.data(chunk.toString());
      },
      close() {
        handlers.close();
      },
      error(_socket, cause) {
        handlers.error(cause);
      },
    },
  });
  return {
    write: (data) => {
      socket.write(data);
    },
    end: () => {
      socket.end();
    },
  };
};

/**
 * Send one `open` request to the instance listening on
 * `target.socketPath` and resolve `true` once it answers `ok` — the signal
 * `main.ts` takes as "this invocation is done; exit 0 without starting an
 * editor".
 *
 * Resolves `false` for every other outcome (this module's "fail-safe in
 * exactly one direction" TSDoc): the socket does not exist or refuses the
 * connection, the peer closes without answering, the answer is malformed
 * or reports `ok: false`, or — for a non-`wait` request — nothing arrives
 * within `timeoutMs`. Never throws, never rejects.
 *
 * With `target.wait`, the answer only comes once the opened document is
 * closed again, so this resolves whenever that happens (or when the editor
 * shuts down, which answers every pending request first —
 * `ipcServer.ts`'s `dispose`).
 */
export async function delegateOpen(
  target: DelegateTarget,
  options: DelegateOpenOptions = {},
): Promise<boolean> {
  const connect = options.connect ?? bunConnect;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DELEGATE_TIMEOUT_MS;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let buffer = "";
    let connection: DelegateConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function settle(result: boolean): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        connection?.end();
      } catch {
        // Already gone — the result is decided either way.
      }
      resolve(result);
    }

    function onResponse(response: IpcResponse): void {
      settle(response.ok);
    }

    const handlers: DelegateConnectHandlers = {
      data(chunk) {
        const { lines, rest } = takeCompleteLines(buffer + chunk);
        buffer = rest;
        for (const line of lines) {
          const response = parseIpcResponse(line);
          // An unparseable line is treated as no answer at all rather than
          // as a failure verdict: the timeout (or the peer's close) then
          // decides, and the caller starts normally.
          if (response) onResponse(response);
        }
      },
      close() {
        settle(false);
      },
      error() {
        settle(false);
      },
    };

    // Only a non-`wait` request is time-bounded — see
    // {@link DELEGATE_TIMEOUT_MS}.
    if (!target.wait) {
      timer = setTimeout(() => settle(false), timeoutMs);
    }

    connect(target.socketPath, handlers).then(
      (opened) => {
        connection = opened;
        if (settled) {
          // The timeout already fired while the connection was still being
          // established — close what we just opened and stay decided.
          try {
            opened.end();
          } catch {
            // Nothing left to do.
          }
          return;
        }
        try {
          opened.write(
            encodeIpcMessage({
              v: IPC_PROTOCOL_VERSION,
              type: "open",
              path: target.path,
              cwd,
              wait: target.wait,
            }),
          );
        } catch {
          settle(false);
        }
      },
      () => {
        // No listener, a stale socket, or no permission — all "start
        // normally".
        settle(false);
      },
    );
  });
}
