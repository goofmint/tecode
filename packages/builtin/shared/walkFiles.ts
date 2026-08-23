/**
 * A recursive workspace file walk over an injected readdir-like function
 * (Task 3.2, Req 11.3; design.md §13: "`ctrl+p` walks the workspace...
 * into an in-memory file list"), for file quick-open's candidate list.
 *
 * **No direct `node:fs`** (this task's plan): `packages/builtin/**` may
 * never reach a real filesystem directly — the whole point of the
 * `tecode.*` API is that extensions (built-in or third-party) only ever
 * see the workspace through it. {@link WalkFilesDeps.readdir} is typed to
 * match `@tecode/api`'s `FileSystem.readdir(uri): Promise<DirEntry[]>`
 * exactly (`namespaces.ts`), so the command-palette built-in's `index.ts`
 * passes `api.workspace.fs.readdir` directly with no adapter — see that
 * module's TSDoc for the call site.
 *
 * **URIs, not paths**: `@tecode/api`'s `Uri` is a plain `file://...`
 * string (`primitives.ts`) with no join/resolve helper exposed to
 * extensions (that conversion lives in `@tecode/core`'s `buffer/uri.ts`,
 * off-limits here by the same layering rule). {@link joinChildUri} does the
 * one join operation this module needs — a child name onto a directory
 * URI — using the platform-global `URL` constructor rather than
 * `node:url`'s `pathToFileURL`/`fileURLToPath` round-trip, so this module
 * never has to convert a URI to a filesystem path at all. Exported (Task
 * 3.3) so the explorer built-in reuses the exact same join logic for its
 * own create/rename URI-building rather than duplicating it.
 *
 * **Deterministic ordering** (this task's plan): each directory's entries
 * are sorted by name before recursing/collecting, so two walks over the
 * same (unchanging) directory tree always produce the same result list in
 * the same order — what makes this module's own tests, and file
 * quick-open's "pre-rank with `fuzzyMatch`" step, reproducible.
 *
 * **Failure handling**: a directory that fails to read (permissions, a
 * race with a delete, a symlink loop the host's `readdir` chokes on) is
 * skipped silently rather than aborting the whole walk — matches this
 * codebase's "a partial workspace scan degrades gracefully" convention
 * elsewhere (e.g. `@tecode/core`'s discovery skipping one bad extension
 * rather than failing startup). Symlinks and any file type other than
 * `"file"`/`"directory"` are skipped entirely (not walked, not listed) —
 * safely conservative for the MVP; Task 3.3's real explorer may need finer
 * symlink handling later.
 *
 * **Bounded scans** (code review finding, "bounded workspace scan"):
 * {@link WalkFilesDeps.maxResults}, when set, stops the traversal entirely
 * the moment {@link WalkedFile}s collected reach the cap — not just a
 * truncate-after-the-fact slice of an already-fully-walked tree. A directory
 * is only ever `readdir`'d if the cap has not yet been hit at the moment its
 * own `walk()` call begins, so a huge subtree sitting past the cap (a giant
 * `dist/` full of generated files, say) never has a single one of its
 * descendant directories read. {@link WalkFilesResult.truncated} reports
 * whether the cap actually cut the walk short, so a caller (file quick-open)
 * can surface that to the user instead of silently showing a partial list
 * with no indication it's incomplete. Omitting `maxResults` walks the whole
 * tree exactly as before (unchanged behavior).
 *
 * **Real `.gitignore`-aware ignore logic (Task 3.3, Req 11.2)**: {@link
 * WalkFilesDeps.ignore} now takes `ignore.ts`'s real {@link IgnoreChecker}
 * (batched per directory, git-or-glob, `showHidden`-bypassable) rather than
 * Task 3.2's interim per-entry `Ignorer` stub — the exact "one ignore-aware
 * walk `ctrl+p` and the explorer both use" this task's issue calls for.
 * Each directory's sorted entries are handed to {@link IgnoreChecker.
 * filterEntries} as one batch (matching `git check-ignore --stdin`'s own
 * batched-per-directory design, `gitRunner.ts`), and only the SURVIVING
 * entries are recursed into/collected — an ignored directory is never
 * `readdir`'d at all, the same "don't even look inside an ignored
 * directory" behavior the interim stub already had.
 */

import type { DirEntry, FileType, Uri } from "@tecode/api";
import { createIgnoreChecker, type IgnoreChecker } from "./ignore";

