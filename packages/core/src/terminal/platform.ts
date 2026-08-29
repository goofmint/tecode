/**
 * The one platform/version gate for the integrated terminal (Issue #98):
 * `Bun.Terminal` — the native pty primitive `ptyService.ts` wraps — was
 * POSIX-only (Linux, macOS) through Bun 1.3.13, but **Bun 1.3.14
 * (2026-05-13) added `Bun.Terminal`/`Bun.spawn({ terminal })` support on
 * Windows via the ConPTY API (`CreatePseudoConsole`)**. tecode ships a
 * `bun-windows-x64` binary (`scripts/release.ts`'s `RELEASE_TARGETS`), so
 * every module in this `terminal/` domain that would otherwise construct a
 * `Bun.Terminal` MUST check {@link supportsBunTerminal} first rather than
 * branching on `process.platform` itself — confining the one OS/version
 * check to a single place, the same "confined entirely to this module"
 * discipline `host/paths.ts` uses for its own OS branch. A hard `platform
 * !== "win32"` gate (this module's earlier shape) would wrongly disable
 * the terminal on every Windows build running Bun 1.3.14+, which is why
 * the check is version-aware rather than a bare OS check.
 *
 * **Injectable, unlike `paths.ts`**: `paths.ts`'s tests override the real
 * `process.platform` global (via `Object.defineProperty`) for the
 * duration of each test. This module instead takes `platform`/`bunVersion`
 * as plain parameters, defaulting to `process.platform`/`Bun.version` — a
 * caller (`ptyService.ts`'s `createTerminalService`) threads its own
 * `deps.platform`/`deps.bunVersion` straight through, so a test can
 * exercise the Windows degraded-and-supported paths with literal
 * arguments and no global mutation, and no risk of a forgotten `afterEach`
 * restore leaking `process.platform`/`Bun.version` into an unrelated test.
 */

/** The first Bun release (2026-05-13) that added `Bun.Terminal`/`Bun.
 * spawn({ terminal })` support on Windows, via the ConPTY API
 * (`CreatePseudoConsole`) — {@link supportsBunTerminal}'s TSDoc. Below
 * this, `Bun.Terminal` on `"win32"` either does not exist or is known
 * broken. */
const MIN_WINDOWS_BUN_VERSION = [1, 3, 14] as const;

/** Parse the leading `major.minor.patch` numbers off the front of a Bun
 * version string, ignoring any pre-release/build suffix (e.g.
 * `"1.3.14-canary.3"` → `[1, 3, 14]`). Returns `undefined` for a string
 * that does not start with that shape at all (fails closed — see {@link
 * supportsBunTerminal}). */
function parseLeadingVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `true` iff `version` is greater than or equal to `min`, comparing
 * major/minor/patch in order (a plain semver-ish comparison — no need for
 * anything fancier since both inputs here are already parsed numeric
 * triples). */
function isAtLeast(version: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

/**
 * Whether a child process on `platform` (default: the real `process.
 * platform`) can be sent `SIGWINCH` at all — `true` everywhere except
 * `"win32"`.
 *
 * `SIGWINCH` is a POSIX signal with no Windows equivalent: `process.kill`
 * rejects it there outright (`ERR_UNKNOWN_SIGNAL`). `ptyService.ts`'s
 * `PtySession.resize` hand-delivers `SIGWINCH` after every `term.resize()`
 * because a Node child otherwise never notices the new size (this module's
 * sibling `ptyService.ts`'s finding 1) — but that whole workaround is
 * POSIX-specific. Windows' ConPTY backing resizes the console natively,
 * so there is nothing to hand-deliver; sending it anyway would only throw
 * on every single resize and fill the log with a warning the user can do
 * nothing about.
 *
 * Separate from {@link supportsBunTerminal} on purpose: that answers "can
 * this host allocate a pty at all", this answers "does the pty need the
 * SIGWINCH workaround" — since Bun 1.3.14 a Windows host answers `true`
 * to the first and `false` to the second.
 */
export function deliversSigwinch(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Whether `platform` (default: the real `process.platform`) running
 * `bunVersion` (default: the real `Bun.version`) supports the native pty
 * primitive this feature is built on (Issue #98's "Bun.Terminal is
 * POSIX-only" finding, now version-qualified — this module's TSDoc).
 *
 * - Every non-`"win32"` `NodeJS.Platform` value (`"linux"`, `"darwin"`,
 *   and the rest) is `true` regardless of `bunVersion` — `Bun.Terminal`'s
 *   POSIX support predates all of this, so the version is irrelevant
 *   there.
 * - `"win32"` is `true` iff `bunVersion` parses to `>= 1.3.14` ({@link
 *   MIN_WINDOWS_BUN_VERSION}, the release that added ConPTY-backed
 *   support). A `bunVersion` that does not parse to a leading
 *   `major.minor.patch` at all is treated as `false` on `"win32"` (fail
 *   closed — an unparseable version is never assumed new enough) but
 *   would still be `true` on any other platform (the version is
 *   irrelevant there, so there is nothing to fail closed about).
 */
export function supportsBunTerminal(
  platform: NodeJS.Platform = process.platform,
  bunVersion: string = Bun.version,
): boolean {
  if (platform !== "win32") return true;
  const parsed = parseLeadingVersion(bunVersion);
  if (!parsed) return false;
  return isAtLeast(parsed, MIN_WINDOWS_BUN_VERSION);
}
