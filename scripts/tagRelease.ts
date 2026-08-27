/**
 * `bun run tag <version>` (Req 13.2, design.md §17) — the local counterpart
 * to `.circleci/config.yml`'s tag-triggered release pipeline, run by hand
 * on the project owner's own Apple Silicon Mac. The owner declined to
 * install a CircleCI machine runner on that Mac (`scripts/release.ts`'s
 * `ReleaseTarget.builtBy` TSDoc explains the resulting split), so this
 * script does everything a `build-darwin-arm64` CircleCI job otherwise
 * would, PLUS creates the GitHub Release and pushes the tag that fires
 * CircleCI for the other three targets — one command, in this exact order:
 *
 * 1. **Preflight** ({@link evaluatePreflight}) — every check runs, and ALL
 *    must pass, before any mutating step. Nothing here mutates anything;
 *    a failing check is reported with a specific, actionable message
 *    ({@link PreflightCheck.message}) naming what is wrong and what to do.
 * 2. **Build** `bun-darwin-arm64` by calling {@link buildTarget}
 *    (`scripts/release.ts`) — reused, not duplicated: it already enforces
 *    `SIZE_LIMIT_BYTES`, and {@link writeChecksumFile} (also reused)
 *    writes the `.sha256` sibling. This is the step most likely to fail
 *    (a real compile, on real hardware, against whatever `bun`/dependency
 *    versions happen to be installed) — it runs FIRST, before anything
 *    external exists to clean up, so a failed build leaves nothing behind.
 * 3. **Create a DRAFT GitHub Release** for the version and upload the two
 *    macOS assets (`tecode-darwin-arm64`, `tecode-darwin-arm64.sha256|`),
 *    then verify both landed ({@link checkAssetsComplete}) before moving
 *    on.
 * 4. **Create and push the annotated git tag** — LAST, deliberately: it is
 *    the one irreversible step (pushing it fires CircleCI immediately; a
 *    tag push cannot be un-fired the way a draft release can simply be
 *    deleted), so everything reversible happens first. If step 3 already
 *    succeeded and this step fails, {@link createTagReleaseRunner}'s `run`
 *    prints exactly how to recover: the draft release to delete, or the
 *    exact `git tag`/`git push` command to run by hand to finish the job
 *    without repeating steps 1–3.
 *
 * Once the tag is pushed, `.circleci/config.yml`'s `release` workflow
 * builds the three `builtBy: "circleci"` targets, finds the draft this
 * script created (`.circleci/config.yml`'s `publish` job — see
 * {@link findDraftReleaseByTag}, the algorithm it mirrors in bash), adds
 * its own three targets' assets, verifies the release holds all
 * `RELEASE_TARGETS.length` binaries and checksums, and publishes.
 *
 * ## Testability — everything that touches the network, `git`, the
 * filesystem, or the clock is injected
 *
 * {@link GitPort} and {@link GitHubPort} are the two I/O seams (matching
 * this codebase's `GitRunner`-style convention — see
 * `packages/builtin/shared/gitRunner.ts`), each with a real, `Bun`-backed
 * default ({@link createBunGitPort}, {@link createGitHubPort}) and a
 * `createX(deps)` factory for the orchestrator itself
 * ({@link createTagReleaseRunner}). Every PURE decision — preflight
 * evaluation, version normalization, which release is the one to attach
 * to, whether an upload is complete — lives in ordinary exported functions
 * with their own direct `bun:test` coverage (`scripts/tagRelease.test.ts`,
 * `scripts/githubRelease.test.ts`), never inside `run` itself. `run`'s own
 * job is purely sequencing: gather inputs, evaluate, and — only once
 * everything upstream says go — perform each mutating step in order,
 * stopping and reporting recovery guidance the instant one fails.
 */

import { resolve } from "node:path";
import {
  binaryFileName,
  buildTarget,
  formatBytesAsMB,
  RELEASE_TARGETS,
  writeChecksumFile,
  type BuildOutcome,
  type BuildTargetOptions,
  type ChecksumOptions,
  type ReleaseTarget,
} from "./release";
import { checkAssetsComplete, findReleaseByTag, parseGitHubRemote, type GitHubReleaseSummary } from "./githubRelease";

// Re-exported purely so a caller of this module (and its own tests) can
// name the same selection algorithm `.circleci/config.yml`'s `publish` job
// mirrors in bash without a second import — see this module's own TSDoc,
// "Once the tag is pushed".
export { findDraftReleaseByTag } from "./githubRelease";

/** The one {@link ReleaseTarget} this script builds — resolved from
 * {@link RELEASE_TARGETS} by {@link ReleaseTarget.builtBy} rather than
 * hard-coded as `"bun-darwin-arm64"`, so the two files cannot silently
 * disagree about which target is local. Thrown at import time (not
 * awaited, not swallowed) if `RELEASE_TARGETS` is ever edited down to zero
 * `"local"` entries — a configuration error this severe should fail
 * immediately and loudly, not produce a confusing later failure. */
