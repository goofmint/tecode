/**
 * Line-oriented plain-text matching for the search extension's full-text
 * mode (Issue #147) — pure functions over an already-decoded string, with
 * no `tecode` API surface and no I/O of their own, so `store.ts` owns
 * every `workspace.fs.read` call and this module stays trivially testable.
 *
 * **Why not `@tecode/core`'s `computeMatches`** (`editor/find.ts`): that
 * function does exactly this job for the in-buffer find widget, but
 * `packages/builtin/**` may never import `@tecode/core` (the ESLint
 * layering rule), so this is a deliberate, LOCAL reimplementation of the
 * same behaviour rather than reuse — zero-based line/character positions,
 * one single-line range per hit, non-overlapping matches within a line
 * (each match resumes scanning after the previous match's end).
 *
 * **Literal substring matching, not regex** (this codebase's find widget
 * is literal too): a query is matched verbatim, so a user searching for
 * `a.b` finds the literal text `a.b`, never `axb`. Case sensitivity is the
 * caller's choice ({@link FindLineMatchesOptions.caseSensitive}, wired to
 * `search.caseSensitive`).
 */

/** One matched occurrence inside one line (this module's TSDoc). */
export interface LineMatch {
  /** Zero-based line number within the searched text. */
  line: number;
  /** Zero-based character offset of the match's first character. */
  startCharacter: number;
  /** Zero-based character offset one past the match's last character
   * (half-open, matching `@tecode/api`'s `Range`). */
  endCharacter: number;
  /** The whole line the match sits on, with no trailing line terminator —
   * what the results tree renders as the hit's label. */
  lineText: string;
}

/** Options for {@link findLineMatches}. */
export interface FindLineMatchesOptions {
  /** Match case exactly (`search.caseSensitive`). Defaults to `false`. */
  caseSensitive?: boolean;
  /** Stop after this many matches, leaving the rest of the text unscanned
   * — the per-file half of `store.ts`'s global result cap. Omit for an
   * unbounded scan. */
  maxMatches?: number;
}

/**
 * How many leading bytes {@link looksBinary} inspects. Matches the
 * conventional "first 8 KiB" heuristic (`git`'s own buffer-is-binary check
 * looks at a leading block too) — enough to catch real binaries cheaply,
 * without decoding or scanning a whole large file just to reject it.
 */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Whether `bytes` looks like a binary file and should be skipped rather
 * than decoded and searched (this module's TSDoc; Issue #147's plan:
 * "バイナリファイルを検索対象から除外する軽量判定"). A NUL byte anywhere in
 * the leading {@link BINARY_SNIFF_BYTES} is the signal — valid UTF-8 text
 * never contains one, while virtually every real binary format does within
 * its first few kilobytes. Deliberately conservative and cheap: a false
 * negative just means one binary file gets searched (and matches nothing
 * useful), never an error.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Every non-overlapping occurrence of `query` in `text`, line by line
 * (this module's TSDoc). An empty `query` matches nothing (returns `[]`) —
 * "no query typed yet" must never mean "every position in the workspace".
 * Never throws.
 */
export function findLineMatches(
  text: string,
  query: string,
  options: FindLineMatchesOptions = {},
): LineMatch[] {
  const matches: LineMatch[] = [];
  if (query.length === 0) return matches;

  const caseSensitive = options.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLowerCase();
  const { maxMatches } = options;

  // `\r\n` and `\n` both terminate a line; a lone `\r` (classic Mac) is
  // left inside the line text, matching how this codebase's own document
  // layer treats EOLs (`crlf`/`lf` only).
  const lines = text.split("\n");

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line] ?? "";
    const lineText = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const haystack = caseSensitive ? lineText : lineText.toLowerCase();

    let from = 0;
    for (;;) {
      if (maxMatches !== undefined && matches.length >= maxMatches) return matches;
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      matches.push({
        line,
        startCharacter: index,
        endCharacter: index + query.length,
        lineText,
      });
      // Non-overlapping (this module's TSDoc): resume after this match.
      from = index + query.length;
    }
  }

  return matches;
}
