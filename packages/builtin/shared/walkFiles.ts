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
 * never has to convert a URI to a filesystem path at all.
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
 */

import type { DirEntry, FileType, Uri } from "@tecode/api";
import { createDefaultIgnorer, type Ignorer } from "./ignore";

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
  /** Defaults to {@link createDefaultIgnorer}'s interim stub (`ignore.ts`'s
   * TSDoc) when omitted. */
  ignore?: Ignorer;
}

/** Join a single path segment `name` onto directory `dirUri` (this
 * module's TSDoc). `dirUri` need not already end in `/` — one is added if
 * missing. `name` is percent-encoded so a literal `#`/`?`/`%`/etc. in a
 * real filename round-trips as one path segment rather than being parsed
 * as a fragment/query/escape by `URL`. */
function joinChildUri(dirUri: Uri, name: string): Uri {
  const base = dirUri.endsWith("/") ? dirUri : `${dirUri}/`;
  return new URL(encodeURIComponent(name), base).href;
}

const FILE_TYPE: FileType = "file";
const DIRECTORY_TYPE: FileType = "directory";

/**
 * Recursively walk `rootUri` (this module's TSDoc), returning every
 * non-ignored file found, sorted deterministically. Never throws — an
 * unreadable directory is skipped (this module's TSDoc's "Failure
 * handling").
 */
export async function walkFiles(rootUri: Uri, deps: WalkFilesDeps): Promise<WalkedFile[]> {
  const ignore = deps.ignore ?? createDefaultIgnorer();
  const results: WalkedFile[] = [];

  async function walk(dirUri: Uri, relativePrefix: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await deps.readdir(dirUri);
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const isDirectory = entry.type === DIRECTORY_TYPE;
      if (ignore(entry.name, isDirectory)) continue;

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
  return results;
}
