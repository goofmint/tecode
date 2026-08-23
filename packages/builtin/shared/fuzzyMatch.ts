/**
 * A subsequence fuzzy matcher (Task 3.2, Req 11.3; design.md §13: "a
 * subsequence-scoring fuzzy matcher (VS Code-like: consecutive-run and
 * word-boundary bonuses)"). Shared between the command palette
 * (`ctrl+shift+p`, matching command titles) and file quick-open (`ctrl+p`,
 * matching relative file paths) — both just need "does `candidate` fuzzy
 * match `query`, and how well" with no dependency on either feature's own
 * state, so it lives in `packages/builtin/shared/` rather than either
 * built-in's own directory.
 *
 * **Pure and deterministic** (this task's plan): no I/O, no randomness, no
 * hidden state — the same `(query, candidate)` pair always produces the
 * same result, which is what makes a scoring-table unit test meaningful.
 *
 * **Ranking tiers** (highest to lowest, this task's plan's "exact > prefix
 * > word-boundary subsequence > scattered subsequence"):
 *
 * 1. **Exact** — `candidate` equals `query`, case-insensitively.
 * 2. **Prefix** — `candidate` starts with `query`, case-insensitively (and
 *    isn't an exact match).
 * 3. **Word-boundary subsequence** — every character of `query` can be
 *    matched, in order, against characters of `candidate` that each START a
 *    "word" (see {@link isWordBoundary}) — the classic acronym-style match
 *    (`"gsw"` against `"Go to Symbol in Workspace"`, one letter per word, or
 *    `"ma"` against `"MyApplication"`: `M` is the first character and `A`
 *    starts a word after the `y`→`A` case transition, so both matched
 *    characters land on boundaries). Checked by testing whether `query` is a
 *    subsequence of the STRING OF JUST `candidate`'s boundary characters — a
 *    clean, independent-of-greediness way to ask "does some alignment exist
 *    that only touches boundaries", without a full dynamic-programming
 *    search. Note this means `"app"` against `"MyApplication"` is NOT tier
 *    3: `candidate`'s boundary characters are only `"MA"`, and `"app"` is
 *    not a subsequence of that two-character string — it falls through to
 *    tier 4 instead, picking up just the {@link BOUNDARY_BONUS} tie-breaker
 *    below for the one matched position (`A`) that happens to be a
 *    boundary.
 * 4. **Scattered subsequence** — `query`'s characters appear in order
 *    somewhere in `candidate`, but not every matched position is a
 *    boundary. Found by the same leftmost-greedy subsequence scan
 *    {@link matchSubsequencePositions} uses for tier 3, just run against the
 *    full candidate instead of only its boundary characters.
 *
 * A `candidate` that fails even tier 4 (not a subsequence at all) does not
 * match — {@link fuzzyMatch} returns `undefined`.
 *
 * **Within a tier**, {@link fuzzyMatch} breaks ties with the same
 * "VS Code-like" bonuses this task's plan calls for: a bonus per character
 * that extends a CONSECUTIVE run of matched characters (rewards a single
 * unbroken match over one scattered across the candidate), a bonus per
 * matched position that is itself a boundary (rewards acronym-ish partial
 * credit even outside tier 3), and a small penalty for how late the first
 * match starts (prefers a match nearer the front of `candidate`). These
 * only ever reorder results WITHIN a tier — the tier component of the
 * combined score is weighted far above any possible sum of the fine-grained
 * bonuses, so tier order is never disturbed by them.
 *
 * **Empty `query`** matches every `candidate` with the same neutral score
 * (`0`) — "no filter typed yet" should show everything without any one
 * candidate arbitrarily outranking another (quick-open's pre-ranked initial
 * listing, before the user has typed anything into the picker).
 */

/** What {@link fuzzyMatch} returns for a matching `(query, candidate)` pair.
 * Higher {@link score} is a better match — sort candidates DESCENDING by
 * this value. There is no meaning to the number in isolation (it packs a
 * ranking tier and a fine-grained tie-breaker together) — only comparisons
 * between two `fuzzyMatch` results for the SAME `query` are meaningful. */
export interface FuzzyMatchResult {
  readonly score: number;
}

/** Separator characters that always start a new "word" for
 * {@link isWordBoundary}'s purposes — the common delimiters in file paths,
 * command ids, and titles alike. */
const WORD_SEPARATORS = new Set([" ", "-", "_", "/", "\\", ".", ":", "'", '"']);

/** Whether `candidate[index]` starts a "word" (this module's TSDoc's
 * word-boundary tier/bonus): the very first character, the character right
 * after a {@link WORD_SEPARATORS} delimiter, or a camelCase transition
 * (lowercase-or-digit followed by uppercase). Operates on the ORIGINAL
 * (not lowercased) `candidate` — the camelCase check needs real case
 * information, which case-insensitive matching elsewhere in this module
 * deliberately discards. */
