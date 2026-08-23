/**
 * Pure in-buffer find/replace primitives (Req 11.1, design.md §13):
 * matching a plain-text query against a document's lines, and building the
 * `TextEdit`(s) a replace-one/replace-all action applies. No document/UI
 * dependency — everything here is a deterministic computation over a
 * `LineReader`-shaped reader and plain `Range`/`TextEdit` values, unit
 * testable without a renderer (this codebase's "keep pure functions pure"
 * house convention, matching `editor/positionTransform.ts`/`editor/
 * movement.ts`'s own shape). `ui/findService.ts` is the stateful layer that
 * wires these into a live `EditorState`.
 *
 * **Scope — line-by-line matching, not whole-buffer** (Req 11.1 lists
 * "in-buffer find/replace" with no cross-line requirement): {@link
 * computeMatches} scans each line independently. A query containing a line
 * break (`"\n"`/`"\r"`) can therefore never match anything — there is no
 * line whose own text ever contains one — which is the documented,
 * deliberate limitation rather than a bug: multi-line find/replace is out
 * of scope for this task. Every {@link Range} this module produces is
 * always a single-line range as a result.
 *
 * **Non-overlapping matches**: within one line, matches never overlap —
 * after finding a match, scanning resumes at its END, not one character
 * past its START. This matters for a query that could otherwise match
 * itself against its own tail (e.g. `"aa"` against `"aaaa"` yields matches
 * at `[0,2)` and `[2,4)`, not the overlapping `[0,2)`/`[1,3)`/`[2,4)`) —
 * the same non-overlap precondition `LineBuffer.applyEdits`/
 * `positionTransform.ts` already require of every edit batch in this
 * codebase, which is exactly what lets {@link buildReplaceAllEdits} hand
 * its whole batch straight to a single `applyEdits` call with no
 * additional overlap-checking of its own.
 */

import type { Range, TextEdit } from "@tecode/api";

/**
 * Case-fold `text` for {@link computeMatches}'s case-insensitive comparison
 * WITHOUT changing its UTF-16 length (CodeRabbit finding on PR #59: plain
 * `String.prototype.toLowerCase()` can change a string's length — e.g.
 * `"İ".toLowerCase()` is `"i̇"`, a two-UTF-16-unit string, because U+0130
 * LATIN CAPITAL LETTER I WITH DOT ABOVE case-folds to `i` + a COMBINING DOT
 * ABOVE. Folding a whole line that way and reusing `indexOf`'s result index
 * against the ORIGINAL line text corrupts every match/replace `Range` at or
 * after that character — this module's `Range`s are handed straight to
 * `ui/findService.ts` for highlighting and to {@link buildReplaceEdit}/
 * {@link buildReplaceAllEdits} for replacement, so a wrong offset both
 * highlights and edits the wrong span.
 *
 * The fix folds ONE UTF-16 CODE UNIT AT A TIME (indexed `text[i]`/
 * `text.length`, not a `for...of` code-point iteration — a code point still
 * has to fold to the SAME UTF-16-unit-COUNT it started with, and indexing
 * per unit is what makes that check trivial: `text[i]` is always exactly
 * one unit, so "did folding change the unit count" is just "is the folded
 * result still one unit"), keeping the one-character result only when it
 * is itself still exactly one UTF-16 unit long; otherwise the original
 * character is kept UNFOLDED. This guarantees `foldForMatch(text).length
 * === text.length`, with every index in the folded string meaning the same
 * position as in `text` — so `indexOf`'s result on the folded string is
 * always a valid, correct index into the original.
 *
 * **Documented limitation**: a character whose case fold CHANGES its
 * UTF-16 length (`"İ"`/U+0130 → `"i̇"` is the canonical example — others
 * exist, e.g. German `"ß"` uppercases to `"SS"` in some contexts, though
 * `toLowerCase` never expands it) simply does not case-fold here; it is
 * compared literally instead. Same-length folds — including non-BMP
 * surrogate pairs like Deseret `"\u{10400}"` → `"\u{10428}"` — DO fold. Both the haystack (a document line) and the
 * needle (the query) are folded through this SAME function, so a query
 * containing such a character still matches an identical literal
 * occurrence — it only fails to match the character's OTHER case, which is
 * the accepted trade-off for exact, never-corrupted offsets.
 */
