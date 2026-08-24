/**
 * Unit tests for {@link release.ts}'s pure helpers (Req 8.5, 13.2,
 * design.md §17). Deliberately does NOT invoke a real `bun build --compile`
 * — that takes real wall-clock time, produces a real ~110 MB file, and (per
 * this module's own TSDoc, Finding 2) fails outright for 5 of 6 targets on
 * any single-platform machine, none of which belongs in the always-on `bun
 * test` suite. {@link buildTarget} itself is exercised for real instead by
 * this task's manual validation step (`bun run release bun-linux-x64`,
 * recorded in the PR) and by `packages/cli/src/compiledBinary.smoke.test.ts`
 * consuming its output — this suite covers only the logic that decides
 * WHICH targets to build, WHAT to name their output, and HOW to classify a
 * failure, all of which is cheap and deterministic to test directly.
 */

import { describe, expect, test } from "bun:test";
import {
  binaryFileName,
  classifyBuildFailure,
  formatBytesAsMB,
  parseTargetFilter,
  RELEASE_TARGETS,
  SIZE_LIMIT_BYTES,
  type ReleaseTarget,
} from "./release";

describe("RELEASE_TARGETS (Req 13.2's darwin/linux/windows × x64/arm64)", () => {
  test("has exactly the 6 required platform/arch combinations", () => {
    expect(RELEASE_TARGETS).toHaveLength(6);
    const platforms = new Set(RELEASE_TARGETS.map((t) => t.platform));
    const archs = new Set(RELEASE_TARGETS.map((t) => t.arch));
    expect([...platforms].sort()).toEqual(["darwin", "linux", "windows"]);
    expect([...archs].sort()).toEqual(["arm64", "x64"]);
    // Every platform × arch pairing is present exactly once.
    for (const platform of platforms) {
      for (const arch of archs) {
        expect(RELEASE_TARGETS.filter((t) => t.platform === platform && t.arch === arch)).toHaveLength(1);
      }
    }
  });

  test("bunTarget strings match Bun's own bun-<platform>-<arch> naming", () => {
    for (const target of RELEASE_TARGETS) {
      expect(target.bunTarget).toBe(`bun-${target.platform}-${target.arch}`);
    }
  });
});

describe("SIZE_LIMIT_BYTES (Req 13.2's 120 MB budget)", () => {
  test("uses the stricter decimal-MB reading, not the binary MiB one", () => {
    expect(SIZE_LIMIT_BYTES).toBe(120_000_000);
    // The measured bun-linux-x64 size this task recorded (114,968,726
    // bytes) must stay under this budget — regression guard for the exact
    // number this script's TSDoc cites.
    expect(114_968_726).toBeLessThan(SIZE_LIMIT_BYTES);
  });
});

describe("binaryFileName", () => {
  test("appends .exe only for windows targets", () => {
    expect(binaryFileName({ bunTarget: "bun-linux-x64", platform: "linux", arch: "x64" })).toBe(
      "tecode-linux-x64",
    );
    expect(binaryFileName({ bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64" })).toBe(
      "tecode-darwin-arm64",
    );
    expect(binaryFileName({ bunTarget: "bun-windows-x64", platform: "windows", arch: "x64" })).toBe(
      "tecode-windows-x64.exe",
    );
  });
});

describe("formatBytesAsMB", () => {
  test("renders a fixed 2-decimal decimal-MB string", () => {
    expect(formatBytesAsMB(120_000_000)).toBe("120.00 MB");
    expect(formatBytesAsMB(114_968_726)).toBe("114.97 MB");
  });
});

describe("classifyBuildFailure (Finding 2's cross-compile limitation)", () => {
  test("recognizes @opentui/core's unresolvable platform-package error for any platform/arch", () => {
    const stderr = [
      '  at .../@opentui/core/index-mw2x3082.js:11979',
      '      var module = await import(`@opentui/core-${process.platform}-${process.arch}/index.ts`);',
      'error: Could not resolve: "@opentui/core-darwin-arm64/index.ts". Maybe you need to "bun install"?',
    ].join("\n");
    const reason = classifyBuildFailure(stderr);
    expect(reason).toBeDefined();
    expect(reason).toContain("known limitation");
    expect(reason).toContain("this host");
  });

  test("recognizes the windows variant of the same signature", () => {
    const stderr = 'error: Could not resolve: "@opentui/core-win32-x64/index.ts". Maybe you need to "bun install"?';
    expect(classifyBuildFailure(stderr)).toBeDefined();
  });

  test("returns undefined for an unrelated build failure", () => {
    expect(classifyBuildFailure("error: SyntaxError: Unexpected token in main.ts")).toBeUndefined();
    expect(classifyBuildFailure("")).toBeUndefined();
  });
});

describe("parseTargetFilter", () => {
  test("with no arguments, defaults to all 6 targets", () => {
    const { targets, unknown } = parseTargetFilter([]);
    expect(targets).toEqual([...RELEASE_TARGETS]);
    expect(unknown).toEqual([]);
  });

  test("with one target name, builds only that one (the CI-runner shape)", () => {
    const { targets, unknown } = parseTargetFilter(["bun-linux-x64"]);
    expect(targets.map((t: ReleaseTarget) => t.bunTarget)).toEqual(["bun-linux-x64"]);
    expect(unknown).toEqual([]);
  });

  test("with multiple target names, builds exactly those, in RELEASE_TARGETS order matching input order", () => {
    const { targets } = parseTargetFilter(["bun-windows-x64", "bun-darwin-x64"]);
    expect(targets.map((t: ReleaseTarget) => t.bunTarget)).toEqual(["bun-windows-x64", "bun-darwin-x64"]);
  });

  test("an unrecognized target name is reported in unknown, not silently dropped", () => {
    const { targets, unknown } = parseTargetFilter(["bun-linux-x64", "bun-solaris-sparc"]);
    expect(targets.map((t: ReleaseTarget) => t.bunTarget)).toEqual(["bun-linux-x64"]);
    expect(unknown).toEqual(["bun-solaris-sparc"]);
  });
});
