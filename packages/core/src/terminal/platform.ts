/**
 * The one platform gate for the integrated terminal (Issue #98): `Bun.
 * Terminal` — the native pty primitive `ptyService.ts` wraps — is
 * POSIX-only (Linux, macOS). tecode ships a `bun-windows-x64` binary
 * (`scripts/release.ts`'s `RELEASE_TARGETS`), so every module in this
 * `terminal/` domain that would otherwise construct a `Bun.Terminal` MUST
 * check {@link isPosixPlatform} first rather than branching on `process.
 * platform` itself — confining the one OS check to a single place, the
 * same "confined entirely to this module" discipline `host/paths.ts` uses
 * for its own OS branch.
 *
 * **Injectable, unlike `paths.ts`**: `paths.ts`'s tests override the real
 * `process.platform` global (via `Object.defineProperty`) for the
 * duration of each test. This module instead takes `platform` as a plain
 * parameter, defaulting to `process.platform` — a caller (`ptyService.
 * ts`'s `createTerminalService`) threads its own `deps.platform` straight
 * through, so a test can exercise the Windows-degradation path with a
 * literal `"win32"` argument with no global mutation, and no risk of a
 * forgotten `afterEach` restore leaking `process.platform` into an
 * unrelated test.
 */

/**
 * Whether `platform` (default: the real `process.platform`) supports the
 * native pty primitive this feature is built on (Issue #98's "Bun.
 * Terminal is POSIX-only" finding). Every non-`"win32"` `NodeJS.Platform`
 * value (`"linux"`, `"darwin"`, and the rest) is treated as POSIX —
 * `Bun.Terminal`'s own restriction is specifically "not Windows", not an
 * allowlist of specific POSIX kernels.
 */
export function isPosixPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}
