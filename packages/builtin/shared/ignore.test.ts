/**
 * Tests for {@link createDefaultIgnorer} (Task 3.2, Req 11.3) — the interim
 * ignore stub `walkFiles.ts` uses by default (see `ignore.ts`'s TSDoc for
 * why this is intentionally minimal ahead of Task 3.3's real one).
 */

import { describe, expect, test } from "bun:test";
import { createDefaultIgnorer } from "./ignore";

describe("createDefaultIgnorer (Task 3.2, Req 11.3)", () => {
  test("excludes .git and node_modules directories", () => {
    const ignore = createDefaultIgnorer();
    expect(ignore(".git", true)).toBe(true);
    expect(ignore("node_modules", true)).toBe(true);
    expect(ignore(".hg", true)).toBe(true);
    expect(ignore(".svn", true)).toBe(true);
  });

  test("does not exclude an ordinary source directory or file", () => {
    const ignore = createDefaultIgnorer();
    expect(ignore("src", true)).toBe(false);
    expect(ignore("packages", true)).toBe(false);
    expect(ignore("index.ts", false)).toBe(false);
  });

  test("never excludes a FILE named like an ignored directory (dirs-only rule)", () => {
    const ignore = createDefaultIgnorer();
    expect(ignore(".git", false)).toBe(false);
    expect(ignore("node_modules", false)).toBe(false);
  });
});
