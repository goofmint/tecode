/**
 * The wire format for tecode's single-instance IPC channel (Issue #158) —
 * shared by `ipcServer.ts` (the already-running instance, which listens)
 * and `ipcClient.ts` (a `tecode <file>` invocation from inside that
 * instance's integrated terminal, which connects and delegates).
 *
 * **One request = one line of JSON, one response = one line of JSON.** A
 * newline-delimited framing is enough for a channel whose entire vocabulary
 * is "open this path": it needs no length prefix, survives a `data` event
 * that splits or coalesces messages (both sides buffer until a `\n`), and
 * stays trivially inspectable with `nc`.
 *
 * **The request is data, never a command.** {@link parseIpcRequest} accepts
 * exactly one `type` — `"open"` — and every other value (or a payload that
 * is not an object, or a `path` that is not a non-empty absolute string)
 * is rejected outright. This is deliberate and load-bearing, not merely
 * defensive: the socket is reachable by every program the user runs in the
 * integrated terminal, so a channel that could carry "run this command"
 * would hand each of them the editor's full privileges (Issue #158's
 * security section). Adding a second `type` here is therefore a security
 * decision, not a feature decision.
 *
 * **Response is separate from receipt** ({@link IpcResponse}): the server
 * answers when the work is *done*, which for `wait: true` means "the
 * document the client asked to open was closed again" — the `emacsclient
 * --wait`/`$EDITOR` shape (Issue #158's `--wait` discussion). Keeping the
 * protocol request/response-shaped from the start is what makes that
 * possible without a second, incompatible message format.
 *
 * Pure: this module does no I/O, holds no state, and never throws.
 */

import { isAbsolute } from "node:path";

/** The only protocol version this build speaks. Sent by the client and
 * required by {@link parseIpcRequest} — a future incompatible change bumps
 * this, and an older host then rejects the request rather than
 * misinterpreting it (the client degrades to starting normally, exactly as
 * it does for a socket nobody is listening on). */
export const IPC_PROTOCOL_VERSION = 1;

/** The one request this channel accepts (this module's TSDoc). */
export interface IpcOpenRequest {
  v: typeof IPC_PROTOCOL_VERSION;
  type: "open";
  /** Absolute path to open. Absolute because the two processes may not
   * share a working directory, and because resolving a relative path
   * host-side would make the host's own cwd part of the protocol. */
  path: string;
  /** The client's working directory — recorded for diagnostics only; the
   * host never resolves anything against it (see {@link path}). */
  cwd: string;
  /** `true` when the client will block until the opened document is closed
   * again (`--wait`, the `$EDITOR` use case). Absent/`false` means the
   * server responds as soon as the file is open. */
  wait?: boolean;
}

/** The single line the server writes back per request. */
export interface IpcResponse {
  v: typeof IPC_PROTOCOL_VERSION;
  /** Whether the request was accepted AND carried out. */
  ok: boolean;
  /** Present only when `ok` is `false` — a short, human-readable reason.
   * The client never parses this; it only reports it. */
  error?: string;
}

/** Serialize one message as a single newline-terminated line (this
 * module's framing). */
export function encodeIpcMessage(message: IpcOpenRequest | IpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parse one already-de-framed line into an {@link IpcOpenRequest}, or
 * `undefined` when it is not one — malformed JSON, a non-object payload, a
 * wrong `v`, any `type` other than `"open"`, a missing/empty/relative
 * `path`, or a non-string `cwd`. Never throws: a hostile or simply
 * confused peer must degrade to "request ignored", never to a crash in the
 * editor process that happens to be listening.
 *
 * `isAbsolutePath` is injected (defaulting to `node:path`'s `isAbsolute`)
 * only so a test can exercise the Windows-shaped rule on a POSIX host;
 * production always passes nothing.
 */
export function parseIpcRequest(
  line: string,
  isAbsolutePath: (path: string) => boolean = defaultIsAbsolute,
): IpcOpenRequest | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record["v"] !== IPC_PROTOCOL_VERSION) return undefined;
  if (record["type"] !== "open") return undefined;
  const path = record["path"];
  if (typeof path !== "string" || path.length === 0 || !isAbsolutePath(path)) return undefined;
  const cwd = record["cwd"];
  if (typeof cwd !== "string") return undefined;
  const wait = record["wait"];
  if (wait !== undefined && typeof wait !== "boolean") return undefined;
  return { v: IPC_PROTOCOL_VERSION, type: "open", path, cwd, wait: wait === true };
}

/**
 * Parse one already-de-framed line into an {@link IpcResponse}, or
 * `undefined` when it is not one. Same never-throwing contract as
 * {@link parseIpcRequest} — the client treats an unparseable answer as "no
 * answer", which it already handles by starting normally.
 */
export function parseIpcResponse(line: string): IpcResponse | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record["v"] !== IPC_PROTOCOL_VERSION) return undefined;
  const ok = record["ok"];
  if (typeof ok !== "boolean") return undefined;
  const error = record["error"];
  if (error !== undefined && typeof error !== "string") return undefined;
  return error === undefined
    ? { v: IPC_PROTOCOL_VERSION, ok }
    : { v: IPC_PROTOCOL_VERSION, ok, error };
}

/**
 * Split whatever has accumulated in a socket's receive buffer into whole
 * lines plus the (possibly empty) still-incomplete remainder — the one
 * piece of framing both `ipcServer.ts` and `ipcClient.ts` need, factored
 * out so neither re-implements it. Blank lines are dropped: a peer that
 * writes `\r\n` or an extra newline should not produce a phantom
 * "malformed request".
 */
export function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, rest };
}

/** `node:path`'s `isAbsolute`, as {@link parseIpcRequest}'s default — kept
 * as a named function rather than an inline default so the injected-seam
 * shape reads the same as every other `*Fs`-style dependency in this
 * codebase. */
function defaultIsAbsolute(path: string): boolean {
  return isAbsolute(path);
}
