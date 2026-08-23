/**
 * The real `.gitignore`-aware visibility helper (Task 3.3, Req 11.2;
 * design.md §13's `explorer` design) that replaces this module's earlier
 * interim stub (Task 3.2's deliberately dumb `createDefaultIgnorer`, kept
 * only in this file's git history now). Shared by `walkFiles.ts` (the
 * command-palette's `ctrl+p` file quick-open) AND the explorer built-in's
 * own directory listings — the exact "one ignore-aware walk the whole
 * codebase shares" this task's issue calls for.
 *
 * **Decision order per directory** (design.md §13): for one `readdir`
 * batch,
 * 1. `showHidden: true` bypasses EVERYTHING below — every entry is
 *    visible, unconditionally (Req 9.5's `explorer.showHidden`).
 * 2. Otherwise, dotfile hiding (any entry whose name starts with `.`) and
 *    a small always-ignored set of version-control/dependency directory
 *    names ({@link ALWAYS_IGNORED_DIR_NAMES} — carried over from Task
 *    3.2's interim stub, since these are noise regardless of what a
 *    project's own `.gitignore` says) are applied first.
 * 3. Whatever survives step 2 is then checked against `.gitignore`
 *    content: batched `git check-ignore --stdin` (`gitRunner.ts`) when the
 *    `git` CLI is available AND the workspace root is actually inside a
 *    git working tree ({@link GitRunner.isRepository}, checked once per
 *    root and cached — `git` installed but the workspace not a repo falls
 *    through to the glob path below exactly like "git unavailable", rather
 *    than silently disabling `.gitignore` filtering the way `checkIgnore`
 *    alone would: it degrades a non-repo `cwd` to an empty "nothing
 *    ignored" set indistinguishable from a real, git-confirmed empty
 *    result), or {@link parseGitignore}'s glob matcher over the WORKSPACE
 *    ROOT's `.gitignore` file otherwise (its own module's TSDoc documents
 *    the "single root file only" simplification the glob path makes — the
 *    git path has no such limitation, since `git check-ignore` itself
 *    resolves the real, full chain of `.gitignore` files).
 *
 * **`readFile`, not a raw path** ({@link IgnoreCheckerDeps.readFile}): the
 * glob fallback needs the root `.gitignore`'s CONTENT, which — per this
 * package's "never reach a real filesystem directly" discipline
 * (`walkFiles.ts`'s TSDoc) — must come through `tecode.workspace.fs.read`'s
 * exact signature, so a caller (the explorer built-in, `walkFiles.ts`'s own
 * default) can pass `api.workspace.fs.read` directly with no adapter, the
 * same pattern `WalkFilesDeps.readdir` already established.
 */

import type { DirEntry, Uri } from "@tecode/api";
import { type GitignoreMatcher, parseGitignore } from "./gitignoreMatcher";
import type { GitRunner } from "./gitRunner";
import { uriToGitPath } from "./gitRunner";

/** Directory names ALWAYS excluded regardless of `.gitignore` content or
 * git availability (this module's TSDoc's "always-ignored set") — carried
 * over unchanged from Task 3.2's interim `createDefaultIgnorer`. Bypassed
 * entirely by `showHidden: true`, same as every other rule here. */
const ALWAYS_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);

/** Dependencies for {@link createIgnoreChecker}. Both optional: an
 * {@link createIgnoreChecker} with neither still applies dotfile hiding and
 * {@link ALWAYS_IGNORED_DIR_NAMES} (this module's steps 1-2), it just never
 * has any `.gitignore` content or `git` to additionally consult (step 3
 * always reports "nothing further ignored"). */
export interface IgnoreCheckerDeps {
  /** Reads a file's bytes — matches `@tecode/api`'s exact `FileSystem.
   * read(uri): Promise<Uint8Array>` signature (this module's TSDoc), used
   * ONLY to load the workspace root's `.gitignore` for the glob fallback
   * (never called when `gitRunner` reports `git` available for a given
   * directory). Omitted: the glob fallback has no `.gitignore` content to
   * apply (equivalent to an empty/absent `.gitignore`). */
  readFile?: (uri: Uri) => Promise<Uint8Array>;
  /** Batched `git check-ignore` (`gitRunner.ts`). Omitted: always uses the
   * glob fallback, as if `git` were unavailable. */
  gitRunner?: GitRunner;
}

/** One `filterEntries` call's worth of context (this module's TSDoc) — one
 * directory's already-`readdir`'d entries, batched together exactly like
 * `git check-ignore --stdin` wants (design.md §13). */
export interface FilterEntriesOptions {
  /** The workspace root — the glob fallback's `.gitignore` is read from
   * here (this module's TSDoc); unused on the git path. */
  rootUri: Uri;
  /** The directory `entries` came from — `git check-ignore`'s `cwd` and
   * the base every entry's absolute path is built from. */
  dirUri: Uri;
  /** `dirUri`'s path relative to `rootUri`, `/`-joined, no leading/trailing
   * slash, `""` for the root itself — used to build each entry's
   * ROOT-RELATIVE path for the glob fallback (this task's plan: "paths
   * normalized root-relative before matching"). Unused on the git path
   * (which works in absolute paths). */
  relativeDir: string;
  entries: readonly DirEntry[];
  /** Req 9.5's `explorer.showHidden` — bypasses EVERYTHING (this module's
   * TSDoc's step 1). Defaults to `false`. Read fresh on every call (not
   * cached), so a caller re-invoking this after the setting changes gets
   * the new behavior immediately with no restart (Task 3.3's "showHidden
   * toggle reflects without restart"). */
  showHidden?: boolean;
}