/** One file found by {@link walkFiles}. */
export interface WalkedFile {
  /** The file's absolute `file://...` URI — pass this straight to
   * `workbench.action.files.openUri` (`@tecode/core`'s
   * `ui/openFileCommand.ts`) to open it. */
  uri: Uri;
  /** The file's path relative to the walk's root, `/`-joined regardless of
   * host OS (this module builds it directly from entry names, never from
   * an OS path separator) — quick-open's display label. */
  relativePath: string;
}

/** The narrow slice of `@tecode/api`'s `FileSystem` this module needs —
 * matches `readdir`'s exact signature so `api.workspace.fs.readdir` can be
 * passed directly (this module's TSDoc). */
export interface WalkFilesDeps {
  readdir(uri: Uri): Promise<DirEntry[]>;
  /** The real ignore-aware visibility helper (Task 3.3, `ignore.ts`'s
   * TSDoc) — defaults to {@link createIgnoreChecker}'s no-dependencies
   * form (dotfile hiding + the always-ignored VCS/dependency directory
   * names, no `.gitignore`/`git` consultation) when omitted. */
  ignore?: IgnoreChecker;
  /** Req 9.5's `explorer.showHidden` — bypasses {@link ignore} entirely
   * for this walk (`ignore.ts`'s TSDoc). Defaults to `false`. */
  showHidden?: boolean;
  /** Stop collecting once this many files have been found, abandoning the
   * traversal outright rather than walking everything and truncating after
   * (this module's TSDoc's "Bounded scans"). Omit for an unbounded walk
   * (unchanged behavior). */
  maxResults?: number;
}

/** {@link walkFiles}'s return value. */
export interface WalkFilesResult {
  /** Every non-ignored file found, sorted deterministically — capped at
   * {@link WalkFilesDeps.maxResults} when set. */
  files: WalkedFile[];
  /** `true` when {@link WalkFilesDeps.maxResults} was set and cut the walk
   * short before the whole tree was visited; `false` when the walk ran to
   * completion (including whenever `maxResults` is omitted). */
  truncated: boolean;
}

/** Join a single path segment `name` onto directory `dirUri` (this
 * module's TSDoc). `dirUri` need not already end in `/` — one is added if
 * missing. `name` is percent-encoded so a literal `#`/`?`/`%`/etc. in a
 * real filename round-trips as one path segment rather than being parsed
 * as a fragment/query/escape by `URL`. */
export function joinChildUri(dirUri: Uri, name: string): Uri {
  const base = dirUri.endsWith("/") ? dirUri : `${dirUri}/`;
  return new URL(encodeURIComponent(name), base).href;
}

const FILE_TYPE: FileType = "file";
const DIRECTORY_TYPE: FileType = "directory";

/**
 * Recursively walk `rootUri` (this module's TSDoc), returning every
 * non-ignored file found, sorted deterministically. Never throws — an
 * unreadable directory is skipped (this module's TSDoc's "Failure
 * handling"). Stops early once {@link WalkFilesDeps.maxResults} files have
 * been collected (this module's TSDoc's "Bounded scans"), reporting that in
 * {@link WalkFilesResult.truncated}.
 */
export async function walkFiles(rootUri: Uri, deps: WalkFilesDeps): Promise<WalkFilesResult> {
  const ignore = deps.ignore ?? createIgnoreChecker();
  const { maxResults, showHidden } = deps;
  const results: WalkedFile[] = [];
  let truncated = false;

  function capReached(): boolean {
    return maxResults !== undefined && results.length >= maxResults;
  }

  async function walk(dirUri: Uri, relativePrefix: string): Promise<void> {
    if (capReached()) {
      truncated = true;
      return;
    }

    let entries: DirEntry[];
    try {
      entries = await deps.readdir(dirUri);
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const visible = await ignore.filterEntries({
      rootUri,
      dirUri,
      relativeDir: relativePrefix,
      entries: sorted,
      showHidden,
    });

    for (const entry of visible) {
      if (capReached()) {
        truncated = true;
        return;
      }

      const isDirectory = entry.type === DIRECTORY_TYPE;
      const relativePath = relativePrefix.length > 0 ? `${relativePrefix}/${entry.name}` : entry.name;
      const childUri = joinChildUri(dirUri, entry.name);

      if (isDirectory) {
        await walk(childUri, relativePath);
      } else if (entry.type === FILE_TYPE) {
        results.push({ uri: childUri, relativePath });
      }
      // Symlinks/"unknown" entries: intentionally skipped (this module's
      // TSDoc).
    }
  }

  await walk(rootUri, "");
  return { files: results, truncated };
}
