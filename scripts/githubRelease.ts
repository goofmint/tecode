/**
 * Pure GitHub-Release domain logic shared, in spirit, by two different
 * runtimes that both need it: `scripts/tagRelease.ts` (`bun run tag`, this
 * repo's own TypeScript, imports this module directly) and `.circleci/
 * config.yml`'s `publish` job (a shell script — bash has no import
 * statement, so it re-implements the SAME algorithm in `python3 -c`
 * snippets inline). Keeping the algorithm here, with its own direct unit
 * tests, means the logic itself — not just its two independent
 * implementations — has a spec a reader can check either implementation
 * against; the shell copy is verified separately by actually executing it
 * against a stubbed `curl` (see this change's own validation notes, not a
 * source file).
 *
 * Everything in this module is a pure function over already-fetched data —
 * no network, no filesystem, no `git`. That is deliberate: it is the one
 * part of the local-macOS-release flow (design decision behind `bun run
 * tag`) cheap and deterministic enough to test directly, matching this
 * repo's `scripts/release.ts` precedent of separating "decide what to do"
 * (pure, tested here) from "actually do it" (impure, exercised for real
 * only by manual/integration verification).
 */

/** The handful of GitHub Release API fields this module's functions
 * actually read — a real API response carries many more, but narrowing to
 * exactly these (house `Pick<>`-narrowing convention, applied to a plain
 * data shape rather than a service interface) keeps every test fixture
 * below small and honest about what this code depends on. */
export interface GitHubReleaseSummary {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
}

/**
 * Find ANY release — draft or published — whose `tag_name` matches `tag`.
 * This is `scripts/tagRelease.ts`'s own preflight check 8 ("no GitHub
 * release already exists with that `tag_name`, draft or published"): a
 * second `bun run tag` for a version that already shipped (or that has an
 * abandoned draft sitting from a previous failed attempt) must not race or
 * silently create a duplicate.
 *
 * Deliberately does NOT use `GET /repos/{owner}/{repo}/releases/tags/
 * {tag}` — that endpoint does not reliably return draft releases (observed
 * behavior of the GitHub REST API, not documented reliably either way), so
 * both this function and {@link findDraftReleaseByTag} below are written
 * to search a full `GET /releases?per_page=100` listing instead, matching
 * exactly what `.circleci/config.yml`'s `publish` job does in bash for the
 * identical reason.
 */
export function findReleaseByTag(
  releases: readonly GitHubReleaseSummary[],
  tag: string,
): GitHubReleaseSummary | undefined {
  return releases.find((release) => release.tag_name === tag);
}

/**
 * Find the DRAFT release `bun run tag` created for `tag` — the exact
 * selection `.circleci/config.yml`'s `publish` job needs (its own
 * top-of-file comment and this module's own TSDoc explain why a listing
 * search, not the `/releases/tags/{tag}` endpoint). Requires BOTH
 * `tag_name === tag` AND `draft === true`: a published release sharing the
 * tag (should not normally happen, since {@link findReleaseByTag}'s
 * preflight check blocks a second `bun run tag` for an already-published
 * tag) must never be silently treated as the draft to attach assets to.
 *
 * `undefined` is `publish`'s "the tag was pushed without `bun run tag`"
 * signal (Req: "fail loudly ... do not fall back to creating a release") —
 * this function itself makes no such decision, it only reports what it
 * found.
 */
export function findDraftReleaseByTag(
  releases: readonly GitHubReleaseSummary[],
  tag: string,
): GitHubReleaseSummary | undefined {
  return releases.find((release) => release.tag_name === tag && release.draft === true);
}

/** {@link checkAssetsComplete}'s verdict — `ok` is `true` only when every
 * name in `expected` appears (by exact string) in `actual`; `missing`
 * lists, in `expected`'s own order, every one that does not (empty when
 * `ok`). Extra assets in `actual` beyond `expected` are never flagged —
 * this check answers "is everything we need here", not "is there anything
 * unexpected here". */
export interface AssetCompletenessResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/**
 * Confirm a release's actual asset names cover every expected one — the
 * "asset-completeness check" both `bun run tag` conceptually relies on
 * (implicitly: it uploads exactly the 2 macOS assets it just built, and
 * this function is what proves both landed) and `.circleci/config.yml`'s
 * `publish` job needs explicitly (Req: "verifies the release now holds all
 * four binaries and all four checksums ... and only then PATCHes
 * `draft:false`" — `publish`'s shell implementation re-derives the same
 * two counts with its own `python3 -c` snippets, since it has no import
 * statement to reach this function with).
 *
 * Exact-string membership, not count comparison: two releases can each
 * have "4 binaries and 4 checksums" while actually missing one platform's
 * pair and double-uploading another's, if this only compared counts. This
 * function checks names instead — deliberately more precise than what the
 * shell copy actually implements (a count comparison, per Req's own
 * wording of that check) precisely because it exists as this algorithm's
 * spec: the shell version is the "acceptable, simple approximation of
 * this" that a comment can point back here to justify.
 */
export function checkAssetsComplete(
  actualAssetNames: readonly string[],
  expectedAssetNames: readonly string[],
): AssetCompletenessResult {
  const actual = new Set(actualAssetNames);
  const missing = expectedAssetNames.filter((name) => !actual.has(name));
  return { ok: missing.length === 0, missing };
}

/**
 * Parse `owner`/`repo` out of a `git remote get-url origin` value —
 * `bun run tag` needs these to build the GitHub API base URL
 * (`https://api.github.com/repos/<owner>/<repo>`) and has no other source
 * for them (unlike CircleCI's `publish` job, which gets
 * `CIRCLE_PROJECT_USERNAME`/`CIRCLE_PROJECT_REPONAME` from its own
 * environment). Handles both remote URL shapes `git remote get-url` can
 * return for a GitHub origin:
 *
 * - HTTPS: `https://github.com/<owner>/<repo>.git` (or without the
 *   trailing `.git` — GitHub accepts clones either way, so both must
 *   parse identically).
 * - SSH: `git@github.com:<owner>/<repo>.git` (same optional `.git`).
 *
 * Returns `undefined` for anything else (a non-GitHub remote, a malformed
 * URL) — `bun run tag`'s preflight surfaces that as its own actionable
 * failure rather than this function throwing.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | undefined {
  const trimmed = remoteUrl.trim();
  const patterns = [
    // https://github.com/<owner>/<repo>[.git]
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    // git@github.com:<owner>/<repo>[.git]
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      return { owner: match[1]!, repo: match[2]! };
    }
  }
  return undefined;
}
