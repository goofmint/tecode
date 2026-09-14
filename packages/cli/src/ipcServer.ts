/**
 * `createIpcServer` (Issue #158): the listening half of tecode's
 * single-instance channel. One running instance owns one Unix domain
 * socket (`ipcSocketPath.ts`); a `tecode <file>` invocation from inside
 * that instance's integrated terminal connects to it (`ipcClient.ts`) and
 * asks for the file to be opened HERE, instead of nesting a second
 * full-screen TUI inside the pty.
 *
 * **Why this lives in `packages/cli`, not `@tecode/core`** — the same
 * reasoning `terminalSessionTracker.ts` spells out for itself: this is
 * composition-root/process-lifecycle policy, not a core service. It owns a
 * real OS resource whose lifetime is exactly the lifetime of the process
 * (`main.ts`'s `createShutdown` unlinks it), it reaches the editor only
 * through the privileged `CommandRegistry` that `main.ts` alone holds, and
 * "is there another instance, and should this invocation defer to it" is a
 * question about how tecode is LAUNCHED — something no core service has any
 * business knowing about.
 *
 * **Security is the point of this module, not a footnote** (Issue #158's
 * security section). Anything the user runs in the integrated terminal
 * inherits `TECODE_SOCK` and can therefore talk to this socket, so:
 *
 * - The socket's directory is created 0700 and the socket itself is
 *   chmod'ed 0600 immediately after `listen`, so no other user on the
 *   machine can connect at all. (The chmod cannot happen before the socket
 *   exists; the 0700 directory is what covers that instant.)
 * - Exactly one request type — `"open"` — is accepted, and it carries a
 *   path, never a command line. `ipcProtocol.ts`'s `parseIpcRequest` is
 *   where that is enforced; adding a second type there would hand every
 *   program running in the terminal the editor's full privileges.
 * - The only thing an accepted request can do is `commands.execute(
 *   "workbench.action.files.openUri", <uri>)` — one fixed command id,
 *   never a caller-supplied one.
 *
 * **Never throws, degrades instead.** A socket that cannot be created (no
 * permission, a path collision, a platform that does not support it)
 * leaves {@link IpcServer.socketPath} `undefined` and the editor starts
 * exactly as it did before this feature existed — the whole channel is an
 * optimization, and the fallback (a second instance) is the pre-existing
 * behaviour, not an error state.
 *
 * **`wait: true`** holds the response until the document the request
 * opened is closed again (`--wait`, the `$EDITOR`/`git commit` case) —
 * see {@link IpcServer} and this file's `handleOpen`.
 */

import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import type { Disposable, Uri } from "@tecode/api";
import { pathToUri, type CoreDocument, type DocumentManager, type HostLog } from "@tecode/core";
import {
  encodeIpcMessage,
  parseIpcRequest,
  takeCompleteLines,
  IPC_PROTOCOL_VERSION,
  type IpcOpenRequest,
} from "./ipcProtocol";

/** The one command an accepted request may run (this module's TSDoc) —
 * `@tecode/core`'s `OPEN_FILE_COMMAND_ID`, restated as a local constant so
 * this module's single fixed command id is visible at a glance. */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** Directory mode for the socket's parent (this module's TSDoc). */
const SOCKET_DIR_MODE = 0o700;
/** Mode the socket itself is chmod'ed to right after `listen`. */
const SOCKET_MODE = 0o600;

/**
 * Most bytes one connection may accumulate without completing a line
 * (`ipcProtocol.ts`'s framing) before it is answered with an error and
 * dropped.
 *
 * Without a cap, a peer that simply never sends a newline grows
 * `ConnectionState.buffer` without bound — and every program the user runs
 * in the integrated terminal can reach this socket, so a buggy one could
 * exhaust the EDITOR's memory. 64 KiB is orders of magnitude more than the
 * only message this channel accepts (a JSON object holding two absolute
 * paths), so no legitimate request can ever approach it.
 */
const MAX_REQUEST_BYTES = 64 * 1024;

/** Dependencies for {@link createIpcServer} — narrowed with `Pick` per
 * house convention ("narrowing, not re-implementing") so a test can hand
 * over a two-field fake instead of a whole assembly root. */
export interface IpcServerDeps {
  /** Absolute path to listen on — `ipcSocketPath.ts`'s
   * `resolveIpcSocketPath()` in production. */
  socketPath: string;
  /** The privileged core registry. Only ever invoked with
   * {@link OPEN_FILE_COMMAND_ID}. */
  commands: { execute(id: string, ...args: unknown[]): Promise<unknown> };
  /** Used for two things, both only in the `wait: true` path: confirming
   * the requested document actually ended up open, and noticing when it is
   * closed again. */
  documents: Pick<DocumentManager, "documents" | "onDidClose">;
  log: HostLog;
}

