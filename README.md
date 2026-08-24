# tecode

## CI

Issue #36 "4.5 CI pipeline" (Req 13.1, 13.2, 13.4; design.md §15, §16).
`.github/workflows/ci.yml` runs five independent jobs on every push to
`main` and every pull request; `.github/workflows/release.yml` runs a
sixth, tag-triggered job (see the "Release" section below). Each CI job
is reproducible locally with one `bun run` script:

| CI job        | Local command         | What it checks |
|---------------|------------------------|-----------------|
| `lint`        | `bun run lint`         | ESLint, including the `no-restricted-imports`/`no-restricted-syntax` layering rule (`eslint.config.mjs`) that keeps `@tecode/core` importable only from `packages/cli`. |
| `test`        | `bun test`              | The full workspace `bun test` suite. |
| `contract`    | `bun run test:contract` | The `API_VERSION` gate — the extension-API contract suite (`packages/core/src/api/create.contract.test.ts`) plus the constant's own assertions (`packages/api/src/index.test.ts`). |
| `snapshot`    | `bun run test:snapshot` | The headless-renderer cell-grid suite: every `*.snapshot.test.tsx` file, rendered via `@opentui/react/test-utils`'s `testRender` (design.md §16, "snapshots the cell grid" — no `toMatchSnapshot`, every assertion reads real rendered output). |
| `performance` | `bun run test:perf`     | Startup-to-first-frame timing (`packages/cli/src/main.integration.test.ts`) and the scripted 10,000-line typing benchmark (`packages/cli/src/typingBenchmark.test.ts`) — thresholds live as named constants in each test file, not in the workflow. |

`bunx tsc --noEmit` is also worth running locally before pushing (not its
own CI job — `bun test`'s own module resolution already fails loudly on a
real type error in a file any test imports, and `lint`'s `typescript-
eslint` rules catch most of the rest — but a standalone typecheck is the
fastest way to confirm a change is clean before opening a PR).

**Branch protection** (repo configuration, not something a commit can set):
for pull requests to actually be blocked on `lint`/`test`/`contract`/
`snapshot` failures per this issue's completion requirements, a repo admin
must add each job as a required status check under Settings → Branches →
branch protection rule for `main` ("Require status checks to pass before
merging", then select `Lint (ESLint incl. layering rule)`, `Test (full bun
test suite)`, `Contract suite (API_VERSION gate)`, and `Snapshot (headless-
renderer cell-grid suite)` by name — they only appear in that picker after
each has run at least once on a branch or PR). `performance` is
deliberately left out of that required list: Req 13.1's thresholds already
carry generous headroom specifically to avoid CI flakiness, but a shared
runner's noise floor is still less predictable run-to-run than the other
four gates, so it is left informational (visible on every PR, blocking
`main`'s own push trigger, but not a hard merge gate) rather than risking
blocking merges on infrastructure noise rather than a real regression.

## Release

`bun run release [target ...]` builds the compiled-binary release matrix
(see `scripts/release.ts`'s TSDoc for the full embedding story and why
cross-compilation is not possible from a single machine). Three of the
completion requirements from Issue #35 need a platform or a real terminal
this repo's own CI/dev environment doesn't have — see
[`docs/manual-release-verification.md`](docs/manual-release-verification.md)
for the exact procedure.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds all
six `RELEASE_TARGETS` in parallel — one matched-architecture runner per
target (see that workflow's own top-of-file comment for the full "why six
runners, not three" explanation and the exact target→runner table), each
invoking `bun run release <its-own-target>` so it only ever builds the one
target its own `@opentui/core` native optional dependency can actually
link for. Every target uploads its binary as its own artifact
(`tecode-<target>`) and a small size-report JSON; a final `summary` job
(`if: always()`, so it still runs and reports even if one leg failed)
collects those into a target × size Markdown table written to the run's
job summary, checked against `scripts/release.ts`'s own
`SIZE_LIMIT_BYTES` (120,000,000 bytes, the decimal — stricter — reading of
"≤ 120 MB").