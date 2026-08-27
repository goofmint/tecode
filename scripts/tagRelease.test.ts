/**
 * Unit tests for `scripts/tagRelease.ts` — `bun run tag`'s pure decision
 * logic (version normalization, all 8 preflight checks, and
 * {@link evaluatePreflight}'s composition of them) plus, via hand-rolled
 * fakes for {@link GitPort}/{@link GitHubPort}/`buildTarget`/
 * `writeChecksumFile`, the orchestrator's own sequencing: a failing
 * preflight check mutates nothing, and a build failure happens before any
 * release is created and before any tag is pushed (this task's own
 * completion requirements). No mocking library — every fake below is a
 * plain object recording calls into an array the test asserts on
 * afterward, matching this codebase's house convention.
 */

import { describe, expect, test } from "bun:test";
import type { BuildOutcome, ReleaseTarget } from "./release";
import {
  checkReleaseTokenSet,
  checkHostIsMacSilicon,
  checkMainUpToDateWithOrigin,
  checkNoExistingRelease,
  checkOnMainBranch,
  checkTagNotTaken,
  checkWorkingTreeClean,
  createTagReleaseRunner,
  evaluatePreflight,
  gatherPreflightInputs,
  LOCAL_TARGET,
  normalizeVersionArg,
  type Fetched,
  type GitHubPort,
  type GitPort,
  type PreflightInputs,
  type TagReleaseDeps,
} from "./tagRelease";
import type { GitHubReleaseSummary } from "./githubRelease";

/* -------------------------------------------------------------------- */
/* normalizeVersionArg                                                   */
/* -------------------------------------------------------------------- */

