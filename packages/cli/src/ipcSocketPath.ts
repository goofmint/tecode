/**
 * Where one running tecode instance's single-instance IPC socket lives
 * (Issue #158): `$XDG_RUNTIME_DIR/tecode/<pid>.sock`, falling back to
 * `<os.tmpdir()>/tecode/<pid>.sock` when `XDG_RUNTIME_DIR` is unset or
 * empty (macOS sets it on essentially nothing; Linux desktops set it to a
 * per-user, 0700, tmpfs-backed directory that the session manager cleans
 * up on logout — exactly the right home for a socket).
 *
 * **Deliberately NOT part of `@tecode/core`'s `host/paths.ts`**, which is
 * the other "where do tecode's files live" module: that one resolves
 * CONFIGURATION (`~/.config/tecode/settings.json` and friends) and
 * intentionally never consults `XDG_RUNTIME_DIR` or `os.tmpdir()`. A socket
 * is not configuration — it is runtime state whose entire lifetime is one
 * process, it must never be backed up or synced, and it belongs in a
 * directory something else is willing to sweep. Mixing the two would make
 * `paths.ts` answer two unrelated questions.
 *
 * **`<pid>` in the filename, not a fixed name**: several tecode instances
 * routinely run at once (one per project window), so there is no single
 * "the" instance to claim a well-known path — and a per-pid name means a
 * crashed instance's leftover socket can never be mistaken for a live one's
 * (a client that connects to a stale path simply fails and starts
 * normally, `ipcClient.ts`).
 *
 * Pure: returns a path string and touches nothing. Creating the directory
 * (0700) and the socket (0600) is `ipcServer.ts`'s job — see its TSDoc for
 * why those two modes are the security boundary of this whole feature.
 */

import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

/** The one directory name both the `XDG_RUNTIME_DIR` and `os.tmpdir()`
 * branches nest under, so every instance's socket for a given user lands in
 * one place. The `os.tmpdir()` branch appends the current uid to it — see
 * {@link resolveIpcSocketDir}. */
const SOCKET_DIR_NAME = "tecode";

/** Optional overrides for {@link resolveIpcSocketPath} — every field
 * defaults to the real global, matching `terminal/platform.ts`'s own
 * "injectable parameters, real defaults, no global mutation in tests"
 * convention. */
export interface IpcSocketPathOptions {
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `node:os`'s `tmpdir()`. */
  tmpdir?: () => string;
  /** The current user id, used ONLY by the `os.tmpdir()` fallback
   * ({@link resolveIpcSocketDir}). Defaults to `process.getuid?.()`, which
   * is `undefined` on Windows — where this whole channel is disabled
   * anyway (`@tecode/core`'s `supportsTerminalIpc`), so the un-suffixed
   * name is used there. */
  uid?: number;
}

/**
 * The directory {@link resolveIpcSocketPath} places sockets in (this
 * module's TSDoc) — exported separately because `ipcServer.ts` has to
 * create it with mode 0700 before it can listen.
 *
 * **The `os.tmpdir()` fallback is per-user; the `XDG_RUNTIME_DIR` one is
 * not.** `XDG_RUNTIME_DIR` is already a per-user directory, so a fixed
 * `tecode` name inside it is unambiguous. `os.tmpdir()` usually is NOT —
 * it is typically `/tmp`, shared by every account on the machine — and
 * `ipcServer.ts` creates this directory 0700, so a fixed `/tmp/tecode`
 * would let whichever user started tecode first lock every other user
 * out of the feature entirely (their `listen` would fail inside a
 * directory they cannot write, and `dispose` only unlinks the socket, not
 * the directory, so the lockout would outlive that first instance).
 * Appending the uid keeps each user in their own 0700 directory.
 */
export function resolveIpcSocketDir(options: IpcSocketPathOptions = {}): string {
  const env = options.env ?? process.env;
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  if (runtimeDir !== undefined && runtimeDir.length > 0) return join(runtimeDir, SOCKET_DIR_NAME);
  const uid = options.uid ?? process.getuid?.();
  const name = uid === undefined ? SOCKET_DIR_NAME : `${SOCKET_DIR_NAME}-${uid}`;
  return join((options.tmpdir ?? osTmpdir)(), name);
}

/** This instance's socket path (this module's TSDoc). */
export function resolveIpcSocketPath(options: IpcSocketPathOptions = {}): string {
  const pid = options.pid ?? process.pid;
  return join(resolveIpcSocketDir(options), `${pid}.sock`);
}
