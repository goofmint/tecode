/**
 * An interim ignore predicate for `walkFiles.ts` (Task 3.2, Req 11.3): file
 * quick-open needs SOME notion of "don't walk into this directory" before
 * offering a real one, but the real `.gitignore`-aware logic — batched
 * `git check-ignore` when the `git` CLI exists, a minimal glob matcher
 * otherwise, plus the `explorer.showHidden` setting — is Task 3.3's job
 * (design.md §13's `explorer` design, tasks.md's Task 3.3), shared with the
 * explorer built-in once it lands.
 *
 * **Deliberately dumb for now** (this task's plan): excludes only the
 * handful of directory names that are *always* noise for a source-code
 * quick-open regardless of any `.gitignore` content — version-control
 * metadata and the one dependency-manager directory this monorepo itself
 * uses. Nothing else is excluded; a real `dist`/`build`/`.env` etc. is only
 * ever filtered once Task 3.3's real ignore logic replaces this.
 *
 * **Swappable by design**: {@link Ignorer} is a plain function type, and
 * `walkFiles`'s `deps.ignore` is optional — passing a different
 * implementation (e.g. Task 3.3's real one) requires no change to
 * `walkFiles.ts` itself, just a different value at the call site.
 */

/** Whether a directory entry named `name` should be skipped entirely
 * (never descended into, never listed) — checked once per entry by
 * `walkFiles.ts`. `isDirectory` is provided so a future real
 * implementation (Task 3.3) can apply directory-only or file-and-directory
 * rules differently; this interim default only ever ignores directories. */
export type Ignorer = (name: string, isDirectory: boolean) => boolean;

/** Directory names this interim ignorer always excludes (this module's
 * TSDoc) — version-control metadata directories and `node_modules`. */
const DEFAULT_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);

/**
 * Build the interim default {@link Ignorer} (this module's TSDoc):
 * excludes {@link DEFAULT_IGNORED_DIR_NAMES} directories, includes
 * everything else.
 */
export function createDefaultIgnorer(): Ignorer {
  return (name, isDirectory) => isDirectory && DEFAULT_IGNORED_DIR_NAMES.has(name);
}