export const LOCAL_TARGET: ReleaseTarget = (() => {
  const target = RELEASE_TARGETS.find((t) => t.builtBy === "local");
  if (!target) {
    throw new Error("scripts/tagRelease.ts: no RELEASE_TARGETS entry has builtBy 'local' — nothing for `bun run tag` to build");
  }
  return target;
})();

/* ------------------------------------------------------------------ */
/* Version normalization                                               */
/* ------------------------------------------------------------------ */

/** {@link normalizeVersionArg}'s result: either the normalized `v`-prefixed
 * tag, or a human-readable reason the input was rejected. */
export type VersionValidation = { readonly ok: true; readonly tag: string } | { readonly ok: false; readonly error: string };

/**
 * Accepts `v1.2.3` or bare `1.2.3`, normalizes to a leading `v`; rejects
 * anything else. A single leading `v` (lowercase, exactly one) is
 * stripped, if present, before validating what remains against
 * `[0-9A-Za-z.+-]+` — the task's own character class. Nothing more
 * elaborate than that (no full semver grammar enforcement): the goal is to
 * reject a version that would produce a malformed or unsafe git ref /
 * GitHub `tag_name`, not to police version-numbering conventions.
 */
export function normalizeVersionArg(raw: string): VersionValidation {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: false, error: "no version given — usage: bun run tag <version>, e.g. bun run tag v1.2.3" };
  }
  const body = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (body.length === 0 || !/^[0-9A-Za-z.+-]+$/.test(body)) {
    return {
      ok: false,
      error: `invalid version "${raw}" — expected something like v1.2.3 or 1.2.3 (after an optional leading "v", only 0-9, A-Z, a-z, ".", "+", "-" are allowed)`,
    };
  }
  return { ok: true, tag: `v${body}` };
}

/* ------------------------------------------------------------------ */
/* Preflight — pure evaluation over already-fetched inputs             */
/* ------------------------------------------------------------------ */

/** A value some I/O call was asked to produce, wrapped so a failed fetch
 * becomes DATA (a specific check's failure message) rather than an
 * exception that would stop every OTHER check from running too — the
 * task's own "every check runs and must pass before any mutating step"
 * requirement demands this: one flaky `git`/network call must not hide
 * every other check's result. */
export type Fetched<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** One preflight check's outcome — {@link evaluatePreflight} always
 * produces exactly the eight named in this module's TSDoc ("Preflight"),
 * regardless of how many already failed, so a user sees everything wrong
 * in one run rather than fixing issues one at a time across repeated
 * invocations. */
export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Present iff `!ok` — names what is wrong and what to do about it
   * (task requirement: "a specific, actionable message"). */
  readonly message?: string;
}

/** Everything {@link evaluatePreflight} needs, already fetched by
 * {@link gatherPreflightInputs} (or a test's own fixture) — kept as a
 * flat, plain-data object specifically so `evaluatePreflight` itself stays
 * a pure function with zero `await`s, directly testable against synthetic
 * `Fetched` values without a single fake `git`/`fetch` call. */
export interface PreflightInputs {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly rawVersion: string;
  /** `git status --porcelain` output — non-empty means dirty. */
  readonly workingTreeStatus: Fetched<string>;
  readonly currentBranch: Fetched<string>;
  /** `git rev-parse main`. */
  readonly localMainSha: Fetched<string>;
  /** `git rev-parse origin/main`, taken AFTER a `git fetch origin main` —
   * gathering this is what "fetch first" (task requirement) means in
   * practice: without a fresh fetch, a stale `origin/main` ref would
   * silently pass this check for a main that is actually behind. */
  readonly remoteMainSha: Fetched<string>;
  /** Only meaningful once the version itself is well-formed — see
   * {@link gatherPreflightInputs} for why these default to
   * `{ ok: true, value: false }` / `{ ok: true, value: [] }` otherwise. */
  readonly tagExistsLocally: Fetched<boolean>;
  readonly tagExistsRemotely: Fetched<boolean>;
  readonly existingReleases: Fetched<readonly GitHubReleaseSummary[]>;
}

/** {@link evaluatePreflight}'s result. */
export interface PreflightEvaluation {
  readonly checks: readonly PreflightCheck[];
  readonly ok: boolean;
  /** The normalized tag, present iff the version-format check passed —
   * `run` uses this directly rather than re-normalizing. */
  readonly tag?: string;
}

function check(name: string, ok: boolean, message?: string): PreflightCheck {
  return ok ? { name, ok: true } : { name, ok: false, message };
}

/** Preflight check 1: this command builds the `bun-darwin-arm64` binary
 * itself (Finding: `@opentui/core` cannot cross-compile — `scripts/
 * release.ts`'s TSDoc), so it must run on the exact platform/arch that
 * binary is for. */
export function checkHostIsMacSilicon(platform: string, arch: string): PreflightCheck {
  return check(
    "host is darwin/arm64",
    platform === "darwin" && arch === "arm64",
    `this command builds the bun-darwin-arm64 binary itself, so it must run on an Apple Silicon Mac (darwin/arm64) — detected ${platform}/${arch}. Run "bun run tag" on the target Mac; the other three targets are built by the CircleCI pipeline instead.`,
  );
}

