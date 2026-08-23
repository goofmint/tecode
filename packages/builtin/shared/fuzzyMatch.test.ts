/**
 * Scoring-table tests for {@link fuzzyMatch} (Task 3.2, Req 11.3;
 * design.md §13, tasks.md's "Tests: matcher scoring table"): proves the
 * exact > prefix > word-boundary subsequence > scattered subsequence
 * ranking, the consecutive-run/word-boundary bonuses within a tier, the
 * "no subsequence at all" no-match case, case-insensitivity, and
 * determinism.
 */

import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "./fuzzyMatch";

describe("fuzzyMatch (Task 3.2, Req 11.3)", () => {
  test("no match when query's characters are not a subsequence of candidate", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeUndefined();
    expect(fuzzyMatch("cab", "abc")).toBeUndefined(); // right letters, wrong order
  });

  test("empty query matches everything with a neutral score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0 });
    expect(fuzzyMatch("", "")).toEqual({ score: 0 });
  });

  test("exact match outranks every other tier", () => {
    const exact = fuzzyMatch("commit", "commit")!;
    const prefix = fuzzyMatch("commit", "commit.ts")!;
    const wordBoundary = fuzzyMatch("gtc", "Go To Commit")!;
    const scattered = fuzzyMatch("cmt", "co_amount")!;
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(exact.score).toBeGreaterThan(wordBoundary.score);
    expect(exact.score).toBeGreaterThan(scattered.score);
  });

  test("exact match is case-insensitive", () => {
    const exact = fuzzyMatch("Commit", "commit")!;
    const otherExact = fuzzyMatch("commit", "COMMIT")!;
    expect(exact).toBeDefined();
    expect(otherExact).toBeDefined();
    expect(exact.score).toBe(otherExact.score);
  });

  test("prefix match outranks word-boundary and scattered", () => {
    const prefix = fuzzyMatch("git", "git.status.ts")!;
    const wordBoundary = fuzzyMatch("gst", "Go to Symbol Table")!;
    const scattered = fuzzyMatch("gst", "loGging_sysTem")!;
    expect(prefix).toBeDefined();
    expect(prefix.score).toBeGreaterThan(wordBoundary.score);
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  test("prefix match is case-insensitive", () => {
    const prefix = fuzzyMatch("GIT", "git.status.ts")!;
    expect(prefix).toBeDefined();
    expect(prefix.score).toBeGreaterThan(0);
  });

  test("word-boundary subsequence (acronym-style) outranks a scattered match", () => {
    // "gsw" as the first letter of each word — a pure boundary/acronym match.
    const wordBoundary = fuzzyMatch("gsw", "Go to Symbol in Workspace")!;
    // "gsw" scattered through a single word with no boundary alignment.
    const scattered = fuzzyMatch("gsw", "logsWriter")!;
    expect(wordBoundary).toBeDefined();
    expect(scattered).toBeDefined();
    expect(wordBoundary.score).toBeGreaterThan(scattered.score);
  });

  test("within the scattered tier, a run anchored at a word boundary outranks an equally consecutive run that isn't", () => {
    // "app" matches consecutively right after the "-" boundary before "App".
    const boundaryAnchored = fuzzyMatch("app", "My-App-Service")!;
    // The same 3-character consecutive run, but starting mid-word with no
    // boundary anywhere near it.
    const plainConsecutive = fuzzyMatch("app", "xxapp")!;
    expect(boundaryAnchored).toBeDefined();
    expect(plainConsecutive).toBeDefined();
    expect(boundaryAnchored.score).toBeGreaterThan(plainConsecutive.score);
  });

  test("within the scattered tier, a consecutive run outranks characters spread apart", () => {
    const consecutive = fuzzyMatch("app", "xxapp")!; // "app" consecutive
    const spread = fuzzyMatch("app", "xxaxxpxxp")!; // same letters, spread out
    expect(consecutive).toBeDefined();
    expect(spread).toBeDefined();
    expect(consecutive.score).toBeGreaterThan(spread.score);
  });

  test("within a tier, an earlier match start outranks a later one", () => {
    // Neither is a prefix or boundary match (both start with "w"/no
    // boundaries near the run) — both land in the scattered tier, so this
    // isolates the start-position tie-breaker specifically.
    const early = fuzzyMatch("foo", "wfoobar")!;
    const late = fuzzyMatch("foo", "wwwwwfoobar")!;
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    expect(early.score).toBeGreaterThan(late.score);
  });

  test("is deterministic: the same inputs always produce the same score", () => {
    const a = fuzzyMatch("qkp", "quickPick.ts");
    const b = fuzzyMatch("qkp", "quickPick.ts");
    expect(a).toEqual(b);
  });

  test("full ranking table sorts a mixed candidate list into the documented tier order", () => {
    const query = "qp";
    const candidates = [
      "scattered_qXp_here", // scattered
      "Quick Pick", // word-boundary (Q, P start words)
      "qp-exact", // does not equal query, but starts with it -> prefix
      "qp", // exact
    ];
    const ranked = candidates
      .map((candidate) => ({ candidate, result: fuzzyMatch(query, candidate) }))
      .filter((r): r is { candidate: string; result: { score: number } } => r.result !== undefined)
      .sort((a, b) => b.result.score - a.result.score)
      .map((r) => r.candidate);

    expect(ranked).toEqual(["qp", "qp-exact", "Quick Pick", "scattered_qXp_here"]);
  });
});
