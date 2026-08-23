/**
 * `GitRunner` — the injectable seam over the real `git` CLI (Task 3.3, Req
 * 11.2; design.md §13: "if `git` CLI exists (checked once with
 * `Bun.spawn(["git","--version"])`), visibility uses `git check-ignore
 * --stdin` batched per directory"). `ignore.ts` is the sole consumer:
 * detects whether `git` is usable at all ({@link GitRunner.isAvailable},
 * cached — `git --version` runs at most once per {@link GitRunner}
 * instance) and, when it is, batches every directory's candidate entries
 * into one `git check-ignore --stdin` call ({@link GitRunner.checkIgnore})
 * rather than spawning a process per entry.
 *
 * **Why a real filesystem PATH, not a `Uri`, and why that's allowed here**:
 * `packages/builtin/**`'s usual "never reach a real filesystem directly"
 * discipline (`walkFiles.ts`'s TSDoc) is about FILE I/O — reading/writing
 * bytes through `node:fs`, which the `tecode.workspace.fs` API exists
 * specifically to mediate. Running `git` as a subprocess is a different
 * kind of operation entirely (no file content is read or written by this
 * module), and `@tecode/api` exposes no "run a subprocess" namespace to
 * route it through — {@link createBunGitRunner} is that seam's one
 * necessary exception, exactly like `walkFiles.ts`'s own use of the global
 * `URL` constructor for the one path-join it needs. Converting a `file://`
 * `Uri` to a real path for `git`'s `cwd`/stdin arguments uses `node:url`'s
 * `fileURLToPath` directly — a pure string transform, not filesystem I/O —
 * rather than duplicating `@tecode/core`'s `buffer/uri.ts` (off-limits by
 * the layering rule) or reaching for `node:fs`.
 *
 * **ESLint layering** (verified against this repo's `eslint.config.mjs`):
 * the rule blocks only `import` (static or dynamic) of `@tecode/core` —
 * `Bun.spawn` (a global, no import at all) and `node:url` (a Node/Bun
 * builtin, not `@tecode/core`) are both unrestricted, so this default
 * implementation lives directly in `packages/builtin/shared/` rather than
 * needing to be pushed into `@tecode/core` and injected from there.
 */

import { fileURLToPath } from "node:url";
import type { Uri } from "@tecode/api";

/** Batches `git check-ignore` for one directory's worth of candidate
 * entries at a time (design.md §13's "batched per directory") — the seam
 * `ignore.ts` depends on, injectable so tests can stub it either way
 * ("git present" / "git absent → glob fallback", this task's completion
 * requirement) without spawning a real process. */
export interface GitRunner {
  /**
   * Whether the `git` CLI is usable at all — `git --version` exits `0`.
   * Checked at most ONCE per {@link GitRunner} instance (design.md §13);
   * every subsequent call resolves from the cached result. Never rejects:
   * a spawn failure (git not installed, `PATH` issue, anything else) is
   * treated as "unavailable", the same "degrade gracefully" contract
   * every other host-boundary check in this codebase follows.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Run `git check-ignore --stdin` once for every path in `absolutePaths`
   * (design.md §13's "batched per directory" — one call per directory
   * being filtered, not one per entry), with `cwd` anchoring the
   * invocation inside the repository (any directory inside the repo
   * works; `git` resolves the repository root itself). Returns the SUBSET
   * of `absolutePaths` (by exact string) that `git` reports as ignored —
   * `git check-ignore --stdin` echoes back a matched path in EXACTLY the
   * form it was given on stdin, so absolute paths in yield absolute paths
   * out, making an exact-string `Set` lookup safe. Never rejects: any
   * failure (git disappears mid-session, a non-repository `cwd`, anything
   * else) resolves to an empty set — "nothing is reported ignored by git"
   * — rather than throwing, so a transient git failure degrades to
   * showing everything rather than crashing the caller.
   */
  checkIgnore(cwd: string, absolutePaths: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Convert a `file://...` {@link Uri} to a real filesystem path for
 * {@link GitRunner}'s `cwd`/path arguments (this module's TSDoc's "Why a
 * real filesystem PATH"). Never throws: an unparseable `Uri` (should not
 * happen for anything `workspace.fs` itself handed back) falls back to the
 * raw string — `git` simply reports it as not ignored rather than this
 * module crashing over it. */
export function uriToGitPath(uri: Uri): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * The real {@link GitRunner}, over `Bun.spawn` (design.md §13's own
 * `Bun.spawn(["git","--version"])`). The default implementation `ignore.ts`
 * uses when no `GitRunner` is injected.
 */
export function createBunGitRunner(): GitRunner {
  let cachedAvailable: Promise<boolean> | undefined;

  async function checkVersion(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  function isAvailable(): Promise<boolean> {
    if (!cachedAvailable) cachedAvailable = checkVersion();
    return cachedAvailable;
  }

  async function checkIgnore(cwd: string, absolutePaths: readonly string[]): Promise<ReadonlySet<string>> {
    if (absolutePaths.length === 0) return new Set();
    try {
      const proc = Bun.spawn(["git", "check-ignore", "--stdin"], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdin = proc.stdin;
      stdin.write(`${absolutePaths.join("\n")}\n`);
      stdin.end();
      const output = await new Response(proc.stdout).text();
      // `git check-ignore --stdin` exits 1 when NONE of the inputs are
      // ignored, and >1 on a genuine error — neither is a reason to
      // discard whatever stdout it already produced (exit 1 with empty
      // stdout is the common, entirely expected "nothing ignored" case).
      await proc.exited;
      const matched = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return new Set(matched);
    } catch {
      return new Set();
    }
  }

  return { isAvailable, checkIgnore };
}