/** Preflight check 2: `TECODE_RELEASE_TOKEN` must be set — this script
 * talks to the GitHub API directly (list releases, create a draft, upload
 * assets), with no ambient credential the way CircleCI's own
 * `TECODE_RELEASE_TOKEN` project variable is configured separately for its
 * `publish` job.
 *
 * **Deliberately NOT named `GITHUB_TOKEN`**: that name is extremely common
 * ambient tooling convention (the `gh` CLI, GitHub Actions runners, and
 * assorted other tools all read it), so on the machine this script runs on
 * it may already be set to a token with far broader scope than this one
 * task needs — silently picking that up would run this script with
 * whatever permissions that ambient token happens to carry, not the
 * minimal one documented below. Naming this variable something this repo
 * alone recognizes means a value is only ever present because someone set
 * it FOR this script, never picked up by accident.
 *
 * **The minimum token this needs** (README's "Release" section has the
 * full walkthrough): a fine-grained personal access token, "Repository
 * access" limited to only `goofmint/tecode`, with exactly one repository
 * permission granted — Contents: Read and write (GitHub files releases
 * under Contents; this covers creating a draft release, uploading assets
 * to it, and PATCHing it to published). A classic PAT is the wrong choice
 * here: its `repo` scope grants access to every repository the owner can
 * reach, plus issues, with no way to narrow it to just this one
 * repository's release assets. This token is used ONLY for the GitHub
 * REST API calls in this script ({@link GitHubPort}) — pushing the git tag
 * itself (step 4) goes through the machine's ordinary `git` credentials,
 * not this token, so it needs no push/write-to-git access at all.
 *
 * **No fallback to `GITHUB_TOKEN` or any other variable, ever** — if
 * `TECODE_RELEASE_TOKEN` is unset, this check fails outright with a
 * message naming the variable and the permission it needs. Falling back
 * would silently reintroduce the exact ambient-scope problem this naming
 * choice exists to avoid.
 */
export function checkReleaseTokenSet(env: Readonly<Record<string, string | undefined>>): PreflightCheck {
  const token = env.TECODE_RELEASE_TOKEN;
  return check(
    "TECODE_RELEASE_TOKEN is set",
    typeof token === "string" && token.trim().length > 0,
    'TECODE_RELEASE_TOKEN is not set in the environment — export a fine-grained GitHub personal access token, scoped to ONLY goofmint/tecode with the single repository permission "Contents: Read and write", before running `bun run tag` (e.g. `export TECODE_RELEASE_TOKEN=github_pat_...`). A classic PAT is the wrong choice here — see this check\'s own source comment for why.',
  );
}

/** Preflight check 3: a dirty working tree must not be built and shipped
 * as a release — the binary would not match any commit a later `git
 * checkout <tag>` could reproduce. */
export function checkWorkingTreeClean(status: Fetched<string>): PreflightCheck {
  if (!status.ok) {
    return check("git working tree is clean", false, `could not determine git status: ${status.error}`);
  }
  const dirty = status.value.trim().length > 0;
  return check(
    "git working tree is clean",
    !dirty,
    `working tree has uncommitted changes — commit, stash, or discard them first:\n${status.value.trim()}`,
  );
}

/** Preflight check 4: releases are cut from `main`, never a feature
 * branch — the tag pushed at the end of this flow must point at a commit
 * that is (per check 5) actually on `origin/main`. */
export function checkOnMainBranch(branch: Fetched<string>): PreflightCheck {
  if (!branch.ok) {
    return check("current branch is main", false, `could not determine the current branch: ${branch.error}`);
  }
  return check(
    "current branch is main",
    branch.value === "main",
    `current branch is "${branch.value}", not "main" — run \`git checkout main\` first.`,
  );
}

/** Preflight check 5: local `main` must be identical to `origin/main`
 * (task requirement's own "fetch first" — {@link PreflightInputs.remoteMainSha}'s
 * TSDoc) — releasing from a local `main` that is ahead or behind origin
 * would tag a commit nobody else's checkout of `main` actually has. */
export function checkMainUpToDateWithOrigin(localSha: Fetched<string>, remoteSha: Fetched<string>): PreflightCheck {
  if (!localSha.ok) {
    return check("local main matches origin/main", false, `could not read local main's commit: ${localSha.error}`);
  }
  if (!remoteSha.ok) {
    return check("local main matches origin/main", false, `could not fetch origin/main: ${remoteSha.error}`);
  }
  return check(
    "local main matches origin/main",
    localSha.value === remoteSha.value,
    `local main (${localSha.value.slice(0, 12)}) differs from origin/main (${remoteSha.value.slice(0, 12)}) — run \`git pull --ff-only origin main\` (or push your local commits to origin) so the two match, then re-run.`,
  );
}