/** {@link createIpcServer}'s return value. */
export interface IpcServer {
  /** The path this server is listening on, or `undefined` when it failed
   * to start (this module's "degrades instead" TSDoc). `main.ts` hands
   * exactly this value to each extension as `ExtensionContext.
   * ipcSocketPath`, so an inactive server means extensions see `undefined`
   * and the integrated terminal injects no `TECODE_SOCK` at all. */
  readonly socketPath: string | undefined;
  /** Stop listening, answer every still-pending `wait: true` request so no
   * client is left hanging, and unlink the socket file. Idempotent and
   * never throws — wired into `main.ts`'s `createShutdown` sequence, which
   * MUST reach it: an open listener keeps the event loop (and therefore
   * the process) alive. */
  dispose(): void;
}

/** Per-connection state: the still-unterminated tail of this socket's
 * receive buffer, plus every subscription a pending `wait: true` request
 * left behind (released when the peer disconnects, so a client that gives
 * up never leaks a document listener). */
interface ConnectionState {
  buffer: string;
  pending: Set<Disposable>;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` — reporting a failure must never become a second
 * failure (matches `@tecode/core`'s repeated `logSafely`). */
function logSafely(log: HostLog, level: "error" | "warning", message: string): void {
  try {
    log.append(level, { message });
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Build a {@link IpcServer} (this module's TSDoc). Never throws — a
 * failure to listen is reported through `deps.log` and yields a server
 * whose `socketPath` is `undefined` and whose `dispose()` is a no-op. */
export function createIpcServer(deps: IpcServerDeps): IpcServer {
  const { socketPath, commands, documents, log } = deps;
  const connections = new Map<Socket<ConnectionState>, ConnectionState>();
  let listener: UnixSocketListener<ConnectionState> | undefined;
  let disposed = false;

  /** Write one response line, ignoring a socket the peer already closed
   * (`Socket.write` on a dead socket throws in some Bun versions and is a
   * silent no-op in others — neither is worth failing an editor over). */
  function respond(socket: Socket<ConnectionState>, ok: boolean, error?: string): void {
    try {
      socket.write(
        encodeIpcMessage(error === undefined ? { v: IPC_PROTOCOL_VERSION, ok } : { v: IPC_PROTOCOL_VERSION, ok, error }),
      );
    } catch {
      // The client went away before it read its answer — nothing to do.
    }
  }

  /** Release one connection's pending `wait` subscriptions. */
  function releasePending(state: ConnectionState): void {
    for (const subscription of Array.from(state.pending)) {
      state.pending.delete(subscription);
      try {
        subscription.dispose();
      } catch {
        // `Disposable.dispose` is documented never-throwing; guarded anyway.
      }
    }
  }

  /** Forget one connection and hang up on it — used when a peer breaks the
   * protocol badly enough that there is nothing left to talk about
   * ({@link MAX_REQUEST_BYTES}). Never throws: `end()` on a socket the peer
   * already closed is not worth failing an editor over. */
  function dropConnection(socket: Socket<ConnectionState>, state: ConnectionState): void {
    releasePending(state);
    connections.delete(socket);
    try {
      socket.end();
    } catch {
      // Already gone.
    }
  }

  /**
   * Whether `uri` is currently among the open documents — this server's
   * ONLY way to tell a successful open from a failed one.
   *
   * `workbench.action.files.openUri` deliberately swallows every failure
   * (a bad uri, `EACCES`, a path that vanished) into its own log and
   * resolves `undefined` either way — `ui/openFileCommand.ts`'s "never
   * throws" contract, which exists for its original caller, the command
   * palette, where there is a UI to show the error in. A delegated request
   * has no such UI: the client is a CLI process that must decide between
   * "done, exit 0" and "fall back to starting an editor myself", so
   * `await commands.execute(...)` resolving tells it nothing and the state
   * of the document manager afterwards is what actually answers the
   * question (CodeRabbit review on PR #159).
   *
   * Checked from the state rather than from a return value on purpose:
   * widening that command's own signature would change a command every
   * other caller already depends on, for one new consumer.
   */
  function isDocumentOpen(uri: Uri): boolean {
    return documents.documents.some((document) => document.uri === uri);
  }

  /**
   * Hold this request's response until the just-opened document is closed
   * again. Returns `true` when the response is now the subscription's
   * responsibility, `false` when the caller should answer immediately —
   * which happens only when the connection has since gone away; the caller
   * has already established that the document really is open, so a close
   * that can never come is no longer possible here.
   */
  function deferResponseUntilClosed(socket: Socket<ConnectionState>, uri: Uri): boolean {
    const state = connections.get(socket);
    if (!state) return false;
    const subscription = documents.onDidClose((closed: CoreDocument) => {
      if (closed.uri !== uri) return;
      state.pending.delete(subscription);
      subscription.dispose();
      respond(socket, true);
    });
    state.pending.add(subscription);
    return true;
  }

  async function handleOpen(socket: Socket<ConnectionState>, request: IpcOpenRequest): Promise<void> {
    const uri = pathToUri(request.path);
    try {
      await commands.execute(OPEN_FILE_COMMAND_ID, uri);
    } catch (cause) {
      // `CommandRegistry.execute` is documented never-throwing; guarded
      // anyway so a surprise here still answers the client.
      respond(socket, false, describeError(cause));
      return;
    }
    // A fulfilled `execute` does NOT mean the file opened ({@link
    // isDocumentOpen}). Answering `ok: true` for a failed open would be the
    // worst of both worlds: the client exits 0 believing it is done, so the
    // file is neither open here nor opened by the fallback instance the
    // client would otherwise have started.
    if (!isDocumentOpen(uri)) {
      respond(socket, false, "could not open the requested file");
      return;
    }
    if (request.wait === true && deferResponseUntilClosed(socket, uri)) return;
    respond(socket, true);
  }

  function handleLine(socket: Socket<ConnectionState>, line: string): void {
    const request = parseIpcRequest(line);
    if (!request) {
      // Deliberately terse: the payload came from an untrusted peer, so it
      // is never echoed into the log.
      logSafely(log, "warning", `tecode ipc: ignored a malformed or unsupported request on ${socketPath}.`);
      respond(socket, false, "unsupported request");
      return;
    }
    void handleOpen(socket, request);
  }

  try {
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
    // `mkdirSync`'s `mode` applies only when it actually CREATES the
    // directory (and is masked by the process umask even then), so an
    // already-existing `.../tecode` left at 0755 by an earlier run under a
    // different umask would stay world-traversable. `Bun.listen` then
    // creates the socket under that same umask, leaving a window — before
    // the `chmodSync(socketPath, ...)` below lands — in which another user
    // could connect. chmod'ing the directory first closes that window. A
    // directory that is not ours to chmod fails here and is caught below,
    // which disables the channel rather than running it unprotected.
    chmodSync(socketDir, SOCKET_DIR_MODE);
    // A leftover file at OUR OWN path (a previous process with this pid
    // that never got to unlink it) would make `listen` fail outright. Only
    // this exact path is ever removed — never a sweep of the directory,
    // which could take a LIVE instance's socket out from under it.
    unlinkIfPresent(socketPath);
    listener = Bun.listen<ConnectionState>({
      unix: socketPath,
      socket: {
        open(socket) {
          const state: ConnectionState = { buffer: "", pending: new Set() };
          socket.data = state;
          connections.set(socket, state);
        },
        data(socket, chunk) {
          const state = connections.get(socket);
          if (!state) return;
          // Checked BEFORE concatenating, so the over-limit string is
          // never allocated at all ({@link MAX_REQUEST_BYTES}).
          if (state.buffer.length + chunk.length > MAX_REQUEST_BYTES) {
            logSafely(
              log,
              "warning",
              `tecode ipc: dropped a connection that exceeded ${MAX_REQUEST_BYTES} bytes without completing a request.`,
            );
            respond(socket, false, "request too large");
            dropConnection(socket, state);
            return;
          }
          const { lines, rest } = takeCompleteLines(state.buffer + chunk.toString());
          state.buffer = rest;
          for (const line of lines) handleLine(socket, line);
        },
        close(socket) {
          const state = connections.get(socket);
          if (!state) return;
          releasePending(state);
          connections.delete(socket);
        },
        error(socket, cause) {
          logSafely(log, "warning", `tecode ipc: connection error: ${describeError(cause)}`);
          const state = connections.get(socket);
          if (!state) return;
          releasePending(state);
          connections.delete(socket);
        },
      },
    });
    chmodSync(socketPath, SOCKET_MODE);
  } catch (cause) {
    logSafely(
      log,
      "warning",
      `tecode ipc: could not listen on "${socketPath}" (${describeError(cause)}); ` +
        `running "tecode <file>" from the integrated terminal will start a separate instance.`,
    );
    if (listener) {
      try {
        listener.stop(true);
      } catch {
        // Nothing further to do — this path is already the failure path.
      }
    }
    unlinkIfPresent(socketPath);
    listener = undefined;
  }

  const activePath = listener ? socketPath : undefined;

  return {
    get socketPath() {
      return activePath;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Answer everyone still waiting BEFORE tearing the listener down, so
      // a `--wait` client blocked on a document that outlives the editor
      // exits with the editor rather than hanging on a dead socket.
      for (const [socket, state] of Array.from(connections.entries())) {
        if (state.pending.size > 0) respond(socket, true);
        releasePending(state);
        connections.delete(socket);
      }
      if (listener) {
        try {
          listener.stop(true);
        } catch (cause) {
          logSafely(log, "warning", `tecode ipc: stopping the listener failed: ${describeError(cause)}`);
        }
      }
      unlinkIfPresent(socketPath);
    },
  };
}

/** Remove `path` if it exists, ignoring every failure (a missing file is
 * the expected case, and a file we cannot remove is already reported by
 * whatever fails next). */
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing (the normal case) or not removable — both fine here.
  }
}