function isWordBoundary(candidate: string, index: number): boolean {
  if (index === 0) return true;
  const prev = candidate[index - 1] as string;
  const curr = candidate[index] as string;
  if (WORD_SEPARATORS.has(prev)) return true;
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(curr);
}

/**
 * Leftmost-greedy subsequence match: for each character of `lowerQuery` (in
 * order), find the earliest position in `lowerHaystack` at or after the
 * current cursor that matches, and advance the cursor past it. Returns the
 * matched positions (into `lowerHaystack`, same length as `lowerQuery`), or
 * `undefined` if some character has no remaining occurrence.
 *
 * Deliberately greedy rather than an optimal (dynamic-programming) search —
 * simple, fast, and fully deterministic, which is all {@link fuzzyMatch}
 * needs: it is used to test "does ANY alignment exist" (existence, not
 * optimality) for tier 3/4, and the tie-breaking bonuses computed FROM
 * these positions are only ever compared within the same tier for the same
 * `query`.
 */
function matchSubsequencePositions(lowerQuery: string, lowerHaystack: string): number[] | undefined {
  if (lowerQuery.length === 0) return [];
  const positions: number[] = [];
  let cursor = 0;
  for (const ch of lowerQuery) {
    const found = lowerHaystack.indexOf(ch, cursor);
    if (found === -1) return undefined;
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

/** Ranking tiers (this module's TSDoc), ordered so a higher number always
 * outranks a lower one regardless of any fine-grained bonus. */
const TIER_SCATTERED = 0;
const TIER_WORD_BOUNDARY = 1;
const TIER_PREFIX = 2;
const TIER_EXACT = 3;

/** Weight applied to the tier so it always dominates the fine-grained
 * bonuses below — {@link fineScore} is bounded well under this per
 * matched character. */
const TIER_WEIGHT = 1_000_000;

/** Per-matched-character bonus for extending a consecutive run (this
 * module's TSDoc) — applied once per character beyond the first in a run. */
const CONSECUTIVE_RUN_BONUS = 8;
/** Per-matched-character bonus for landing on a word boundary. */
const BOUNDARY_BONUS = 5;
/** Penalty per index the first match is found at, discouraging a match
 * that only starts deep into `candidate`. Small and capped in effect by
 * `CONSECUTIVE_RUN_BONUS`/`BOUNDARY_BONUS`'s much larger per-character
 * weight over any realistic candidate length. */
const START_POSITION_PENALTY = 0.5;

/** Compute the fine-grained, within-tier tie-breaker score from a set of
 * matched `positions` (ascending, into the ORIGINAL `candidate`) — the
 * consecutive-run and word-boundary bonuses this module's TSDoc describes,
 * minus a small start-position penalty. */
function fineScore(candidate: string, positions: readonly number[]): number {
  if (positions.length === 0) return 0;
  let score = -((positions[0] as number) * START_POSITION_PENALTY);
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i] as number;
    if (isWordBoundary(candidate, pos)) score += BOUNDARY_BONUS;
    if (i > 0 && pos === (positions[i - 1] as number) + 1) score += CONSECUTIVE_RUN_BONUS;
  }
  return score;
}

/**
 * Fuzzy-match `query` against `candidate` (this module's TSDoc). Returns
 * `undefined` when `query`'s characters do not all appear, in order,
 * somewhere in `candidate` — i.e. no match at any tier.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatchResult | undefined {
  if (query.length === 0) return { score: 0 };

  const lowerQuery = query.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();

  if (lowerCandidate === lowerQuery) {
    return { score: TIER_EXACT * TIER_WEIGHT };
  }

  if (lowerCandidate.startsWith(lowerQuery)) {
    const positions = Array.from({ length: query.length }, (_, i) => i);
    return { score: TIER_PREFIX * TIER_WEIGHT + fineScore(candidate, positions) };
  }

  // Tier 3: is `query` a subsequence of just candidate's boundary
  // characters? Build the boundary-index list once, match against the
  // lowercased boundary-character string, then map matched indices back
  // into `candidate`-space for scoring.
  const boundaryIndices: number[] = [];
  for (let i = 0; i < candidate.length; i++) {
    if (isWordBoundary(candidate, i)) boundaryIndices.push(i);
  }
  const boundaryChars = boundaryIndices.map((i) => lowerCandidate[i]).join("");
  const boundaryMatch = matchSubsequencePositions(lowerQuery, boundaryChars);
  if (boundaryMatch !== undefined) {
    const positions = boundaryMatch.map((i) => boundaryIndices[i] as number);
    return { score: TIER_WORD_BOUNDARY * TIER_WEIGHT + fineScore(candidate, positions) };
  }

  // Tier 4: a plain scattered subsequence anywhere in the full candidate.
  const scatteredMatch = matchSubsequencePositions(lowerQuery, lowerCandidate);
  if (scatteredMatch !== undefined) {
    return { score: TIER_SCATTERED * TIER_WEIGHT + fineScore(candidate, scatteredMatch) };
  }

  return undefined;
}