/** Preflight check 7: the tag must not already exist, locally or on
 * origin — pushing a tag `git push` refuses to move is a confusing way to
 * discover a duplicate late; checking up front gives a clear reason
 * instead. */
export function checkTagNotTaken(tag: string, existsLocally: Fetched<boolean>, existsRemotely: Fetched<boolean>): PreflightCheck {
  const name = `tag ${tag} does not already exist`;
  if (!existsLocally.ok) {
    return check(name, false, `could not check for a local tag: ${existsLocally.error}`);
  }
  if (!existsRemotely.ok) {
    return check(name, false, `could not check for a remote tag: ${existsRemotely.error}`);
  }
  if (existsLocally.value) {
    return check(
      name,
      false,
      `tag ${tag} already exists locally — delete it first (\`git tag -d ${tag}\`) if this is a genuine retry, or pick a different version.`,
    );
  }
  return check(
    name,
    !existsRemotely.value,
    `tag ${tag} already exists on origin — pick a different version, or delete the remote tag first if you are certain (\`git push origin :refs/tags/${tag}\`).`,
  );
}

/** Preflight check 8: no GitHub release — draft or published — may
 * already carry this `tag_name` ({@link findReleaseByTag}, `scripts/
 * githubRelease.ts`) — a leftover draft from a previous failed attempt, or
 * an already-published release, must not be silently reused or
 * duplicated. */
export function checkNoExistingRelease(tag: string, releases: Fetched<readonly GitHubReleaseSummary[]>): PreflightCheck {
  const name = `no GitHub release exists for ${tag}`;
  if (!releases.ok) {
    return check(name, false, `could not list GitHub releases: ${releases.error}`);
  }
  const existing = findReleaseByTag(releases.value, tag);
  if (existing) {
    return check(
      name,
      false,
      `a GitHub release already exists for ${tag} (id ${existing.id}, ${existing.draft ? "draft" : "published"}) — delete it first if this is a genuine retry, or pick a different version.`,
    );
  }
  return check(name, true);
}

/**
 * Evaluate all eight preflight checks against already-gathered
 * {@link PreflightInputs} — pure, synchronous, and the one function this
 * module's tests exercise most directly (every combination of which
 * check(s) fail, without a single real `git`/network call). ALWAYS
 * produces all eight results, even when the version itself is malformed
 * (checks 7–8 cannot meaningfully run without a valid tag, so they report
 * themselves as skipped rather than being silently omitted from the list —
 * the task's "every check runs" is about visibility, not about forcing a
 * check to run against data that cannot exist).
 */
export function evaluatePreflight(inputs: PreflightInputs): PreflightEvaluation {
  const version = normalizeVersionArg(inputs.rawVersion);

  const checks: PreflightCheck[] = [
    checkHostIsMacSilicon(inputs.platform, inputs.arch),
    checkReleaseTokenSet(inputs.env),
    checkWorkingTreeClean(inputs.workingTreeStatus),
    checkOnMainBranch(inputs.currentBranch),
    checkMainUpToDateWithOrigin(inputs.localMainSha, inputs.remoteMainSha),
    check("version argument is well-formed", version.ok, version.ok ? undefined : version.error),
  ];

  if (version.ok) {
    checks.push(checkTagNotTaken(version.tag, inputs.tagExistsLocally, inputs.tagExistsRemotely));
    checks.push(checkNoExistingRelease(version.tag, inputs.existingReleases));
  } else {
    checks.push(check("tag does not already exist", false, "skipped — fix the version argument first"));
    checks.push(check("no GitHub release exists for this version", false, "skipped — fix the version argument first"));
  }

  return { checks, ok: checks.every((c) => c.ok), tag: version.ok ? version.tag : undefined };
}

/* ------------------------------------------------------------------ */
/* GitPort — the injectable seam over the real `git` CLI                */
/* ------------------------------------------------------------------ */

/** Every `git` operation {@link gatherPreflightInputs}/`run` need,
 * injectable so `scripts/tagRelease.test.ts` exercises the pure logic
 * above (and `run`'s own sequencing) against hand-rolled fakes — no real
 * repository, network, or `git` binary required (house `GitRunner`-style
 * convention, `packages/builtin/shared/gitRunner.ts`). Unlike that
 * `GitRunner`, methods here MAY reject: this is a standalone CLI tool, not
 * a library boundary the running editor depends on to degrade gracefully,
 * so a real failure propagating up to `run`'s own try/catch (which turns
 * it into a specific, actionable message) is the right behavior. */
export interface GitPort {
  statusPorcelain(): Promise<string>;
  currentBranch(): Promise<string>;
  fetchOrigin(): Promise<void>;
  revParse(ref: string): Promise<string>;
  tagExistsLocally(tag: string): Promise<boolean>;
  tagExistsRemotely(tag: string): Promise<boolean>;
  remoteUrl(remote: string): Promise<string>;
  createAnnotatedTag(tag: string, message: string): Promise<void>;
  pushTag(tag: string): Promise<void>;
}

