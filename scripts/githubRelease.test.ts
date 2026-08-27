/**
 * Unit tests for {@link githubRelease.ts}'s pure GitHub-Release selection
 * and completeness logic — see that module's own TSDoc for why this exists
 * as a separately-tested spec even though `.circleci/config.yml`'s
 * `publish` job re-implements the same algorithm in bash (which has no
 * import statement to reach these functions with).
 */

import { describe, expect, test } from "bun:test";
import {
  checkAssetsComplete,
  findDraftReleaseByTag,
  findReleaseByTag,
  parseGitHubRemote,
  type GitHubReleaseSummary,
} from "./githubRelease";

const RELEASES: readonly GitHubReleaseSummary[] = [
  { id: 1, tag_name: "v0.9.0", draft: false },
  { id: 2, tag_name: "v1.0.0", draft: true },
  { id: 3, tag_name: "v1.0.0-rc1", draft: false },
];

describe("findReleaseByTag", () => {
  test("finds a published release by exact tag_name", () => {
    expect(findReleaseByTag(RELEASES, "v0.9.0")).toEqual({ id: 1, tag_name: "v0.9.0", draft: false });
  });

  test("finds a draft release by exact tag_name too — draft or published, either counts", () => {
    expect(findReleaseByTag(RELEASES, "v1.0.0")).toEqual({ id: 2, tag_name: "v1.0.0", draft: true });
  });

  test("returns undefined when no release matches the tag", () => {
    expect(findReleaseByTag(RELEASES, "v2.0.0")).toBeUndefined();
  });

  test("does not match on a substring/prefix of the tag", () => {
    // v1.0.0-rc1 exists, but v1.0.0 must not match it - exact string only.
    expect(findReleaseByTag([{ id: 9, tag_name: "v1.0.0-rc1", draft: false }], "v1.0.0")).toBeUndefined();
  });

  test("empty release list never matches", () => {
    expect(findReleaseByTag([], "v1.0.0")).toBeUndefined();
  });
});

describe("findDraftReleaseByTag (what CircleCI's publish job selects)", () => {
  test("finds the draft matching the tag", () => {
    expect(findDraftReleaseByTag(RELEASES, "v1.0.0")).toEqual({ id: 2, tag_name: "v1.0.0", draft: true });
  });

  test("does NOT return a published release sharing the tag", () => {
    expect(findDraftReleaseByTag(RELEASES, "v0.9.0")).toBeUndefined();
  });

  test("returns undefined when the tag has no release at all — the 'tag pushed without bun run tag' case", () => {
    expect(findDraftReleaseByTag(RELEASES, "v3.0.0")).toBeUndefined();
  });

  test("returns undefined for a tag whose only release is published, not draft", () => {
    expect(findDraftReleaseByTag(RELEASES, "v1.0.0-rc1")).toBeUndefined();
  });
});

describe("checkAssetsComplete", () => {
  const expectedFour = ["tecode-darwin-arm64", "tecode-darwin-arm64.sha256", "tecode-linux-x64", "tecode-linux-x64.sha256"];

  test("ok when every expected asset is present, in any order", () => {
    const result = checkAssetsComplete(
      ["tecode-linux-x64.sha256", "tecode-darwin-arm64", "tecode-linux-x64", "tecode-darwin-arm64.sha256"],
      expectedFour,
    );
    expect(result).toEqual({ ok: true, missing: [] });
  });

  test("ok when actual has MORE than expected — extra assets are never flagged", () => {
    const result = checkAssetsComplete([...expectedFour, "some-other-file.txt"], expectedFour);
    expect(result.ok).toBe(true);
  });

  test("reports exactly which names are missing, in expected order", () => {
    const result = checkAssetsComplete(["tecode-darwin-arm64", "tecode-darwin-arm64.sha256"], expectedFour);
    expect(result).toEqual({ ok: false, missing: ["tecode-linux-x64", "tecode-linux-x64.sha256"] });
  });

  test("a matching COUNT with the wrong names still fails — count alone is not enough", () => {
    // Same count (4) as expectedFour, but two different files instead of
    // tecode-linux-x64/.sha256 - the bug a naive count-only check misses.
    const result = checkAssetsComplete(
      ["tecode-darwin-arm64", "tecode-darwin-arm64.sha256", "tecode-windows-x64.exe", "tecode-windows-x64.exe.sha256"],
      expectedFour,
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["tecode-linux-x64", "tecode-linux-x64.sha256"]);
  });

  test("empty expected list is trivially complete", () => {
    expect(checkAssetsComplete([], [])).toEqual({ ok: true, missing: [] });
  });

  test("empty actual list against a non-empty expected list is fully missing", () => {
    expect(checkAssetsComplete([], ["a", "b"])).toEqual({ ok: false, missing: ["a", "b"] });
  });
});

describe("parseGitHubRemote", () => {
  test("parses an HTTPS remote URL with .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/goofmint/tecode.git")).toEqual({
      owner: "goofmint",
      repo: "tecode",
    });
  });

  test("parses an HTTPS remote URL without .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/goofmint/tecode")).toEqual({
      owner: "goofmint",
      repo: "tecode",
    });
  });

  test("parses an SSH remote URL with .git suffix", () => {
    expect(parseGitHubRemote("git@github.com:goofmint/tecode.git")).toEqual({
      owner: "goofmint",
      repo: "tecode",
    });
  });

  test("parses an SSH remote URL without .git suffix", () => {
    expect(parseGitHubRemote("git@github.com:goofmint/tecode")).toEqual({
      owner: "goofmint",
      repo: "tecode",
    });
  });

  test("tolerates surrounding whitespace (e.g. trailing newline from `git remote get-url`)", () => {
    expect(parseGitHubRemote("https://github.com/goofmint/tecode.git\n")).toEqual({
      owner: "goofmint",
      repo: "tecode",
    });
  });

  test("returns undefined for a non-GitHub remote", () => {
    expect(parseGitHubRemote("https://gitlab.com/goofmint/tecode.git")).toBeUndefined();
  });

  test("returns undefined for a malformed URL", () => {
    expect(parseGitHubRemote("not a url at all")).toBeUndefined();
  });
});