describe("normalizeVersionArg", () => {
  test("accepts a bare version and prefixes it with v", () => {
    expect(normalizeVersionArg("1.2.3")).toEqual({ ok: true, tag: "v1.2.3" });
  });

  test("accepts an already-v-prefixed version unchanged", () => {
    expect(normalizeVersionArg("v1.2.3")).toEqual({ ok: true, tag: "v1.2.3" });
  });

  test("accepts a prerelease/build-metadata suffix (+, -, . all allowed)", () => {
    expect(normalizeVersionArg("v1.2.3-rc.1+build.7")).toEqual({ ok: true, tag: "v1.2.3-rc.1+build.7" });
  });

  test("rejects an empty string", () => {
    const result = normalizeVersionArg("");
    expect(result.ok).toBe(false);
  });

  test("rejects whitespace-only input", () => {
    const result = normalizeVersionArg("   ");
    expect(result.ok).toBe(false);
  });

  test("rejects a version containing a character outside [0-9A-Za-z.+-] after the v", () => {
    const result = normalizeVersionArg("v1.2.3!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("v1.2.3!");
  });

  test("rejects a version containing a space", () => {
    expect(normalizeVersionArg("v1.2 .3").ok).toBe(false);
  });

  test("rejects a bare 'v' with nothing after it", () => {
    expect(normalizeVersionArg("v").ok).toBe(false);
  });

  test("rejects a slash (path-traversal-shaped ref)", () => {
    expect(normalizeVersionArg("v1/2/3").ok).toBe(false);
  });

  test("trims surrounding whitespace before validating", () => {
    expect(normalizeVersionArg("  v1.2.3  ")).toEqual({ ok: true, tag: "v1.2.3" });
  });
});

/* -------------------------------------------------------------------- */
/* Individual preflight checks                                          */
/* -------------------------------------------------------------------- */

function ok<T>(value: T): Fetched<T> {
  return { ok: true, value };
}
function err<T>(error: string): Fetched<T> {
  return { ok: false, error };
}

describe("checkHostIsMacSilicon", () => {
  test("passes on darwin/arm64", () => {
    expect(checkHostIsMacSilicon("darwin", "arm64").ok).toBe(true);
  });
  test("fails on darwin/x64 (Intel Mac) with a specific message", () => {
    const result = checkHostIsMacSilicon("darwin", "x64");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("darwin/x64");
    expect(result.message).toContain("Apple Silicon");
  });
  test("fails on linux/x64", () => {
    expect(checkHostIsMacSilicon("linux", "x64").ok).toBe(false);
  });
});

describe("checkReleaseTokenSet", () => {
  test("passes when TECODE_RELEASE_TOKEN is a non-empty string", () => {
    expect(checkReleaseTokenSet({ TECODE_RELEASE_TOKEN: "github_pat_abc123" }).ok).toBe(true);
  });
  test("fails when TECODE_RELEASE_TOKEN is unset", () => {
    expect(checkReleaseTokenSet({}).ok).toBe(false);
  });
  test("fails when TECODE_RELEASE_TOKEN is an empty string", () => {
    expect(checkReleaseTokenSet({ TECODE_RELEASE_TOKEN: "" }).ok).toBe(false);
  });
  test("fails when TECODE_RELEASE_TOKEN is whitespace-only", () => {
    expect(checkReleaseTokenSet({ TECODE_RELEASE_TOKEN: "   " }).ok).toBe(false);
  });
  test("does NOT fall back to GITHUB_TOKEN when TECODE_RELEASE_TOKEN is unset", () => {
    expect(checkReleaseTokenSet({ GITHUB_TOKEN: "ghp_some_broad_ambient_token" }).ok).toBe(false);
  });
});

describe("checkWorkingTreeClean", () => {
  test("passes when git status --porcelain is empty", () => {
    expect(checkWorkingTreeClean(ok("")).ok).toBe(true);
  });
  test("fails when there is uncommitted output, and includes it in the message", () => {
    const result = checkWorkingTreeClean(ok(" M scripts/tagRelease.ts\n"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scripts/tagRelease.ts");
  });
  test("fails when the underlying git call itself failed", () => {
    const result = checkWorkingTreeClean(err("git not found"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("git not found");
  });
});

describe("checkOnMainBranch", () => {
  test("passes on main", () => {
    expect(checkOnMainBranch(ok("main")).ok).toBe(true);
  });
  test("fails on a feature branch, naming it", () => {
    const result = checkOnMainBranch(ok("feature/local-macos-tag-release"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("feature/local-macos-tag-release");
  });
});

describe("checkMainUpToDateWithOrigin", () => {
  test("passes when local and remote SHAs match", () => {
    expect(checkMainUpToDateWithOrigin(ok("abc123"), ok("abc123")).ok).toBe(true);
  });
  test("fails when they differ", () => {
    const result = checkMainUpToDateWithOrigin(ok("abc123"), ok("def456"));
    expect(result.ok).toBe(false);
  });
  test("fails when fetching origin/main itself failed", () => {
    const result = checkMainUpToDateWithOrigin(ok("abc123"), err("network unreachable"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("network unreachable");
  });
});

describe("checkTagNotTaken", () => {
  test("passes when the tag exists neither locally nor remotely", () => {
    expect(checkTagNotTaken("v1.0.0", ok(false), ok(false)).ok).toBe(true);
  });
  test("fails when the tag exists locally", () => {
    const result = checkTagNotTaken("v1.0.0", ok(true), ok(false));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("locally");
  });
  test("fails when the tag exists on origin", () => {
    const result = checkTagNotTaken("v1.0.0", ok(false), ok(true));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("origin");
  });
});

describe("checkNoExistingRelease", () => {
  test("passes when no release matches the tag", () => {
    expect(checkNoExistingRelease("v1.0.0", ok([])).ok).toBe(true);
  });
  test("fails when a draft release already carries the tag", () => {
    const releases: GitHubReleaseSummary[] = [{ id: 7, tag_name: "v1.0.0", draft: true }];
    const result = checkNoExistingRelease("v1.0.0", ok(releases));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("draft");
  });
  test("fails when a published release already carries the tag", () => {
    const releases: GitHubReleaseSummary[] = [{ id: 7, tag_name: "v1.0.0", draft: false }];
    const result = checkNoExistingRelease("v1.0.0", ok(releases));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("published");
  });
});

/* -------------------------------------------------------------------- */
/* evaluatePreflight — composition                                      */
/* -------------------------------------------------------------------- */

function allGoodInputs(overrides: Partial<PreflightInputs> = {}): PreflightInputs {
  return {
    platform: "darwin",
    arch: "arm64",
    env: { TECODE_RELEASE_TOKEN: "github_pat_x" },
    rawVersion: "v1.2.3",
    workingTreeStatus: ok(""),
    currentBranch: ok("main"),
    localMainSha: ok("aaa"),
    remoteMainSha: ok("aaa"),
    tagExistsLocally: ok(false),
    tagExistsRemotely: ok(false),
    existingReleases: ok([]),
    ...overrides,
  };
}

describe("evaluatePreflight", () => {
  test("passes when every input is clean, and returns the normalized tag", () => {
    const result = evaluatePreflight(allGoodInputs());
    expect(result.ok).toBe(true);
    expect(result.tag).toBe("v1.2.3");
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  test("fails overall when exactly one check fails, but still runs (reports) all 8", () => {
    const result = evaluatePreflight(allGoodInputs({ currentBranch: ok("feature/x") }));
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(8);
    const failing = result.checks.filter((c) => !c.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.name).toBe("current branch is main");
  });

  test("reports every failing check at once when multiple checks fail (not just the first)", () => {
    const result = evaluatePreflight(
      allGoodInputs({
        platform: "linux",
        currentBranch: ok("dev"),
        workingTreeStatus: ok(" M foo.ts"),
      }),
    );
    expect(result.ok).toBe(false);
    const failingNames = result.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failingNames).toEqual(
      expect.arrayContaining(["host is darwin/arm64", "current branch is main", "git working tree is clean"]),
    );
    expect(failingNames.length).toBeGreaterThanOrEqual(3);
  });

  test("an invalid version fails overall and marks the two tag-dependent checks as skipped, not silently omitted", () => {
    const result = evaluatePreflight(allGoodInputs({ rawVersion: "not a version" }));
    expect(result.ok).toBe(false);
    expect(result.tag).toBeUndefined();
    expect(result.checks).toHaveLength(8);
    const tagCheck = result.checks.find((c) => c.name === "tag does not already exist")!;
    const releaseCheck = result.checks.find((c) => c.name === "no GitHub release exists for this version")!;
    expect(tagCheck.ok).toBe(false);
    expect(tagCheck.message).toContain("skipped");
    expect(releaseCheck.ok).toBe(false);
    expect(releaseCheck.message).toContain("skipped");
  });

  test("every check fails together when every input is bad", () => {
    const result = evaluatePreflight({
      platform: "linux",
      arch: "x64",
      env: {},
      rawVersion: "bad version!",
      workingTreeStatus: ok(" M x"),
      currentBranch: ok("dev"),
      localMainSha: ok("aaa"),
      remoteMainSha: ok("bbb"),
      tagExistsLocally: ok(true),
      tagExistsRemotely: ok(true),
      existingReleases: ok([{ id: 1, tag_name: "v1.2.3", draft: false }]),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
  });
});

/* -------------------------------------------------------------------- */
/* gatherPreflightInputs — one flaky fetch does not hide the rest        */
/* -------------------------------------------------------------------- */

describe("gatherPreflightInputs", () => {
  function fakeGit(overrides: Partial<GitPort> = {}): Pick<
    GitPort,
    "statusPorcelain" | "currentBranch" | "fetchOrigin" | "revParse" | "tagExistsLocally" | "tagExistsRemotely"
  > {
    return {
      statusPorcelain: async () => "",
      currentBranch: async () => "main",
      fetchOrigin: async () => {},
      revParse: async (ref: string) => (ref === "main" ? "sha-local" : "sha-remote"),
      tagExistsLocally: async () => false,
      tagExistsRemotely: async () => false,
      ...overrides,
    };
  }
  function fakeGithub(overrides: Partial<Pick<GitHubPort, "listReleases">> = {}): Pick<GitHubPort, "listReleases"> {
    return { listReleases: async () => [], ...overrides };
  }

  test("wires every field through on the happy path", async () => {
    const inputs = await gatherPreflightInputs(
      { platform: "darwin", arch: "arm64", env: { TECODE_RELEASE_TOKEN: "t" }, git: fakeGit(), github: fakeGithub() },
      "v1.0.0",
    );
    expect(inputs.workingTreeStatus).toEqual({ ok: true, value: "" });
    expect(inputs.currentBranch).toEqual({ ok: true, value: "main" });
    expect(inputs.localMainSha).toEqual({ ok: true, value: "sha-local" });
    expect(inputs.remoteMainSha).toEqual({ ok: true, value: "sha-remote" });
    expect(inputs.tagExistsLocally).toEqual({ ok: true, value: false });
    expect(inputs.tagExistsRemotely).toEqual({ ok: true, value: false });
    expect(inputs.existingReleases).toEqual({ ok: true, value: [] });
  });

  test("a failing git call becomes a Fetched error, not a thrown exception, and other fields still resolve", async () => {
    const inputs = await gatherPreflightInputs(
      {
        platform: "darwin",
        arch: "arm64",
        env: {},
        git: fakeGit({ statusPorcelain: async () => { throw new Error("git status exploded"); } }),
        github: fakeGithub(),
      },
      "v1.0.0",
    );
    expect(inputs.workingTreeStatus).toEqual({ ok: false, error: "git status exploded" });
    // Everything else still resolved normally.
    expect(inputs.currentBranch).toEqual({ ok: true, value: "main" });
  });

  test("skips querying tag existence / releases when the version is malformed", async () => {
    let releasesCalled = false;
    let tagLocalCalled = false;
    const inputs = await gatherPreflightInputs(
      {
        platform: "darwin",
        arch: "arm64",
        env: {},
        git: fakeGit({
          tagExistsLocally: async () => {
            tagLocalCalled = true;
            return false;
          },
        }),
        github: fakeGithub({
          listReleases: async () => {
            releasesCalled = true;
            return [];
          },
        }),
      },
      "not-a-valid-version!",
    );
    expect(releasesCalled).toBe(false);
    expect(tagLocalCalled).toBe(false);
    expect(inputs.existingReleases).toEqual({ ok: true, value: [] });
    expect(inputs.tagExistsLocally).toEqual({ ok: true, value: false });
  });
});

/* -------------------------------------------------------------------- */
/* createTagReleaseRunner — orchestration / sequencing                  */
/* -------------------------------------------------------------------- */

/** Records every call made to it, in order, as a flat string — the
 * house "hand-rolled fake, no mocking library" convention. Every test
 * below asserts on this call log directly rather than on a mock
 * framework's spy API. */
function makeCallLog(): { calls: string[]; push: (entry: string) => void } {
  const calls: string[] = [];
  return { calls, push: (entry: string) => calls.push(entry) };
}

function goodGit(log: { push: (s: string) => void }): Pick<
  GitPort,
  "statusPorcelain" | "currentBranch" | "fetchOrigin" | "revParse" | "tagExistsLocally" | "tagExistsRemotely" | "createAnnotatedTag" | "pushTag"
> {
  return {
    statusPorcelain: async () => "",
    currentBranch: async () => "main",
    fetchOrigin: async () => {
      log.push("git.fetchOrigin");
    },
    revParse: async (ref: string) => (ref === "main" ? "sha1" : "sha1"),
    tagExistsLocally: async () => false,
    tagExistsRemotely: async () => false,
    createAnnotatedTag: async (tag: string) => {
      log.push(`git.createAnnotatedTag(${tag})`);
    },
    pushTag: async (tag: string) => {
      log.push(`git.pushTag(${tag})`);
    },
  };
}

function goodGithub(
  log: { push: (s: string) => void },
  overrides: Partial<Pick<GitHubPort, "listReleases" | "createDraftRelease" | "uploadAsset" | "getReleaseAssetNames">> = {},
): Pick<GitHubPort, "listReleases" | "createDraftRelease" | "uploadAsset" | "getReleaseAssetNames"> {
  return {
    listReleases: async () => [],
    createDraftRelease: async (tag: string) => {
      log.push(`github.createDraftRelease(${tag})`);
      return { id: 99, uploadUrl: "https://uploads.example/99", htmlUrl: "https://example/releases/99" };
    },
    uploadAsset: async (_url: string, name: string) => {
      log.push(`github.uploadAsset(${name})`);
    },
    getReleaseAssetNames: async () => ["tecode-darwin-arm64", "tecode-darwin-arm64.sha256"],
    ...overrides,
  };
}

const OK_BUILD_OUTCOME: BuildOutcome = { target: LOCAL_TARGET, status: "ok", sizeBytes: 1234 };

function baseDeps(log: { push: (s: string) => void }, overrides: Partial<TagReleaseDeps> = {}): TagReleaseDeps {
  return {
    platform: "darwin",
    arch: "arm64",
    env: { TECODE_RELEASE_TOKEN: "github_pat_x" },
    git: goodGit(log),
    github: goodGithub(log),
    buildTarget: async (target: ReleaseTarget) => {
      log.push(`buildTarget(${target.bunTarget})`);
      return OK_BUILD_OUTCOME;
    },
    writeChecksumFile: async (target: ReleaseTarget) => {
      log.push(`writeChecksumFile(${target.bunTarget})`);
      return "/dist/tecode-darwin-arm64.sha256";
    },
    readFile: async (path: string) => {
      log.push(`readFile(${path})`);
      return new TextEncoder().encode("fake-bytes");
    },
    readReleaseNotes: async () => "notes",
    log: () => {},
    logError: () => {},
    ...overrides,
  };
}

describe("createTagReleaseRunner — happy path", () => {
  test("runs every step in order: preflight, build, checksum, release, 2 uploads, completeness, tag, push", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(baseDeps(log));
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("done");
    if (outcome.stage === "done") {
      expect(outcome.tag).toBe("v1.2.3");
      expect(outcome.releaseUrl).toBe("https://example/releases/99");
    }

    expect(log.calls).toEqual([
      "git.fetchOrigin",
      "buildTarget(bun-darwin-arm64)",
      "writeChecksumFile(bun-darwin-arm64)",
      "github.createDraftRelease(v1.2.3)",
      "readFile(/dist-root/dist/tecode-darwin-arm64)".replace("/dist-root", process.cwd()),
      "github.uploadAsset(tecode-darwin-arm64)",
      "readFile(/dist-root/dist/tecode-darwin-arm64.sha256)".replace("/dist-root", process.cwd()),
      "github.uploadAsset(tecode-darwin-arm64.sha256)",
      "git.createAnnotatedTag(v1.2.3)",
      "git.pushTag(v1.2.3)",
    ]);
  });
});

describe("createTagReleaseRunner — a failing preflight check mutates nothing", () => {
  test("wrong host: build/release/tag are never called", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(baseDeps(log, { platform: "linux", arch: "x64" }));
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("preflight-failed");
    expect(log.calls).toEqual(["git.fetchOrigin"]); // fetch is a harmless preflight read; nothing MUTATING ran
  });

  test("dirty working tree: build/release/tag are never called", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(
      baseDeps(log, { git: { ...goodGit(log), statusPorcelain: async () => " M dirty.ts\n" } }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("preflight-failed");
    expect(log.calls).toEqual(["git.fetchOrigin"]);
  });

  test("malformed version: build/release/tag are never called, and no git/github tag-existence calls happen either", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(baseDeps(log));
    const outcome = await runner.run("not a version");

    expect(outcome.stage).toBe("preflight-failed");
    expect(log.calls).toEqual(["git.fetchOrigin"]);
  });

  test("tag already exists on origin: build/release/tag are never called", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(
      baseDeps(log, { git: { ...goodGit(log), tagExistsRemotely: async () => true } }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("preflight-failed");
    expect(log.calls).toEqual(["git.fetchOrigin"]);
  });

  test("a GitHub release already exists for this tag: build/release/tag are never called", async () => {
    const log = makeCallLog();
    const existing: GitHubReleaseSummary[] = [{ id: 1, tag_name: "v1.2.3", draft: true }];
    const runner = createTagReleaseRunner(
      baseDeps(log, { github: goodGithub(log, { listReleases: async () => existing }) }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("preflight-failed");
    expect(log.calls).toEqual(["git.fetchOrigin"]);
  });
});

describe("createTagReleaseRunner — a build failure happens before any release or tag", () => {
  test("build-failed status: no release created, no checksum written, no tag pushed", async () => {
    const log = makeCallLog();
    const failedOutcome: BuildOutcome = {
      target: LOCAL_TARGET,
      status: "build-failed",
      reason: "simulated compile failure",
      exitCode: 1,
    };
    const runner = createTagReleaseRunner(
      baseDeps(log, {
        buildTarget: async (target: ReleaseTarget) => {
          log.push(`buildTarget(${target.bunTarget})`);
          return failedOutcome;
        },
      }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("build-failed");
    if (outcome.stage === "build-failed") {
      expect(outcome.buildOutcome.reason).toBe("simulated compile failure");
    }
    // Build ran, but nothing after it did.
    expect(log.calls).toEqual(["git.fetchOrigin", "buildTarget(bun-darwin-arm64)"]);
  });

  test("oversized build: no release created, no tag pushed", async () => {
    const log = makeCallLog();
    const oversized: BuildOutcome = { target: LOCAL_TARGET, status: "oversized", sizeBytes: 999_999_999 };
    const runner = createTagReleaseRunner(
      baseDeps(log, { buildTarget: async () => oversized }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("build-failed");
    expect(log.calls).not.toContain("github.createDraftRelease(v1.2.3)");
    expect(log.calls).not.toContain("git.pushTag(v1.2.3)");
  });
});

describe("createTagReleaseRunner — step 3 succeeds, step 4 fails: recovery is reported, nothing extra mutated", () => {
  test("tag creation fails after the draft release exists: no push happens, error surfaces the release for cleanup", async () => {
    const log = makeCallLog();
    const errorMessages: string[] = [];
    const runner = createTagReleaseRunner(
      baseDeps(log, {
        git: { ...goodGit(log), createAnnotatedTag: async () => { throw new Error("disk full"); } },
        logError: (m: string) => errorMessages.push(m),
      }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("tag-create-failed");
    if (outcome.stage === "tag-create-failed") {
      expect(outcome.releaseUrl).toBe("https://example/releases/99");
      expect(outcome.error).toContain("disk full");
    }
    expect(log.calls).not.toContain("git.pushTag(v1.2.3)");
    expect(errorMessages.some((m) => m.includes("RECOVERY") && m.includes("https://example/releases/99"))).toBe(true);
  });

  test("tag push fails after the local tag was created: recovery names the exact push command and the release", async () => {
    const log = makeCallLog();
    const errorMessages: string[] = [];
    const runner = createTagReleaseRunner(
      baseDeps(log, {
        git: { ...goodGit(log), pushTag: async () => { throw new Error("remote rejected"); } },
        logError: (m: string) => errorMessages.push(m),
      }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("tag-push-failed");
    if (outcome.stage === "tag-push-failed") {
      expect(outcome.error).toContain("remote rejected");
    }
    // The local tag WAS created (that part of step 4 succeeded).
    expect(log.calls).toContain("git.createAnnotatedTag(v1.2.3)");
    expect(
      errorMessages.some(
        (m) => m.includes("RECOVERY") && m.includes("git push origin v1.2.3") && m.includes("https://example/releases/99"),
      ),
    ).toBe(true);
  });
});

describe("createTagReleaseRunner — upload / completeness failures never reach step 4", () => {
  test("a mid-loop upload failure aborts before any tag is created or pushed", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(
      baseDeps(log, {
        github: goodGithub(log, {
          uploadAsset: async (_url: string, name: string) => {
            log.push(`github.uploadAsset(${name})`);
            throw new Error("upload 500");
          },
        }),
      }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("upload-failed");
    expect(log.calls).not.toContain("git.createAnnotatedTag(v1.2.3)");
    expect(log.calls).not.toContain("git.pushTag(v1.2.3)");
  });

  test("an incomplete release at the completeness check aborts before any tag is created or pushed", async () => {
    const log = makeCallLog();
    const runner = createTagReleaseRunner(
      baseDeps(log, {
        github: goodGithub(log, { getReleaseAssetNames: async () => ["tecode-darwin-arm64"] }), // .sha256 missing
      }),
    );
    const outcome = await runner.run("v1.2.3");

    expect(outcome.stage).toBe("completeness-check-failed");
    if (outcome.stage === "completeness-check-failed") {
      expect(outcome.missing).toEqual(["tecode-darwin-arm64.sha256"]);
    }
    expect(log.calls).not.toContain("git.createAnnotatedTag(v1.2.3)");
    expect(log.calls).not.toContain("git.pushTag(v1.2.3)");
  });
});

describe("LOCAL_TARGET", () => {
  test("is the RELEASE_TARGETS entry with builtBy 'local' (bun-darwin-arm64)", () => {
    expect(LOCAL_TARGET.bunTarget).toBe("bun-darwin-arm64");
    expect(LOCAL_TARGET.builtBy).toBe("local");
  });
});
