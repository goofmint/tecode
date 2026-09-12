/**
 * Argv parsing and file/directory resolution for the CLI's startup
 * sequence (Req 12.1; design.md §3, §17: "parse argv" is the sync phase's
 * first step; tasks.md's Task 1.15 "Argv parsing (file/directory)").
 * `--version` is handled by `main.ts` itself, before this module is even
 * reached (it must not touch the filesystem or build any services).
 * `--config <dir>` (Req 9.6, Issue #81 Phase 1) is parsed here too, by
 * {@link resolveConfigDirOverride} — a separate, synchronous, pure helper
 * (it does no I/O and never throws) that `main.ts` calls alongside
 * {@link resolveStartupTarget}.
 */

import { stat as nodeStat } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { HostLog } from "@tecode/core";

/** Where {@link resolveStartupTarget} landed for one CLI invocation. */
export interface StartupTarget {
  /** The directory `ConfigService`/`discover()`/`tecode.workspace.rootUri`
   * treat as the open workspace. */
  workspaceRoot: string;
  /** Absolute path to open once the deferred phase's document manager is
   * ready (design.md §3's "open the file/directory from argv" step) —
   * `undefined` for a directory argument or a no-argument launch. */
  initialFilePath?: string;
}

/** The narrow filesystem seam {@link resolveStartupTarget} needs —
 * exists as an injectable seam (matches every `core` service's
 * `*Fs`-suffixed dependency convention) so tests can simulate a path that
 * exists/doesn't without depending on real disk state. Defaults to
 * `node:fs/promises`. */