function foldForMatch(text: string): string {
  let folded = "";
  // Iterate CODE POINTS (not UTF-16 units): a surrogate pair like
  // "\u{10400}" is one `ch` of length 2 here, and its lowercase
  // "\u{10428}" is also length 2 — accepting any same-length fold keeps
  // the length invariant above while still case-folding non-BMP letters
  // (CodeRabbit finding on PR #59: per-unit iteration split surrogate
  // pairs, so Deseret capital/small letters never matched).
  for (const ch of text) {
    const lower = ch.toLowerCase();
    folded += lower.length === ch.length ? lower : ch;
  }
  return folded;
}

/** The minimal document-reading surface {@link computeMatches} needs —
 * matches `editor-core`'s own `LineReader` shape (`movement.ts`) and
 * `tecode.editor`'s `getLine`/`lineCount` pair, so a caller can pass either
 * directly without adapting. */
export interface LineReader {
  getLine(line: number): string;
  lineCount: number;
}

/**
 * Find every non-overlapping occurrence of `query` across `lineReader`'s
 * lines, in document order (this module's TSDoc's "Scope"/"Non-overlapping
 * matches"). An empty `query` always yields `[]` — matching every zero-width
 * gap in every line would be both useless to a find widget and, worse, an
 * infinite loop if not special-cased (advancing zero characters past a
 * zero-length match never terminates the scan). `caseSensitive` controls an
 * exact vs. case-insensitive ({@link foldForMatch}-normalized, length- and
 * offset-preserving — see its TSDoc) comparison; no locale-aware or
 * Unicode-normalizing comparison is attempted.
 */
export function computeMatches(
  lineReader: LineReader,
  query: string,
  caseSensitive: boolean,
): Range[] {
  if (query.length === 0) return [];
  const needle = caseSensitive ? query : foldForMatch(query);
  const matches: Range[] = [];

  for (let line = 0; line < lineReader.lineCount; line++) {
    const lineText = lineReader.getLine(line);
    const haystack = caseSensitive ? lineText : foldForMatch(lineText);

    let searchFrom = 0;
    while (searchFrom <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, searchFrom);
      if (index === -1) break;
      matches.push({
        start: { line, character: index },
        end: { line, character: index + needle.length },
      });
      // Resume scanning at this match's END (this module's TSDoc's
      // "Non-overlapping matches") — not `index + 1`, which would also
      // report every overlapping occurrence of a self-overlapping needle.
      searchFrom = index + needle.length;
    }
  }

  return matches;
}

/**
 * The single `TextEdit` that replaces one `match` with `replacement` (Req
 * 11.1's replace-one). A thin, deliberately trivial wrapper — kept as its
 * own function (rather than inlined at each call site) so {@link
 * buildReplaceAllEdits} and `ui/findService.ts`'s replace-current path
 * share exactly one definition of "what replacing a match means".
 */
export function buildReplaceEdit(match: Range, replacement: string): TextEdit {
  return { range: { start: match.start, end: match.end }, newText: replacement };
}

/**
 * The full `TextEdit[]` batch that replaces every one of `matches` with
 * `replacement` (Req 11.1's replace-all) — safe to hand directly to one
 * `Document.applyEdits` call (inside a `document.transaction(...)` for a
 * single undo step, `ui/findService.ts`'s job) since {@link computeMatches}
 * already guarantees `matches` never overlap.
 */
export function buildReplaceAllEdits(matches: readonly Range[], replacement: string): TextEdit[] {
  return matches.map((match) => buildReplaceEdit(match, replacement));
}
