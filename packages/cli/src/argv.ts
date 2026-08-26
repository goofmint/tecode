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

/** Every index in `argv` holding a `--config` flag's value — i.e. the token
 * immediately after each `--config` occurrence (Issue #81 Phase 1). Shared
 * by {@link resolveConfigDirOverride} and {@link resolveStartupTarget} so
 * both agree on exactly which tokens are flag values rather than the
 * positional argument.
 *
 * **Every occurrence, not just the first**: which `--config` *wins* is a
 * separate question from which tokens are values. The override itself takes
 * the first occurrence (see {@link resolveConfigDirOverride}, matching this
 * module's "first token wins" treatment of the positional argument below),
 * but a repeated flag's value must STILL be excluded from the positional
 * scan. Considering only the first occurrence would leave the second value
 * looking like a bare positional, so `tecode --config /a --config /b` would
 * silently open `/b` as the workspace — a different thing entirely from
 * what was asked (CodeRabbit finding on PR #85). */
function findConfigValueIndices(argv: readonly string[]): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const [index, arg] of argv.entries()) {
    if (arg === "--config" && index + 1 < argv.length) indices.add(index + 1);
  }
  return indices;
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
  const flagIndex = argv.indexOf("--config");
  if (flagIndex === -1) return undefined;
  return argv[flagIndex + 1];
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
 * path that does not exist, or can't be `stat`-ed, is reported to `log` as
 * a warning and treated as if no argument had been given (`cwd`) — a
 * typo'd path should degrade to an empty workspace rather than abort
 * startup, the same "continue starting up" spirit Req 2.4 applies to a bad
 * extension.
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
    log.append("warning", {
      message: `Startup path "${resolved}" does not exist or could not be read (${describeError(cause)}); starting with no workspace.`,
      path: resolved,
    });
    return { workspaceRoot: cwd };
  }
}