export interface ArgvResolutionFs {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

function createNodeArgvFs(): ArgvResolutionFs {
  return {
    stat: async (path) => {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `core`'s `describeError` convention). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`) from a caught unknown,
 * or `undefined` when it carries none. Duplicated per-module rather than
 * imported (matches `@tecode/core`'s own convention of a private
 * `errorCode` in each module that needs one — e.g.
 * `buffer/documentManager.ts`'s, `config/service.ts`'s — instead of a
 * shared export; this module is `cli`, which may import `@tecode/core`,
 * but this helper is a two-line leaf with no state, so duplicating it
 * avoids a public export whose only purpose would be this one call). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Decide whether a non-existent `resolved` path (Req 5.6, Issue #88)
 * should open as a brand-new, empty in-memory document rather than
 * degrade to "no workspace" — called from {@link resolveStartupTarget}'s
 * catch block only when the initial `stat` failed with `ENOENT`. Two
 * guards gate this, both chosen over the alternative of opening
 * unconditionally and deferring to a save-time error (which is what
 * `buffer/documentManager.ts`'s `openDocument` does instead, for its own,
 * different reasons — see that function's TSDoc):
 *
 * - **Directory-shaped positional**: `raw` (the ORIGINAL argv token, not
 *   `resolved`) ending in `/` or `\` unambiguously means the user meant a
 *   directory — `path.resolve` normalizes away a trailing separator, so
 *   by the time `resolved` exists that signal is already gone, which is
 *   why this checks `raw`. A file can never be opened at a path spelled
 *   with a trailing separator, so `tecode newdir/` on a non-existent
 *   `newdir` degrades to the ordinary "does not exist" warning rather
 *   than silently opening `newdir` (no trailing slash) as a file.
 * - **Missing parent directory** (`a/b/c.txt` where `a/b` doesn't exist):
 *   opening this as a new file would let a typo'd deep path silently
 *   open an empty editor with nothing on screen to say anything is
 *   wrong — discoverable only later, when a save fails for a reason
 *   (`ENOENT` on the temp-file write, inside a directory that was never
 *   the one the user actually mistyped) that no longer even names the
 *   original mistake. A startup warning that names the exact path right
 *   away is a far better first signal for a CLI entry point, so this
 *   only treats `resolved` as a new file when `dirname(resolved)` both
 *   exists and is itself a directory.
 *
 * Returns `undefined` (caller falls through to its existing warning) when
 * either guard fails, or the parent's own `stat` call fails for any
 * reason.
 */
async function tryResolveAsNewFile(
  fs: ArgvResolutionFs,
  raw: string,
  resolved: string,
): Promise<StartupTarget | undefined> {
  // `/` is a separator everywhere. `\` is one only on Windows: on POSIX it
  // is an ordinary filename character, so `tecode 'draft\'` names a
  // perfectly valid file that does not exist yet, and rejecting it here
  // would warn-and-fall-back on a path the user could legitimately create
  // (CodeRabbit finding on PR #89 — `path.resolve("/tmp", "draft\\")` gives
  // `/tmp/draft\`, whose `dirname` is `/tmp`, not a directory named
  // `draft`).
  if (raw.endsWith("/")) return undefined;
  if (process.platform === "win32" && raw.endsWith("\\")) return undefined;
  const parent = dirname(resolved);
  try {
    const parentStats = await fs.stat(parent);
    if (!parentStats.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return { workspaceRoot: parent, initialFilePath: resolved };
}

/** Every flag whose immediately-following token is a value, never the
 * positional argument (Issue #81 Phase 1's `--config`, extended by Issue
 * #149's `--settings`/`--keybindings`/`--theme`) — shared by
 * {@link findConfigValueIndices} so adding a new single-value flag never
 * requires touching {@link resolveStartupTarget} itself. */
const VALUE_FLAGS: readonly string[] = ["--config", "--settings", "--keybindings", "--theme"];

/** Every index in `argv` holding one of {@link VALUE_FLAGS}' values — i.e.
 * the token immediately after each such flag's occurrence. Shared by
 * {@link resolveConfigDirOverride}/{@link resolveSettingsFileOverride}/
 * {@link resolveKeybindingsFileOverride}/{@link resolveThemeFileOverride} and
 * {@link resolveStartupTarget} so both agree on exactly which tokens are
 * flag values rather than the positional argument.
 *
 * **Every occurrence, not just the first**: which occurrence *wins* is a
 * separate question from which tokens are values. Each override itself takes
 * the first occurrence (see {@link resolveConfigDirOverride} et al., matching
 * this module's "first token wins" treatment of the positional argument
 * below), but a repeated flag's value must STILL be excluded from the
 * positional scan. Considering only the first occurrence would leave the
 * second value looking like a bare positional, so `tecode --config /a
 * --config /b` would silently open `/b` as the workspace — a different thing
 * entirely from what was asked (CodeRabbit finding on PR #85). */
function findConfigValueIndices(argv: readonly string[]): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const [index, arg] of argv.entries()) {
    if (VALUE_FLAGS.includes(arg) && index + 1 < argv.length) indices.add(index + 1);
  }
  return indices;
}

/**
 * Resolve one single-value flag's argument from argv, matching
 * {@link resolveConfigDirOverride}'s exact shape: the token immediately
 * following the first occurrence of `flag`, or `undefined` when `flag` is
 * absent from `argv` entirely, when it is present but is the very last
 * token (no value follows), or when the very next token is itself one of
 * {@link VALUE_FLAGS} (CodeRabbit PR #154 review: without this guard,
 * `tecode --settings --theme theme.json` read `"--theme"` itself as the
 * settings file name, rather than recognizing that `--settings` was given
 * no value at all — a different flag's name is never a plausible value).
 * Never throws — it does no I/O and cannot fail. Shared by
 * {@link resolveSettingsFileOverride}/{@link resolveKeybindingsFileOverride}/
 * {@link resolveThemeFileOverride} (Req 9.7/7.6, Issue #149) so the three
 * new flags stay in lockstep with {@link resolveConfigDirOverride}'s own
 * long-established "degrade to `undefined` rather than throw" behavior —
 * a value genuinely missing (the flag is simply the last token, with
 * nothing at all following it) still degrades to `undefined` here,
 * exactly as `resolveConfigDirOverride(["--config"])` has always done;
 * `main.ts`'s `runTecode` already treats an explicitly-given-but-unreadable
 * file as a fatal startup error, but a flag with no value at all is
 * indistinguishable from the flag never being passed in the first place,
 * so it degrades the same way `--config` always has, rather than this
 * pure, no-I/O module taking on a new throwing contract none of its other
 * functions have.
 */
function resolveFlagValue(argv: readonly string[], flag: string): string | undefined {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex === -1) return undefined;
  const value = argv[flagIndex + 1];
  if (value !== undefined && VALUE_FLAGS.includes(value)) return undefined;
  return value;
}

/**
 * Resolve `--config <dir>`'s value from argv (Req 9.6, design.md §11's
 * `--config` note; Issue #81 Phase 1). Returns the token immediately
 * following the first `--config` flag, or `undefined` when `--config` is
 * absent from `argv` entirely, or when it is present but is the very last
 * token (no value follows). Never throws (matches this module's
 * never-throwing, degrade-to-`undefined` policy) — it does no I/O and
 * cannot fail. Does not validate that the returned string names a real,
 * readable directory; that check happens where the value is actually used
 * (`@tecode/core`'s `ConfigService`, which degrades a missing/unreadable
 * settings or keybindings file to an empty layer exactly as it does for
 * the un-overridden home-directory default).
 *
 * `--version` is still handled by `main.ts` itself before this module (or
 * `resolveStartupTarget`) ever sees argv (this module's top-of-file
 * TSDoc) — nothing here needs to special-case it.
 */
export function resolveConfigDirOverride(argv: readonly string[]): string | undefined {
  return resolveFlagValue(argv, "--config");
}

/**
 * Resolve `--settings <file>`'s value from argv (Req 9.7, Issue #149).
 * Same shape and contract as {@link resolveConfigDirOverride}: the token
 * immediately following the first `--settings` flag, or `undefined` when
 * absent or when `--settings` is the very last token. Never throws — no
 * I/O, and does not validate that the returned string names a real,
 * readable file; unlike `--config`'s tolerant "missing file is an empty
 * layer" policy, an explicitly-named `--settings <file>` that cannot be
 * read is treated as a fatal startup error where this value is actually
 * used (`cli/main.ts`'s `runTecode`) — a typo in an explicit flag should
 * never be silently ignored.
 */
export function resolveSettingsFileOverride(argv: readonly string[]): string | undefined {
  return resolveFlagValue(argv, "--settings");
}

/**
 * Resolve `--keybindings <file>`'s value from argv (Req 9.7, Issue #149).
 * Same shape, contract, and "explicit file must exist" policy as
 * {@link resolveSettingsFileOverride} — see that function's TSDoc.
 */
export function resolveKeybindingsFileOverride(argv: readonly string[]): string | undefined {
  return resolveFlagValue(argv, "--keybindings");
}

/**
 * Resolve `--theme <file>`'s value from argv (Req 7.6, Issue #149): a
 * theme JSON file to load and activate directly, independent of the
 * `workbench.colorTheme` setting. Same shape, contract, and "explicit file
 * must exist" policy as {@link resolveSettingsFileOverride} — see that
 * function's TSDoc.
 */
export function resolveThemeFileOverride(argv: readonly string[]): string | undefined {
  return resolveFlagValue(argv, "--theme");
}

/**
 * Resolve the CLI's one positional argument (CodeRabbit's Phase 1 plan): a
 * directory becomes `workspaceRoot` with no initial document; a file's
 * parent directory becomes `workspaceRoot` and the file itself is opened
 * in the deferred phase; no argument at all defaults to `cwd`. `argv` here
 * is expected to already have flags like `--version` handled/stripped by
 * the caller — this function only ever looks for the first token that
 * does not start with `-`.
 *
 * **`--config <dir>`'s value is never mistaken for the positional
 * argument** (Req 9.6, Issue #81 Phase 1): `--config`'s own value token
 * (whatever immediately follows it, even a bare directory name with no
 * leading `-`) is skipped when scanning for the positional, using the same
 * {@link findConfigValueIndices} lookup {@link resolveConfigDirOverride}
 * uses — so `tecode --config /tmp/cfg ./src` still opens `./src`, and
 * `tecode --config /tmp/cfg` (no further token) opens nothing, exactly as
 * if `--config /tmp/cfg` had been omitted. This function does not itself
 * read or act on `--config`'s value — that is `resolveConfigDirOverride`'s
 * job, called separately by `main.ts`.
 *
 * Never throws (matches `core`'s never-throwing service boundaries): a
 * path that can't be `stat`-ed for a reason other than "missing" is
 * reported to `log` as a warning and treated as if no argument had been
 * given (`cwd`) — a bad path should degrade to an empty workspace rather
 * than abort startup, the same "continue starting up" spirit Req 2.4
 * applies to a bad extension.
 *
 * **A path that does not exist (`ENOENT`) opens as a new, empty document
 * instead** (Req 5.6, Issue #88), UNLESS {@link tryResolveAsNewFile}'s two
 * guards say otherwise (a directory-shaped positional, or a missing
 * parent directory) — in either of those cases this still falls through
 * to the warning-and-`cwd` degradation above, exactly as before Issue
 * #88. See {@link tryResolveAsNewFile}'s TSDoc for the full reasoning.
 */
export async function resolveStartupTarget(
  argv: readonly string[],
  cwd: string,
  log: HostLog,
  fs: ArgvResolutionFs = createNodeArgvFs(),
): Promise<StartupTarget> {
  const configValueIndices = findConfigValueIndices(argv);
  const positional = argv.find(
    (arg, index) => !arg.startsWith("-") && !configValueIndices.has(index),
  );
  if (!positional) return { workspaceRoot: cwd };

  const resolved = resolvePath(cwd, positional);
  try {
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) return { workspaceRoot: resolved };
    return { workspaceRoot: dirname(resolved), initialFilePath: resolved };
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      const asNewFile = await tryResolveAsNewFile(fs, positional, resolved);
      if (asNewFile) return asNewFile;
    }
    log.append("warning", {
      message: `Startup path "${resolved}" does not exist or could not be read (${describeError(cause)}); starting with no workspace.`,
      path: resolved,
    });
    return { workspaceRoot: cwd };
  }
}
