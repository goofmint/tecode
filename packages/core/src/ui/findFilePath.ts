/**
 * Pure path-input helpers behind `findFileService.ts`'s find-file
 * minibuffer (Issue #164): how a half-typed path string ("~/Code/te",
 * "../packages/", "/etc/host") maps onto "which directory do I list" plus
 * "which prefix am I filtering its entries by", and how a set of candidate
 * names collapses to the single longest prefix Emacs' `minibuffer-complete`
 * would insert.
 *
 * No UI, no filesystem, no service state — every function here is a plain,
 * deterministic computation over strings, unit-testable without a renderer
 * or a real directory (the same "keep pure functions pure" split
 * `viewport.ts` already draws for the editor's own layout math).
 *
 * **Separator policy**: `node:path`'s own `resolve`/`dirname`/`basename`/
 * `join` do all the platform-specific work, and the one separator this
 * module WRITES (the `/` {@link appendTrailingSeparator} adds to a
 * completed directory, so the next Tab lists inside it) is a forward slash
 * — accepted by `node:path` on win32 as well as posix, so a query string
 * stays valid input to {@link splitPathInput} on either platform.
 */

import { basename, dirname, join, resolve } from "node:path";

/** The separator this module appends to a completed directory name — see
 * this module's TSDoc's "Separator policy". */
export const PATH_SEPARATOR = "/";

/** Whether `input` names a DIRECTORY outright rather than a partially-typed
 * entry inside one: a trailing separator (`"packages/"`), or the bare `~`
 * that {@link expandTilde} turns into the home directory (`"~"` — typing it
 * means "the home directory", never "an entry whose name starts with the
 * basename of my home directory"). */
function namesDirectoryOutright(input: string): boolean {
  return input === "~" || input.endsWith("/") || input.endsWith("\\");
}

/**
 * Replace a leading `~` with `home` (Issue #164's "`~` expansion"): `"~"`
 * becomes `home` itself and `"~/x"` becomes `home`'s `x`. Any other input —
 * including `"~user"`, which names ANOTHER user's home directory on some
 * shells and is deliberately NOT interpreted here — is returned unchanged.
 */
export function expandTilde(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

/**
 * The absolute path `input` names, resolved against `baseDir` (Issue #164's
 * "`..`, absolute paths"): `~` is expanded first (see
 * {@link expandTilde}), then `node:path`'s `resolve` handles the absolute/
 * relative/`..` cases in one step. An empty `input` resolves to `baseDir`
 * itself.
 *
 * Note `resolve` normalizes away a trailing separator — the caller that
 * needs to know whether the user typed one asks {@link splitPathInput}
 * instead, which keeps that distinction.
 */
export function resolvePathInput(input: string, baseDir: string, home: string): string {
  return resolve(baseDir, expandTilde(input, home));
}

/** {@link splitPathInput}'s result. */
export interface PathInputSplit {
  /** The absolute directory whose entries are the completion candidates. */
  dirPath: string;
  /** The already-typed prefix candidates must start with — `""` when
   * `input` named a directory outright (so every entry qualifies). Always
   * the literal tail of the ORIGINAL `input`, so a caller can splice a
   * completion back onto the query by replacing exactly its last
   * `partial.length` characters. */
  partial: string;
}

/**
 * Split a half-typed path `input` into "the directory to list" and "the
 * prefix to filter by" (Issue #164's Phase 2 helper), resolving both
 * against `baseDir` with `~` expanded against `home`.
 *
 * - `"packages/"` → the resolved `packages` directory, `partial: ""`.
 * - `"packages/co"` → the resolved `packages` directory, `partial: "co"`.
 * - `""` → `baseDir`, `partial: ""`.
 * - `"~"` → `home`, `partial: ""` (this module's
 *   {@link namesDirectoryOutright}).
 */
export function splitPathInput(input: string, baseDir: string, home: string): PathInputSplit {
  const expanded = expandTilde(input, home);
  if (input.length === 0 || namesDirectoryOutright(input)) {
    return { dirPath: resolve(baseDir, expanded), partial: "" };
  }
  const parent = dirname(expanded);
  // `dirname` of a bare name is `"."`, which `resolve` folds into
  // `baseDir`; an absolute `expanded` ignores `baseDir` entirely.
  return { dirPath: resolve(baseDir, parent), partial: basename(expanded) };
}

/**
 * Append {@link PATH_SEPARATOR} to `input` unless it already ends in a
 * separator — what makes a completed DIRECTORY name immediately listable by
 * the next Tab (Emacs' own "directory: insert the `/` and keep going").
 */
export function appendTrailingSeparator(input: string): string {
  if (input.endsWith("/") || input.endsWith("\\")) return input;
  return `${input}${PATH_SEPARATOR}`;
}

/**
 * The longest string every entry of `values` starts with — Emacs'
 * `minibuffer-complete` "several candidates: insert their common prefix"
 * step. `""` for an empty `values` (nothing in common) and for any set
 * whose members disagree on their very first character; the single member
 * itself for a one-element `values`.
 *
 * Compares by UTF-16 code unit, matching `String.prototype.startsWith`
 * (the same comparison the caller then filters candidates with), so a
 * prefix returned here is always a real prefix of every input.
 */
export function longestCommonPrefix(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) return "";
  let end = first.length;
  for (const value of values) {
    let index = 0;
    while (index < end && index < value.length && value[index] === first[index]) index += 1;
    end = index;
    if (end === 0) return "";
  }
  return first.slice(0, end);
}

/**
 * Splice `completion` (a full entry name, possibly with a trailing
 * separator) onto `query` in place of its already-typed `partial` tail —
 * the one write the completion step makes to the query string. Preserves
 * whatever form the user typed for the DIRECTORY part (`~/`, `../`, an
 * absolute path), since only the last `partial.length` characters are
 * replaced.
 */
export function spliceCompletion(query: string, partial: string, completion: string): string {
  return `${query.slice(0, query.length - partial.length)}${completion}`;
}