/** The real ignore-aware visibility helper (this module's TSDoc). */
export interface IgnoreChecker {
  /** Filter one `readdir` batch down to what should actually be visible
   * (this module's TSDoc's 3-step decision order). Preserves `entries`'
   * relative order. Never throws: a `gitRunner`/`readFile` failure
   * degrades to "nothing further ignored" for that call (this module's
   * TSDoc's per-dependency fallback), never an exception out of this
   * method. */
  filterEntries(options: FilterEntriesOptions): Promise<DirEntry[]>;
}

/** Join `.gitignore` onto `rootUri` (mirrors `walkFiles.ts`'s own
 * `joinChildUri`, duplicated locally rather than imported so this module
 * has no dependency on `walkFiles.ts` — the dependency runs the other way,
 * `walkFiles.ts` depends on THIS module). No percent-encoding needed: the
 * literal filename `.gitignore` has no characters `encodeURIComponent`
 * would ever touch. */
function rootGitignoreUri(rootUri: Uri): Uri {
  const base = rootUri.endsWith("/") ? rootUri : `${rootUri}/`;
  return `${base}.gitignore`;
}

/**
 * Build an {@link IgnoreChecker} (Task 3.3, Req 11.2). Neither dependency
 * is required — see {@link IgnoreCheckerDeps}'s TSDoc for what an
 * omitted one degrades to.
 */
export function createIgnoreChecker(deps: IgnoreCheckerDeps = {}): IgnoreChecker {
  // Cached per workspace root actually seen (a single `IgnoreChecker`
  // instance is expected to serve exactly one workspace root for its
  // whole lifetime — `walkFiles.ts`'s one call, or the explorer's one
  // session — but keying by `rootUri` costs nothing and avoids any
  // surprise if that ever changes). Loaded lazily, at most once per root:
  // re-reading the SAME `.gitignore` on every directory visited during one
  // walk/session would be wasteful for no correctness benefit within a
  // single walk; a `.gitignore` edited mid-session is a documented,
  // acceptable MVP limitation (this module's TSDoc does not promise live
  // `.gitignore`-content reloading, only live `showHidden` reloading).
  const gitignoreCache = new Map<string, Promise<GitignoreMatcher>>();

  // Whether `rootUri` is actually inside a git working tree — cached per
  // root exactly like `gitignoreCache` above, and checked only once `git`
  // itself is known to be available. `git` installed but the workspace NOT
  // a repo (this module's TSDoc's code-review fix: previously fell through
  // to `checkIgnore`, which degrades a non-repo `cwd` to an empty set
  // indistinguishable from "nothing ignored" — silently disabling the
  // `.gitignore` glob fallback) now routes to the glob path instead, same
  // as "git unavailable".
  const repositoryCache = new Map<string, Promise<boolean>>();

  async function isRepository(rootPath: string): Promise<boolean> {
    const cached = repositoryCache.get(rootPath);
    if (cached) return cached;
    const checked = (async () => {
      try {
        return await deps.gitRunner!.isRepository(rootPath);
      } catch {
        // Documented never-throw on GitRunner, guarded anyway (matches
        // `isGitAvailable`'s own guard just below).
        return false;
      }
    })();
    repositoryCache.set(rootPath, checked);
    return checked;
  }

  async function loadGitignoreMatcher(rootUri: Uri): Promise<GitignoreMatcher> {
    const cached = gitignoreCache.get(rootUri);
    if (cached) return cached;
    const loaded = (async () => {
      if (!deps.readFile) return parseGitignore("");
      try {
        const bytes = await deps.readFile(rootGitignoreUri(rootUri));
        return parseGitignore(new TextDecoder().decode(bytes));
      } catch {
        // No `.gitignore` file, or unreadable — treat as an empty one
        // (this module's TSDoc's per-dependency fallback).
        return parseGitignore("");
      }
    })();
    gitignoreCache.set(rootUri, loaded);
    return loaded;
  }

  async function isGitAvailable(): Promise<boolean> {
    if (!deps.gitRunner) return false;
    try {
      return await deps.gitRunner.isAvailable();
    } catch {
      // Documented never-throw on GitRunner, guarded anyway (matches this
      // codebase's "guard even a documented never-throw dependency"
      // convention, e.g. `slotRegistry.ts`'s `requestActivation`).
      return false;
    }
  }

  async function filterEntries(options: FilterEntriesOptions): Promise<DirEntry[]> {
    const { rootUri, dirUri, relativeDir, entries, showHidden } = options;
    if (showHidden) return [...entries];

    const candidates = entries.filter((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (entry.type === "directory" && ALWAYS_IGNORED_DIR_NAMES.has(entry.name)) return false;
      return true;
    });
    if (candidates.length === 0) return [];

    const rootPath = uriToGitPath(rootUri).replace(/\/+$/, "");
    if ((await isGitAvailable()) && (await isRepository(rootPath))) {
      // `fileURLToPath` preserves a directory URL's trailing slash (e.g.
      // `"file:///workspace/"` -> `"/workspace/"`) — stripped here so the
      // join below never produces a doubled `//` in front of `entry.name`.
      const dirPath = uriToGitPath(dirUri).replace(/\/+$/, "");
      const absolutePaths = candidates.map((entry) => `${dirPath}/${entry.name}`);
      let ignored: ReadonlySet<string>;
      try {
        ignored = await deps.gitRunner!.checkIgnore(dirPath, absolutePaths);
      } catch {
        ignored = new Set();
      }
      return candidates.filter((_, index) => !ignored.has(absolutePaths[index]!));
    }

    const matcher = await loadGitignoreMatcher(rootUri);
    return candidates.filter((entry) => {
      const relativePath = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      return !matcher.isIgnored(relativePath, entry.type === "directory");
    });
  }

  return { filterEntries };
}
