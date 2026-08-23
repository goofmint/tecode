/**
 * Tests for {@link parseGitignore} (Task 3.3, Req 11.2) — the glob-fallback
 * `.gitignore` matcher `ignore.ts` uses when no `git` CLI is available.
 * Full pattern coverage (anchors, `**`, negation, dir patterns) is this
 * task's own completion requirement.
 */

import { describe, expect, test } from "bun:test";
import { parseGitignore } from "./gitignoreMatcher";

describe("parseGitignore (Task 3.3, Req 11.2)", () => {
  test("a bare pattern with no slash matches the basename at any depth", () => {
    const matcher = parseGitignore("*.log");
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
    expect(matcher.isIgnored("nested/deep/debug.log", false)).toBe(true);
    expect(matcher.isIgnored("debug.txt", false)).toBe(false);
  });

  test("a leading-slash pattern is anchored to the root only", () => {
    const matcher = parseGitignore("/build");
    expect(matcher.isIgnored("build", true)).toBe(true);
    expect(matcher.isIgnored("nested/build", true)).toBe(false);
  });

  test("a pattern with a slash in the middle is anchored to the root, no leading slash needed", () => {
    const matcher = parseGitignore("src/generated");
    expect(matcher.isIgnored("src/generated", true)).toBe(true);
    expect(matcher.isIgnored("other/src/generated", true)).toBe(false);
  });

  test("trailing slash makes a pattern directory-only", () => {
    const matcher = parseGitignore("dist/");
    expect(matcher.isIgnored("dist", true)).toBe(true);
    expect(matcher.isIgnored("dist", false)).toBe(false);
  });

  test("* does not cross a path separator", () => {
    const matcher = parseGitignore("/src/*.ts");
    expect(matcher.isIgnored("src/index.ts", false)).toBe(true);
    expect(matcher.isIgnored("src/nested/index.ts", false)).toBe(false);
  });

  test("? is not a wildcard — it matches only a literal '?', never crossing to an unrelated character", () => {
    const matcher = parseGitignore("foo?.log");
    expect(matcher.isIgnored("foo?.log", false)).toBe(true);
    expect(matcher.isIgnored("fo.log", false)).toBe(false);
    expect(matcher.isIgnored("fooX.log", false)).toBe(false);
  });

  test("** matches across path separators", () => {
    const matcher = parseGitignore("**/*.log");
    expect(matcher.isIgnored("a/b/c/debug.log", false)).toBe(true);
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
  });

  test("a trailing /** matches everything inside a directory but not the directory itself", () => {
    const matcher = parseGitignore("build/**");
    expect(matcher.isIgnored("build/output.js", false)).toBe(true);
    expect(matcher.isIgnored("build/nested/output.js", false)).toBe(true);
    expect(matcher.isIgnored("build", true)).toBe(false);
  });

  test("a /**/ in the middle matches zero or more intervening directories", () => {
    const matcher = parseGitignore("a/**/b");
    expect(matcher.isIgnored("a/b", false)).toBe(true);
    expect(matcher.isIgnored("a/x/b", false)).toBe(true);
    expect(matcher.isIgnored("a/x/y/b", false)).toBe(true);
    expect(matcher.isIgnored("a/c", false)).toBe(false);
  });

  test("negation un-ignores a later, more specific match", () => {
    const matcher = parseGitignore("*.log\n!important.log");
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
    expect(matcher.isIgnored("important.log", false)).toBe(false);
  });

  test("a later plain pattern re-ignores after an earlier negation (last match wins)", () => {
    const matcher = parseGitignore("!*.log\n*.log");
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
  });

  test("comments and blank lines are ignored", () => {
    const matcher = parseGitignore("# a comment\n\n*.log\n   \n");
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
    expect(matcher.isIgnored("# a comment", false)).toBe(false);
  });

  test("an escaped leading # is treated as a literal pattern character, not a comment", () => {
    const matcher = parseGitignore("\\#important");
    expect(matcher.isIgnored("#important", false)).toBe(true);
  });

  test("no patterns at all (empty file) ignores nothing", () => {
    const matcher = parseGitignore("");
    expect(matcher.isIgnored("anything.ts", false)).toBe(false);
  });

  test("multiple independent patterns all apply", () => {
    const matcher = parseGitignore("node_modules/\n*.log\n/dist");
    expect(matcher.isIgnored("node_modules", true)).toBe(true);
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
    expect(matcher.isIgnored("dist", true)).toBe(true);
    expect(matcher.isIgnored("src/index.ts", false)).toBe(false);
  });

  test("a pathological line (lone '!' or '/') does not throw and matches nothing", () => {
    expect(() => parseGitignore("!\n/\n*.log")).not.toThrow();
    const matcher = parseGitignore("!\n/\n*.log");
    expect(matcher.isIgnored("debug.log", false)).toBe(true);
  });
});
