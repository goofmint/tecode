/**
 * A minimal `.gitignore` glob matcher (Task 3.3, Req 11.2; design.md §13's
 * "otherwise a minimal `.gitignore` glob matcher handles the common
 * patterns"): the glob-fallback half of the explorer's `.gitignore`-aware
 * visibility, used whenever the `git` CLI is unavailable ({@link
 * ../gitRunner.ts}'s `GitRunner.isAvailable` reports `false`) — `ignore.ts`
 * is the module that actually picks between this and the git-backed path.
 *
 * **Scope, matching this task's plan**: supports `*` (any run of characters
 * except `/`), `**` (any run of characters, `/` included), `?` is
 * deliberately NOT supported (not asked for by this task's plan, and
 * `.gitignore` files overwhelmingly use `*`/`**`, not `?`), `!` negation
 * (a later matching pattern overrides an earlier one, per real `.gitignore`
 * semantics), trailing-`/` directory-only patterns, and anchoring — a
 * pattern containing a `/` anywhere other than a trailing position (i.e. a
 * leading `/`, or a `/` in the middle) is anchored to the root; a pattern
 * with no other `/` matches the basename at ANY depth (equivalent to
 * prefixing it with a leading `**` + `/`), exactly like real `.gitignore`. Character
 * classes (`[abc]`) are not supported — outside this task's stated scope.
 *
 * **Single root `.gitignore` only** (this module's caller, `ignore.ts`'s
 * TSDoc): real `git` respects a whole CHAIN of `.gitignore` files (one per
 * directory, plus global excludes) — this glob fallback only ever sees ONE
 * file's content (the workspace root's `.gitignore`, if any), with every
 * candidate path normalized ROOT-RELATIVE before matching (this task's
 * plan: "paths normalized root-relative before matching"). A documented
 * MVP simplification: covers the overwhelmingly common case (a single
 * top-level `.gitignore`) without emulating git's full nested-file
 * resolution; whenever the real `git` CLI is available, {@link
 * ../gitRunner.ts}'s batched `git check-ignore` is used instead and this
 * limitation does not apply at all.
 */

/** One compiled `.gitignore` pattern (this module's TSDoc). */
interface CompiledPattern {
  /** `true` for a `!`-prefixed pattern — a later match against this
   * pattern UN-ignores a path an earlier pattern ignored. */
  negate: boolean;
  /** `true` for a trailing-`/` pattern — only ever matches a directory. */
  dirOnly: boolean;
  regex: RegExp;
}

/** Escape every regex metacharacter in `segment` EXCEPT the glob
 * wildcards this module itself interprets (`*`, handled by the caller
 * before this ever runs) — used on whatever literal text remains between
 * wildcards. `?` is NOT one of this module's wildcards (this module's
 * TSDoc's "Scope": "`?` is deliberately NOT supported"), so it must be
 * escaped here too — left bare, it compiles to a regex "any one character"
 * quantifier/atom instead of matching a literal `?` (e.g. `foo?.log` would
 * wrongly match `fo.log`). */
function escapeRegexLiteral(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

/**
 * Compile one `.gitignore` GLOB (the pattern text with `!`/trailing-`/`
 * already stripped by {@link compileGitignoreLine}) into a `RegExp` that
 * matches a root-relative path (this module's TSDoc's "Scope").
 * `anchored` decides whether the compiled regex is anchored to the START
 * of the path (a `/`-containing pattern) or may match starting at any
 * path-segment boundary (a bare basename pattern, effectively `**\/pattern`).
 */
function compileGlobToRegex(pattern: string, anchored: boolean): RegExp {
  // Walk the pattern left to right, translating each `**` / `*` / literal
  // run in turn — simpler and less error-prone than one giant `.replace`
  // chain operating on overlapping wildcard forms.
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      body += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      body += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      body += "[^/]*";
      i += 1;
    } else {
      // Consume the longest literal run up to the next wildcard so
      // `escapeRegexLiteral` sees whole chunks rather than one character
      // calls (cosmetic; behaves identically either way).
      let j = i;
      while (j < pattern.length && pattern[j] !== "*") j++;
      body += escapeRegexLiteral(pattern.slice(i, j));
      i = j;
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}$`);
}

/**
 * Compile one non-blank, non-comment `.gitignore` line (this module's
 * TSDoc). Returns `undefined` for a line that, once trimmed, is empty (a
 * blank line, or a lone `!`/`/` with nothing left to match).
 */
function compileGitignoreLine(rawLine: string): CompiledPattern | undefined {
  let line = rawLine;
  // A line ending in whitespace is trimmed UNLESS that whitespace is
  // backslash-escaped (real `.gitignore` semantics) — this module only
  // handles the common, non-escaped case: trim trailing unescaped spaces.
  line = line.replace(/(?<!\\)\s+$/, "");
  if (line.length === 0) return undefined;

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }
  if (line.length === 0) return undefined;

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return undefined;

  // Anchored: a leading `/`, or a `/` anywhere in the middle (this
  // module's TSDoc's "Scope"). A `/` that was only ever the trailing
  // dir-only marker was already stripped above, so any `/` still present
  // here is a genuine anchor signal.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  return { negate, dirOnly, regex: compileGlobToRegex(line, anchored) };
}

/** A parsed `.gitignore` file, ready to test root-relative paths against
 * (this module's TSDoc). */
export interface GitignoreMatcher {
  /**
   * Whether `relativePath` (root-relative, `/`-joined, no leading `/`) is
   * ignored — the LAST pattern that matches wins (real `.gitignore`
   * semantics: a later `!`-negation un-ignores an earlier match, and a
   * later plain pattern re-ignores an earlier negation). `isDirectory`
   * gates `dirOnly` patterns, which never match a plain file.
   */
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
}

/** A {@link GitignoreMatcher} with no patterns at all — every path reports
 * not-ignored (used when there is no `.gitignore` to parse). */
const EMPTY_MATCHER: GitignoreMatcher = { isIgnored: () => false };

/**
 * Parse `.gitignore` file content (Task 3.3, Req 11.2) into a reusable
 * {@link GitignoreMatcher}. Comment lines (`#`, unless escaped as `\#`) and
 * blank lines are skipped, per real `.gitignore` syntax. Never throws — a
 * malformed line simply compiles to nothing rather than aborting the whole
 * file (this codebase's "a partial/bad input degrades gracefully"
 * convention, e.g. `walkFiles.ts`'s unreadable-directory handling).
 */
export function parseGitignore(content: string): GitignoreMatcher {
  const patterns: CompiledPattern[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine;
    if (line.trim().length === 0) continue;
    if (line.startsWith("#")) continue;
    try {
      const compiled = compileGitignoreLine(line.startsWith("\\#") ? line.slice(1) : line);
      if (compiled) patterns.push(compiled);
    } catch {
      // A pathological line (this module's TSDoc): skip it, keep parsing
      // the rest of the file.
    }
  }
  if (patterns.length === 0) return EMPTY_MATCHER;

  function isIgnored(relativePath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const pattern of patterns) {
      if (pattern.dirOnly && !isDirectory) continue;
      if (pattern.regex.test(relativePath)) {
        ignored = !pattern.negate;
      }
    }
    return ignored;
  }

  return { isIgnored };
}