async function runGit(spawn: typeof Bun.spawn, args: readonly string[], cwd: string | undefined): Promise<string> {
  const proc = spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${(stderr || stdout).trim()}`);
  }
  return stdout;
}

/** The real {@link GitPort}, over `Bun.spawn`. `cwd` defaults to
 * `process.cwd()`'s ambient default (i.e. whatever `Bun.spawn` itself
 * defaults to when `cwd` is `undefined`) — pass it explicitly only when
 * running from outside the repo root. */
export function createBunGitPort(deps: { spawn?: typeof Bun.spawn; cwd?: string } = {}): GitPort {
  const spawn = deps.spawn ?? Bun.spawn;
  const cwd = deps.cwd;

  return {
    async statusPorcelain() {
      return await runGit(spawn, ["status", "--porcelain"], cwd);
    },
    async currentBranch() {
      return (await runGit(spawn, ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    },
    async fetchOrigin() {
      await runGit(spawn, ["fetch", "origin", "main"], cwd);
    },
    async revParse(ref: string) {
      return (await runGit(spawn, ["rev-parse", ref], cwd)).trim();
    },
    async tagExistsLocally(tag: string) {
      return (await runGit(spawn, ["tag", "-l", tag], cwd)).trim() === tag;
    },
    async tagExistsRemotely(tag: string) {
      return (await runGit(spawn, ["ls-remote", "--tags", "origin", tag], cwd)).trim().length > 0;
    },
    async remoteUrl(remote: string) {
      return (await runGit(spawn, ["remote", "get-url", remote], cwd)).trim();
    },
    async createAnnotatedTag(tag: string, message: string) {
      await runGit(spawn, ["tag", "-a", tag, "-m", message], cwd);
    },
    async pushTag(tag: string) {
      await runGit(spawn, ["push", "origin", tag], cwd);
    },
  };
}

/* ------------------------------------------------------------------ */
/* GitHubPort — the injectable seam over the GitHub REST API            */
/* ------------------------------------------------------------------ */

/** {@link GitHubPort.createDraftRelease}'s return shape. */
export interface CreatedGitHubRelease {
  readonly id: number;
  /** Upload base URL with the `{?name,label}` URI-template suffix already
   * stripped — ready to have `?name=<file>` appended directly. */
  readonly uploadUrl: string;
  readonly htmlUrl: string;
}

/** Every GitHub Release API operation this script needs, injectable for
 * the same reason {@link GitPort} is. */
export interface GitHubPort {
  /** `GET /releases?per_page=100` — deliberately NOT `GET /releases/tags/
   * {tag}`, which does not reliably return draft releases (this module's
   * TSDoc, `scripts/githubRelease.ts`'s TSDoc). */
  listReleases(): Promise<readonly GitHubReleaseSummary[]>;
  createDraftRelease(tag: string, name: string, body: string): Promise<CreatedGitHubRelease>;
  uploadAsset(uploadUrl: string, fileName: string, data: Uint8Array): Promise<void>;
  /** The release's current asset file names — used with
   * {@link checkAssetsComplete} to confirm both macOS assets actually
   * landed before moving on to the tag. */
  getReleaseAssetNames(releaseId: number): Promise<readonly string[]>;
}

/** Dependencies for {@link createGitHubPort}. */
export interface GitHubPortDeps {
  token: string;
  owner: string;
  repo: string;
  /** Overrides the fetch seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

/** The real {@link GitHubPort}, over `fetch` and the GitHub REST API. */
export function createGitHubPort(deps: GitHubPortDeps): GitHubPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${deps.owner}/${deps.repo}`;
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${deps.token}`,
    Accept: "application/vnd.github+json",
  };

  async function listReleases(): Promise<readonly GitHubReleaseSummary[]> {
    const res = await fetchImpl(`${base}/releases?per_page=100`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`GET /releases failed: ${res.status} ${await readErrorBody(res)}`);
    }
    const data = (await res.json()) as Array<{ id: number; tag_name: string; draft: boolean }>;
    return data.map((r) => ({ id: r.id, tag_name: r.tag_name, draft: r.draft }));
  }

  async function createDraftRelease(tag: string, name: string, body: string): Promise<CreatedGitHubRelease> {
    const res = await fetchImpl(`${base}/releases`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name, body, draft: true }),
    });
    if (!res.ok) {
      throw new Error(`POST /releases failed: ${res.status} ${await readErrorBody(res)}`);
    }
    const data = (await res.json()) as { id: number; upload_url: string; html_url: string };
    return { id: data.id, uploadUrl: data.upload_url.split("{")[0]!, htmlUrl: data.html_url };
  }

  async function uploadAsset(uploadUrl: string, fileName: string, data: Uint8Array): Promise<void> {
    const res = await fetchImpl(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/octet-stream" },
      body: data,
    });
    if (!res.ok) {
      throw new Error(`asset upload for ${fileName} failed: ${res.status} ${await readErrorBody(res)}`);
    }
  }

  async function getReleaseAssetNames(releaseId: number): Promise<readonly string[]> {
    const res = await fetchImpl(`${base}/releases/${releaseId}`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`GET /releases/${releaseId} failed: ${res.status} ${await readErrorBody(res)}`);
    }
    const data = (await res.json()) as { assets: Array<{ name: string }> };
    return data.assets.map((a) => a.name);
  }

  return { listReleases, createDraftRelease, uploadAsset, getReleaseAssetNames };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function safe<T>(fn: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

/**
 * Impure companion to {@link evaluatePreflight}: makes every `git`/GitHub
 * call the eight checks need, wrapping each in {@link safe} so one failed
 * call cannot prevent the other checks from being evaluated (task
 * requirement: "every check runs"). Tag-dependent checks (7–8) are only
 * actually queried when the version itself is well-formed — asking "does
 * tag NaN exist" is meaningless, so those default to values that make
 * {@link evaluatePreflight} report them as skipped instead of issuing a
 * nonsensical query.
 */
export async function gatherPreflightInputs(
  deps: {
    platform: string;
    arch: string;
    env: Readonly<Record<string, string | undefined>>;
    git: Pick<GitPort, "statusPorcelain" | "currentBranch" | "fetchOrigin" | "revParse" | "tagExistsLocally" | "tagExistsRemotely">;
    github: Pick<GitHubPort, "listReleases">;
  },
  rawVersion: string,
): Promise<PreflightInputs> {
  const [workingTreeStatus, currentBranch] = await Promise.all([
    safe(() => deps.git.statusPorcelain()),
    safe(() => deps.git.currentBranch()),
  ]);

  // "fetch first" (task requirement) — best-effort; a failed fetch surfaces
  // through remoteMainSha below (a stale/missing origin/main ref), not as
  // its own separate check.
  await safe(() => deps.git.fetchOrigin());

  const [localMainSha, remoteMainSha] = await Promise.all([
    safe(() => deps.git.revParse("main")),
    safe(() => deps.git.revParse("origin/main")),
  ]);

  const version = normalizeVersionArg(rawVersion);
  let tagExistsLocally: Fetched<boolean> = { ok: true, value: false };
  let tagExistsRemotely: Fetched<boolean> = { ok: true, value: false };
  let existingReleases: Fetched<readonly GitHubReleaseSummary[]> = { ok: true, value: [] };
  if (version.ok) {
    [tagExistsLocally, tagExistsRemotely, existingReleases] = await Promise.all([
      safe(() => deps.git.tagExistsLocally(version.tag)),
      safe(() => deps.git.tagExistsRemotely(version.tag)),
      safe(() => deps.github.listReleases()),
    ]);
  }

  return {
    platform: deps.platform,
    arch: deps.arch,
    env: deps.env,
    rawVersion,
    workingTreeStatus,
    currentBranch,
    localMainSha,
    remoteMainSha,
    tagExistsLocally,
    tagExistsRemotely,
    existingReleases,
  };
}

/** Every outcome {@link createTagReleaseRunner}'s `run` can resolve to —
 * one variant per stage this module's TSDoc numbers, plus the failure
 * modes within steps 3–4. Exhaustive and tagged so a caller (or a test)
 * can `switch` on `stage` without a default case. */
export type TagReleaseOutcome =
  | { readonly stage: "preflight-failed"; readonly preflight: PreflightEvaluation }
  | { readonly stage: "build-failed"; readonly buildOutcome: BuildOutcome }
  | { readonly stage: "checksum-failed"; readonly error: string }
  | { readonly stage: "release-create-failed"; readonly error: string }
  | { readonly stage: "upload-failed"; readonly releaseId: number; readonly releaseUrl: string; readonly error: string }
  | {
      readonly stage: "completeness-check-failed";
      readonly releaseId: number;
      readonly releaseUrl: string;
      readonly missing: readonly string[];
    }
  | {
      readonly stage: "tag-create-failed";
      readonly releaseId: number;
      readonly releaseUrl: string;
      readonly tag: string;
      readonly error: string;
    }
  | {
      readonly stage: "tag-push-failed";
      readonly releaseId: number;
      readonly releaseUrl: string;
      readonly tag: string;
      readonly error: string;
    }
  | { readonly stage: "done"; readonly tag: string; readonly releaseUrl: string };

/** Dependencies for {@link createTagReleaseRunner}. Every field that
 * touches the network, `git`, the filesystem, or produces output is
 * injectable and Pick<>-narrowed to exactly what `run` calls — the house
 * convention this codebase's other `createX(deps)` factories follow
 * (`packages/core/src/ui/hostErrorSink.ts`'s `HostErrorStatusSinkDeps`,
 * among others). */
export interface TagReleaseDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  git: Pick<
    GitPort,
    "statusPorcelain" | "currentBranch" | "fetchOrigin" | "revParse" | "tagExistsLocally" | "tagExistsRemotely" | "createAnnotatedTag" | "pushTag"
  >;
  github: Pick<GitHubPort, "listReleases" | "createDraftRelease" | "uploadAsset" | "getReleaseAssetNames">;
  /** Reused from `scripts/release.ts` — never reimplemented here (task
   * constraint: "reuse, don't duplicate"). Injectable so tests substitute
   * a fake build instead of a real ~110 MB compile. */
  buildTarget: (target: ReleaseTarget, options?: BuildTargetOptions) => Promise<BuildOutcome>;
  /** Also reused from `scripts/release.ts`. */
  writeChecksumFile: (target: ReleaseTarget, options?: ChecksumOptions) => Promise<string>;
  /** Reads a built asset's raw bytes for upload. Defaults to
   * `Bun.file(path).bytes()`. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Produces the GitHub Release body text. Defaults to reading
   * `docs/release-notes-template.md` (the same file `.circleci/
   * config.yml`'s `publish` job used to read before this change — now
   * read here instead, since this script is what creates the release). */
  readReleaseNotes?: () => Promise<string>;
  /** Directory {@link LOCAL_TARGET}'s binary/checksum are written to and
   * read back from. Defaults to `"dist"`. */
  distDir?: string;
  /** Working directory for both the build and the dist-relative reads.
   * Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Injectable line-oriented log sinks — default to `console.log`/
   * `console.error`. Tests inject their own to assert on output without
   * printing during `bun test`. */
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/** {@link createTagReleaseRunner}'s return shape. */
export interface TagReleaseRunner {
  run(rawVersion: string): Promise<TagReleaseOutcome>;
}

/**
 * Build the `bun run tag <version>` orchestrator (this module's TSDoc for
 * the full 4-step flow and why the order is fixed). `run` performs
 * exactly one attempt: preflight (all 8 checks), then — only if every one
 * passed — build, draft release + upload + completeness check, then
 * create + push the tag, stopping at (and reporting recovery guidance
 * for) the first mutating step that fails.
 */
export function createTagReleaseRunner(deps: TagReleaseDeps): TagReleaseRunner {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const distDir = deps.distDir ?? "dist";
  const repoRoot = deps.repoRoot ?? process.cwd();
  const log = deps.log ?? ((message: string) => console.log(message));
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const readFile = deps.readFile ?? (async (path: string) => await Bun.file(path).bytes());
  const readReleaseNotes =
    deps.readReleaseNotes ?? (async () => await Bun.file(resolve(repoRoot, "docs/release-notes-template.md")).text());

  async function run(rawVersion: string): Promise<TagReleaseOutcome> {
    const inputs = await gatherPreflightInputs({ platform, arch, env, git: deps.git, github: deps.github }, rawVersion);
    const preflight = evaluatePreflight(inputs);
    for (const c of preflight.checks) {
      log(c.ok ? `tag: [ok]   ${c.name}` : `tag: [FAIL] ${c.name} — ${c.message}`);
    }
    if (!preflight.ok) {
      logError("tag: preflight failed — nothing was built, released, or tagged. Fix the issue(s) above and re-run.");
      return { stage: "preflight-failed", preflight };
    }
    const tag = preflight.tag!;
    log(`tag: preflight passed for ${tag}`);

    // Step 2: build. Most likely step to fail (a real compile on real
    // hardware) — runs first, before anything external exists to clean up.
    log(`tag: building ${LOCAL_TARGET.bunTarget}...`);
    const buildOutcome = await deps.buildTarget(LOCAL_TARGET, { distDir, repoRoot });
    if (buildOutcome.status !== "ok") {
      const detail =
        buildOutcome.status === "oversized"
          ? `over size budget (${formatBytesAsMB(buildOutcome.sizeBytes!)})`
          : `build failed (exit ${buildOutcome.exitCode}): ${buildOutcome.reason}`;
      logError(`tag: ${LOCAL_TARGET.bunTarget} — FAILED, ${detail}. Nothing was released or tagged.`);
      return { stage: "build-failed", buildOutcome };
    }
    log(`tag: ${LOCAL_TARGET.bunTarget} — OK, ${formatBytesAsMB(buildOutcome.sizeBytes!)}`);

    try {
      await deps.writeChecksumFile(LOCAL_TARGET, { distDir, repoRoot });
    } catch (cause) {
      const error = describeError(cause);
      logError(`tag: failed to write the checksum — ${error}. Nothing was released or tagged.`);
      return { stage: "checksum-failed", error };
    }

    const binaryName = binaryFileName(LOCAL_TARGET);
    const checksumName = `${binaryName}.sha256`;

    // Step 3: draft release + upload + completeness check.
    let created: CreatedGitHubRelease;
    try {
      const notes = await readReleaseNotes();
      created = await deps.github.createDraftRelease(tag, `tecode ${tag}`, notes);
    } catch (cause) {
      const error = describeError(cause);
      logError(
        `tag: failed to create the draft GitHub release — ${error}. Nothing was released or tagged; the built binary is still in ${distDir}/.`,
      );
      return { stage: "release-create-failed", error };
    }
    log(`tag: created draft release ${created.htmlUrl} (id ${created.id})`);

    try {
      for (const name of [binaryName, checksumName]) {
        const bytes = await readFile(resolve(repoRoot, distDir, name));
        log(`tag: uploading ${name}...`);
        await deps.github.uploadAsset(created.uploadUrl, name, bytes);
      }
    } catch (cause) {
      const error = describeError(cause);
      logError(`tag: asset upload failed — ${error}.`);
      logError(
        `tag: RECOVERY — a draft release was created but may not have every asset: ${created.htmlUrl} (id ${created.id}). Delete it (GitHub UI, or DELETE /repos/.../releases/${created.id}) and re-run \`bun run tag ${tag}\` once fixed. No tag was created or pushed.`,
      );
      return { stage: "upload-failed", releaseId: created.id, releaseUrl: created.htmlUrl, error };
    }

    try {
      const assetNames = await deps.github.getReleaseAssetNames(created.id);
      const completeness = checkAssetsComplete(assetNames, [binaryName, checksumName]);
      if (!completeness.ok) {
        logError(`tag: draft release is missing asset(s): ${completeness.missing.join(", ")}.`);
        logError(
          `tag: RECOVERY — delete the draft release ${created.htmlUrl} (id ${created.id}) and re-run \`bun run tag ${tag}\`. No tag was created or pushed.`,
        );
        return { stage: "completeness-check-failed", releaseId: created.id, releaseUrl: created.htmlUrl, missing: completeness.missing };
      }
    } catch (cause) {
      const error = describeError(cause);
      logError(`tag: could not verify the draft release's assets — ${error}.`);
      logError(
        `tag: RECOVERY — check ${created.htmlUrl} (id ${created.id}) by hand; delete it and re-run \`bun run tag ${tag}\` if it is incomplete. No tag was created or pushed.`,
      );
      return { stage: "upload-failed", releaseId: created.id, releaseUrl: created.htmlUrl, error };
    }
    log(`tag: draft release ${created.htmlUrl} has both macOS assets`);

    // Step 4: create + push the tag — LAST, because it is irreversible
    // (pushing fires CircleCI immediately) while everything above is not
    // (a draft release can simply be deleted).
    try {
      await deps.git.createAnnotatedTag(tag, `tecode ${tag}`);
    } catch (cause) {
      const error = describeError(cause);
      logError(`tag: failed to create the local git tag ${tag} — ${error}.`);
      logError(
        `tag: RECOVERY — the draft release ${created.htmlUrl} (id ${created.id}) is ready and waiting. Either delete it, or once fixed create and push the tag by hand: git tag -a ${tag} -m "tecode ${tag}" && git push origin ${tag}`,
      );
      return { stage: "tag-create-failed", releaseId: created.id, releaseUrl: created.htmlUrl, tag, error };
    }

    try {
      await deps.git.pushTag(tag);
    } catch (cause) {
      const error = describeError(cause);
      logError(`tag: created local tag ${tag} but failed to push it — ${error}.`);
      logError(
        `tag: RECOVERY — the draft release ${created.htmlUrl} (id ${created.id}) is ready. Push the tag by hand to fire CircleCI: git push origin ${tag}\n(Or, to abandon this attempt: git tag -d ${tag}, and delete the draft release.)`,
      );
      return { stage: "tag-push-failed", releaseId: created.id, releaseUrl: created.htmlUrl, tag, error };
    }

    log(`tag: pushed ${tag} — CircleCI will build the remaining 3 targets and publish ${created.htmlUrl}.`);
    return { stage: "done", tag, releaseUrl: created.htmlUrl };
  }

  return { run };
}

