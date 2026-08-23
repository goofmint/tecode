/**
 * Argv parsing and file/directory resolution for the CLI's startup
 * sequence (Req 12.1; design.md §3, §17: "parse argv" is the sync phase's
 * first step; tasks.md's Task 1.15 "Argv parsing (file/directory)").
 * `--version` is handled by `main.ts` itself, before this module is even
 * reached (it must not touch the filesystem or build any services).
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

/**
 * Resolve the CLI's one positional argument (CodeRabbit's Phase 1 plan): a
 * directory becomes `workspaceRoot` with no initial document; a file's
 * parent directory becomes `workspaceRoot` and the file itself is opened
 * in the deferred phase; no argument at all defaults to `cwd`. `argv` here
 * is expected to already have flags like `--version` handled/stripped by
 * the caller — this function only ever looks for the first token that
 * does not start with `-`.
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
  const positional = argv.find((arg) => !arg.startsWith("-"));
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
