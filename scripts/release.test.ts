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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  binaryFileName,
  buildTarget,
  classifyBuildFailure,
  computeChecksumLine,
  formatBytesAsMB,
  formatChecksumLine,
  parseTargetFilter,
  RELEASE_TARGETS,
  sha256Hex,
  SIZE_LIMIT_BYTES,
  writeChecksumFile,
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

describe("buildTarget's --outfile / stat path parity (Finding 5)", () => {
  // Deliberately does NOT run a real `bun build --compile` (this file's own
  // TSDoc) — a hand-rolled fake `spawn` (this codebase's `GitRunner`/
  // `ConfigServiceFs`-style injectable-seam convention, per `buildTarget`'s
  // own `BuildTargetOptions.spawn` TSDoc) stands in for it, capturing the
  // exact `--outfile` argument the real command would have received and
  // writing a small real file there — enough to prove `buildTarget`'s own
  // later `stat` call looks in the SAME place, with no real compile needed.
  test("resolves the SAME absolute path for both --outfile and the size stat when distDir is already absolute", async () => {
    const target = RELEASE_TARGETS.find((t) => t.bunTarget === "bun-linux-x64")!;
    const absoluteDistDir = await mkdtemp(resolve(tmpdir(), "release-test-dist-"));
    const repoRoot = "/some/unrelated/repo/root"; // never actually read from — proves distDir wins outright.
    let capturedOutfile: string | undefined;

    try {
      const fakeSpawn = ((opts: { cmd: readonly string[] }) => {
        const outfileFlagIndex = opts.cmd.indexOf("--outfile");
        capturedOutfile = opts.cmd[outfileFlagIndex + 1];
        // Simulate `bun build --compile` itself having already written the
        // binary at --outfile by the time it exits, synchronously, before
        // this fake "process" object is even returned — buildTarget only
        // stats AFTER awaiting `exited`.
        void writeFile(capturedOutfile!, "fake-compiled-binary-bytes");
        return {
          stdout: null,
          stderr: "",
          exited: Promise.resolve(0),
        };
      }) as unknown as typeof Bun.spawn;

      const outcome = await buildTarget(target, {
        distDir: absoluteDistDir,
        repoRoot,
        spawn: fakeSpawn,
      });

      const expectedOutfile = resolve(absoluteDistDir, binaryFileName(target));
      expect(capturedOutfile).toBe(expectedOutfile);
      // "ok" (not a thrown ENOENT) is the proof: `stat` found the file at
      // exactly the path the fake "build" wrote it to.
      expect(outcome.status).toBe("ok");
      expect(outcome.sizeBytes).toBe("fake-compiled-binary-bytes".length);
    } finally {
      await rm(absoluteDistDir, { recursive: true, force: true });
    }
  });
});

describe("sha256Hex (Issue #38's checksum publishing)", () => {
  test("matches the well-known SHA-256 digest of a fixed, injected input", () => {
    // Known-good vectors (NIST/RFC test vectors, also reproducible via a
    // real `sha256sum`/`shasum -a 256` — no real build artifact needed,
    // exactly this task's own "unit-test it against injected fixed input"
    // requirement) — proves this codebase's use of `Bun.CryptoHasher`
    // produces the SAME digest every real `sha256sum -c` verification
    // against a shipped binary would expect.
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("formatChecksumLine (sha256sum/shasum -a 256 compatible output)", () => {
  test("renders <hex><TWO spaces><filename>\\n — the binary-mode marker both tools require", () => {
    const line = formatChecksumLine("deadbeef", "tecode-linux-x64");
    expect(line).toBe("deadbeef  tecode-linux-x64\n");
    // Spelled out explicitly so a future accidental single-space
    // regression fails loudly rather than needing the reader to count
    // spaces in the string literal above.
    expect(line.split("tecode-linux-x64")[0]).toBe("deadbeef  ");
  });

  test("uses only binaryFileName's bare output, never a path", () => {
    const target = RELEASE_TARGETS.find((t) => t.bunTarget === "bun-windows-arm64")!;
    const line = formatChecksumLine("cafebabe", binaryFileName(target));
    expect(line).toBe("cafebabe  tecode-windows-arm64.exe\n");
  });
});

describe("computeChecksumLine (injectable seam, no real build)", () => {
  test("feeds the injected readBytes output through the injected hash function, keyed off binaryFileName", async () => {
    const target = RELEASE_TARGETS.find((t) => t.bunTarget === "bun-darwin-arm64")!;
    const seenPaths: string[] = [];
    const seenBytes: Uint8Array[] = [];
    const fixedBytes = new TextEncoder().encode("fixed-injected-binary-content");

    const line = await computeChecksumLine(target, {
      distDir: "dist",
      repoRoot: "/repo",
      readBytes: async (path) => {
        seenPaths.push(path);
        return fixedBytes;
      },
      hash: (data) => {
        seenBytes.push(data);
        return "0123456789abcdef";
      },
    });

    expect(seenPaths).toEqual([resolve("/repo", "dist", binaryFileName(target))]);
    expect(seenBytes).toEqual([fixedBytes]);
    expect(line).toBe(`0123456789abcdef  ${binaryFileName(target)}\n`);
  });

  test("defaults to the real sha256Hex when no hash function is injected", async () => {
    const target = RELEASE_TARGETS.find((t) => t.bunTarget === "bun-linux-x64")!;
    const line = await computeChecksumLine(target, {
      distDir: "dist",
      repoRoot: "/repo",
      readBytes: async () => new TextEncoder().encode("abc"),
    });
    expect(line).toBe(
      `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${binaryFileName(target)}\n`,
    );
  });
});

describe("writeChecksumFile (the actual <binaryFileName>.sha256 sibling)", () => {
  test("writes the checksum line to <binaryFileName>.sha256 next to where the binary itself would be", async () => {
    const target = RELEASE_TARGETS.find((t) => t.bunTarget === "bun-linux-x64")!;
    const distDir = await mkdtemp(resolve(tmpdir(), "release-test-checksum-"));

    try {
      const checksumPath = await writeChecksumFile(target, {
        distDir,
        repoRoot: "/unused-since-distDir-is-already-absolute",
        readBytes: async () => new TextEncoder().encode("abc"),
      });

      expect(checksumPath).toBe(resolve(distDir, `${binaryFileName(target)}.sha256`));
      const written = await readFile(checksumPath, "utf8");
      expect(written).toBe(
        `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  ${binaryFileName(target)}\n`,
      );
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });
});