/* ------------------------------------------------------------------ */
/* CLI entry point                                                     */
/* ------------------------------------------------------------------ */

async function main(argv: string[]): Promise<void> {
  const rawVersion = argv[0];
  if (!rawVersion) {
    console.error("usage: bun run tag <version>   (e.g. bun run tag v1.2.3)");
    process.exit(1);
    return;
  }

  const git = createBunGitPort();
  const remoteUrl = await git.remoteUrl("origin");
  const parsedRemote = parseGitHubRemote(remoteUrl);
  if (!parsedRemote) {
    console.error(`tag: could not parse a GitHub owner/repo out of origin's remote URL: "${remoteUrl}"`);
    process.exit(1);
    return;
  }

  // No fallback to GITHUB_TOKEN or any other variable — see
  // checkReleaseTokenSet's own TSDoc for why. An unset TECODE_RELEASE_TOKEN
  // reaches the GitHub API as an empty bearer token, which simply fails
  // authentication; checkReleaseTokenSet's own preflight check is what
  // reports this specific, actionable ("export TECODE_RELEASE_TOKEN=...")
  // message before anything mutating runs.
  const github = createGitHubPort({
    token: process.env.TECODE_RELEASE_TOKEN ?? "",
    owner: parsedRemote.owner,
    repo: parsedRemote.repo,
  });
  const runner = createTagReleaseRunner({ git, github, buildTarget, writeChecksumFile });
  const outcome = await runner.run(rawVersion);
  process.exit(outcome.stage === "done" ? 0 : 1);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error("tag: failed:", cause);
    process.exit(1);
  });
}
