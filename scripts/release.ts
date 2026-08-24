/**
 * Drives the compiled-binary release matrix (Issue #35 "4.4 Compiled binary
 * builds"; Req 8.5, 13.2; design.md §17: "Release: `bun build --compile` per
 * target (darwin/linux/windows × x64/arm64) from `cli`... A `scripts/
 * release.ts` drives the 6-target matrix and size assertions.").
 *
 * Usage: `bun run release [target ...]` — with no arguments, attempts all
 * six {@link RELEASE_TARGETS}; with one or more `bun build --target=...`
 * names (e.g. `bun run release bun-linux-x64`), builds only those. This is
 * what lets a single-platform CI runner build just its own target (below).
 *
 * ## Why there is no extra bundler config for embedding
 *
 * Req 8.5 asks for theme JSON, grammar WASMs, `highlights.scm` queries, and
 * `keybindings.fallback.json` to be embedded in the compiled binary. All
 * four are already embedded as an ordinary consequence of how
 * `packages/cli/src/main.ts` and its dependencies are written — `bun build
 * --compile` walks every static `import` reachable from the entry point and
 * inlines the ones tagged with Bun's asset loaders, so this script does not
 * (and should not) pass any additional bundler flags or config to make that
 * happen:
 *
 * - **Grammar WASMs and `.scm` queries**: `packages/builtin/languages-basic/
 *   assets.ts` imports each grammar with `with { type: "file" }` (embeds the
 *   raw bytes, binds the import to a `/$bunfs/...` virtual path once
 *   compiled) and each query with `with { type: "text" }` (embeds the
 *   decoded UTF-8 string directly as a JS literal). `packages/cli/src/
 *   languageAssetsFs.ts` overlays `@tecode/core`'s asset-resolver filesystem
 *   seam with these two maps, so a `languages-basic` language's `grammar`/
 *   `highlights` path resolves from the embedded map in BOTH `bun run` and a
 *   compiled binary, with no `fs.readFile` ever attempted against a
 *   synthetic `<builtin>/...` directory that doesn't exist on disk. This is
 *   exactly the asset-URI indirection Task 2.8 established — the SAME code
 *   path (`AssetResolver` + `AssetResolverFs`) resolves both embedded and
 *   real on-disk assets; only the `fs` passed to `createAssetResolver`
 *   differs, and that overlay always falls back to a real
 *   `node:fs/promises` read for anything not in the embedded map (a `user`/
 *   `workspace` language extension's real grammar/query files).
 * - **Theme JSON**: `packages/builtin/themes-default/assets.ts` follows the
 *   identical shape for its two theme JSON files (statically imported,
 *   re-serialized to text at module-eval time), overlaid the same way by
 *   `packages/cli/src/themeAssetsFs.ts`.
 * - **`web-tree-sitter`'s own runtime WASM**: distinct from any grammar's
 *   `.wasm` — needed by `Parser.init()` itself, before any grammar loads.
 *   `main.ts` imports it directly (`import treeSitterRuntimeWasmPath from
 *   "web-tree-sitter/tree-sitter.wasm" with { type: "file" }`) and hands
 *   `Bun.file(treeSitterRuntimeWasmPath).bytes()` to the parser backend as
 *   `runtimeWasm`, so `Parser.init()` never touches a real filesystem path
 *   for it either.
 * - **`keybindings.fallback.json`**: `packages/core/src/keymap/
 *   fallbackKeybindings.ts` statically `import`s it directly (no asset-
 *   resolver overlay needed — that module has no generic, path-joining
 *   loader to intercept, unlike the theme/language registries). Bun embeds
 *   a statically-imported JSON module's contents into the compiled binary
 *   regardless of which package does the importing, so this achieves
 *   "shipped in the binary" with zero extra machinery — the SAME loader
 *   also checks `~/.config/tecode/keybindings.fallback.json` first, so a
 *   user override still works identically in a compiled binary.
 *
 * Empirically verified for this task (see the completion-requirements
 * section of this issue's PR description for the full transcript): a
 * `bun-linux-x64` compiled binary, run against a fresh temp `HOME` with
 * `TECODE_HEADLESS=1` and a workspace containing a `.ts` file, printed
 * `{"event":"tecode.headlessExit","loaded":7,"skipped":0}` with a first
 * frame around 30ms and exactly 0 bytes on stderr — no `tree-sitter.wasm`
 * ENOENT, no Emscripten abort. Nothing about embedded-asset resolution
 * needed fixing for this task; {@link RELEASE_TARGETS}/{@link buildTarget}
 * below exist purely to drive the matrix and assert the size budget.
 *
 * ## Why this machine cannot produce all six binaries
 *
 * `@opentui/core` ships six platform-specific optional dependencies
 * (`@opentui/core-{darwin,linux,win32}-{x64,arm64}`), each carrying `os`/
 * `cpu` package.json fields. `node_modules` links only the one matching the
 * HOST platform Bun installed on (`@opentui/core-linux-x64` on this
 * machine) — `bun install` refuses to link a foreign-platform optional
 * dependency, and explicitly `bun add`ing one (verified for this task) still
 * does not make it link. `@opentui/core`'s own runtime code resolves its
 * native half with `import(\`@opentui/core-${process.platform}-${process.arch}/index.ts\`)`,
 * a TEMPLATE-STRING dynamic import Bun's bundler cannot statically resolve
 * for any platform other than the host's — so `bun build --compile
 * --target=bun-darwin-arm64` (or any non-host target) fails with:
 *
 * ```
 * error: Could not resolve: "@opentui/core-darwin-arm64/index.ts". Maybe you need to "bun install"?
 * ```
 *
 * This is a property of `@opentui/core`'s packaging, not a bug in this
 * codebase — there is no bundler flag or asset-embedding trick available
 * here that fixes it. {@link classifyBuildFailure} below recognizes this
 * exact failure signature and reports it distinctly from a genuine build
 * break, so a CI matrix runner building its own native target (where this
 * limitation never triggers — see below) is never confused with a real
 * regression, and a human reading this script's output on a single machine
 * understands immediately why 5 of 6 targets "failed" here.
 *
 * **The fix is the matrix, not this script**: each target must be built on
 * a runner of that platform, so its OWN `@opentui/core-<platform>-<arch>`
 * links natively and the dynamic import above resolves normally. That is
 * exactly Issue #36's tag-triggered release matrix — this script's target
 * filter (`bun run release <target>`) is the seam that matrix uses: each
 * platform's runner invokes this script with just its own target name.
 *
 * ## The `TECODE_BIN` smoke-test convention
 *
 * `packages/cli/src/compiledBinary.smoke.test.ts` exercises a REAL compiled
 * binary end to end (headless startup, embedded-asset resolution, external
 * extension loading) when the `TECODE_BIN` environment variable names one —
 * see that file's TSDoc. This script does not set `TECODE_BIN` itself (a
 * release build and a test run are separate concerns), but a human — or a
 * CI job — wiring the two together runs, in order:
 *
 * ```
 * bun run release bun-linux-x64
 * TECODE_BIN=dist/tecode-linux-x64 bun test packages/cli/src/compiledBinary.smoke.test.ts
 * ```
 *
 * ## What this script cannot verify by itself
 *
 * The five non-host targets' real builds, Windows `%APPDATA%\tecode\`
 * resolution on an actual Windows machine, and an interactive clean-machine
 * check (open a directory, highlight a file, switch themes, on a real
 * terminal) all need a platform or a TTY this script's own environment does
 * not have. `docs/manual-release-verification.md` records the exact
 * procedure for each, and what's already covered automatically without
 * them.
 */

import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** One `bun build --compile --target=...` release target (design.md §17's
 * "darwin/linux/windows × x64/arm64"). */
export interface ReleaseTarget {
  /** The exact string passed to `bun build --compile --target=`. */
  readonly bunTarget: string;
  readonly platform: "darwin" | "linux" | "windows";
  readonly arch: "x64" | "arm64";
}

/** The full 6-target release matrix (Req 13.2, design.md §17). Order is
 * deterministic (platform, then arch) purely for stable, readable output —
 * it has no bearing on correctness since every target builds
 * independently. */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { bunTarget: "bun-darwin-x64", platform: "darwin", arch: "x64" },
  { bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64" },
  { bunTarget: "bun-linux-x64", platform: "linux", arch: "x64" },
  { bunTarget: "bun-linux-arm64", platform: "linux", arch: "arm64" },
  { bunTarget: "bun-windows-x64", platform: "windows", arch: "x64" },
  { bunTarget: "bun-windows-arm64", platform: "windows", arch: "arm64" },
];

/**
 * Req 13.2's "no larger than 120 MB" size budget, resolved to an exact byte
 * count. Neither `requirements.md` nor `design.md` states whether "MB"
 * means the binary (1024²) or decimal (10⁶) reading, and the gap matters
 * here: the one target buildable and measured on this machine
 * (`bun-linux-x64`) came in at 114,968,726 bytes — 109.6 MiB, comfortably
 * under a 125,829,120-byte (120 MiB) budget, but only ~5 MB under a
 * 120,000,000-byte (120 MB decimal) one. This picks the STRICTER decimal
 * reading deliberately, per this task's own instruction to do so absent
 * clarifying text — a binary that passes this budget also passes the
 * looser MiB one, but not vice versa, so this is the conservative choice
 * that actually protects the 120 MB acceptance criterion regardless of
 * which reading the requirement's author intended.
 */
export const SIZE_LIMIT_BYTES = 120_000_000;

/** Render a byte count as a fixed-precision "X.XX MB" string (decimal,
 * matching {@link SIZE_LIMIT_BYTES}'s own reading) for human-readable
 * output — every target's actual size is logged this way regardless of
 * pass/fail, so a size regression is visible even on a run that still
 * passes (this task's own requirement). */
export function formatBytesAsMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/** The on-disk file name `buildTarget` writes for a given target — a
 * `.exe` suffix for `windows`, matching Windows' own executable
 * convention, nothing else does. */
export function binaryFileName(target: ReleaseTarget): string {
  const base = `tecode-${target.platform}-${target.arch}`;
  return target.platform === "windows" ? `${base}.exe` : base;
}

/**
 * Recognize `bun build --compile`'s failure signature for Finding 2's
 * cross-compilation limitation (this module's TSDoc): `@opentui/core`'s
 * dynamic `import(\`@opentui/core-${process.platform}-${process.arch}/
 * index.ts\`)` can only ever resolve against the HOST's own linked platform
 * package, so building for any other target fails with `Could not resolve:
 * "@opentui/core-<platform>-<arch>/index.ts"`. Returns a human-readable
 * explanation when `stderr` matches that exact shape, `undefined`
 * otherwise (a genuine, different build break) — {@link buildTarget} uses
 * this to label a failure's `reason` distinctly so a matrix runner hitting
 * a REAL break is never confused with this known, packaging-level
 * limitation.
 */
export function classifyBuildFailure(stderr: string): string | undefined {
  if (/Could not resolve: "@opentui\/core-[\w-]+\/index\.ts"/.test(stderr)) {
    return (
      "known limitation: @opentui/core's platform-native optional dependency " +
      "cannot be cross-compiled from this host — this target must be built " +
      "on a runner of its own platform (see this script's TSDoc, \"Why this " +
      "machine cannot produce all six binaries\")"
    );
  }
  return undefined;
}

/** One target's outcome after {@link buildTarget} runs. `"ok"` means the
 * `bun build --compile` invocation exited 0 AND the resulting binary is
 * within {@link SIZE_LIMIT_BYTES}; `"oversized"` means it exited 0 but blew
 * the budget; `"build-failed"` means the compile step itself failed
 * (`reason` explains why, and is {@link classifyBuildFailure}'s verdict
 * when that pattern matches). */
export interface BuildOutcome {
  readonly target: ReleaseTarget;
  readonly status: "ok" | "oversized" | "build-failed";
  /** Set for `"ok"`/`"oversized"` — the real size of the produced binary. */
  readonly sizeBytes?: number;
  /** Set for `"build-failed"` — {@link classifyBuildFailure}'s verdict when
   * recognized, else a truncated tail of the command's stderr. */
  readonly reason?: string;
  /** Set for `"build-failed"` — the `bun build --compile` process's own
   * exit code. */
  readonly exitCode?: number;
}

/** Dependencies {@link buildTarget} needs beyond the target itself — a
 * real `Bun.spawn`-backed default, overridable so a caller (or a future
 * test) can substitute a fake spawn without actually invoking `bun build`
 * (matches this codebase's `GitRunner`/`ConfigServiceFs`-style seam
 * convention: production gets a real default, tests inject their own). */
export interface BuildTargetOptions {
  /** Directory (relative to `repoRoot`, or absolute) release binaries are
   * written into. Defaults to `"dist"`. */
  distDir?: string;
  /** Working directory `bun build --compile` runs from — must be the repo
   * root so `packages/cli/src/main.ts` resolves. Defaults to
   * `process.cwd()`. */
  repoRoot?: string;
  /** Overrides the spawn seam. Defaults to `Bun.spawn`. */
  spawn?: typeof Bun.spawn;
}

/**
 * Build exactly one release target: `bun build --compile --minify
 * --target=<t> packages/cli/src/main.ts --outfile <dist>/<name>`, then
 * `stat` the result and assert it against {@link SIZE_LIMIT_BYTES}.
 * Deliberately does NOT pass `--bytecode` — that flag trades size for
 * startup latency, and Req 13.2's constrained axis here is size, not
 * startup (design.md §15's <100ms first-frame budget already has ~10x
 * headroom per `main.integration.test.ts`'s own measured 6-15ms).
 *
 * **Absolute vs. relative `distDir`**: the output path is computed exactly
 * ONCE, via `resolve(repoRoot, distDir, binaryFileName(target))`, and that
 * same value is used for both the `--outfile` argument (what `bun build`
 * actually writes) and the later `stat` (what confirms it landed and
 * measures it). `node:path`'s `resolve` makes this safe regardless of
 * whether `distDir` is relative (the common case — `"dist"`, joined onto
 * `repoRoot`) or already absolute (`resolve` then ignores `repoRoot`
 * entirely, per its own documented left-to-right short-circuit on an
 * absolute segment) — computing it twice with two different helpers
 * (`join(distDir, ...)` for `--outfile`, `join(repoRoot, ...)` for `stat`,
 * as an earlier version of this function did) silently disagreed for an
 * absolute `distDir`: the build would write to the absolute path while
 * `stat` looked for a path re-rooted under `repoRoot` that was never
 * created, throwing `ENOENT` instead of reporting a real build outcome.
 */
export async function buildTarget(
  target: ReleaseTarget,
  options: BuildTargetOptions = {},
): Promise<BuildOutcome> {
  const distDir = options.distDir ?? "dist";
  const repoRoot = options.repoRoot ?? process.cwd();
  const spawn = options.spawn ?? Bun.spawn;

  const outfile = resolve(repoRoot, distDir, binaryFileName(target));
  const proc = spawn({
    cmd: [
      "bun",
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      "packages/cli/src/main.ts",
      "--outfile",
      outfile,
    ],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (exitCode !== 0) {
    const trimmedStderr = stderr.trim().slice(-500);
    const reason = classifyBuildFailure(stderr) ?? (trimmedStderr || `exit code ${exitCode}`);
    return { target, status: "build-failed", reason, exitCode };
  }

  const { size: sizeBytes } = await stat(outfile);
  return { target, status: sizeBytes > SIZE_LIMIT_BYTES ? "oversized" : "ok", sizeBytes };
}

/** Parse `bun run release [target ...]` arguments into the targets to
 * build (see this module's TSDoc "Usage"). No arguments means "all six" —
 * matches this task's own "default to all six" requirement. Any argument
 * that doesn't name a real {@link RELEASE_TARGETS} entry is reported back
 * in `unknown` rather than silently ignored — a typo'd target name should
 * be loud, not a quiet no-op. */
export function parseTargetFilter(args: readonly string[]): {
  targets: ReleaseTarget[];
  unknown: string[];
} {
  if (args.length === 0) {
    return { targets: [...RELEASE_TARGETS], unknown: [] };
  }
  const targets: ReleaseTarget[] = [];
  const unknown: string[] = [];
  for (const arg of args) {
    const found = RELEASE_TARGETS.find((t) => t.bunTarget === arg);
    if (found) {
      targets.push(found);
    } else {
      unknown.push(arg);
    }
  }
  return { targets, unknown };
}

async function main(argv: string[]): Promise<void> {
  const { targets, unknown } = parseTargetFilter(argv);
  for (const bad of unknown) {
    console.error(
      `release: unknown target "${bad}" — valid targets: ${RELEASE_TARGETS.map((t) => t.bunTarget).join(", ")}`,
    );
  }

  // Every target NOT requested this run is logged as not-built, never
  // silently dropped — this task's own "whatever you don't build, log as
  // not built" requirement, most relevant when a CI runner passes a single
  // target filter and the other five are expected to be built elsewhere.
  const requested = new Set(targets.map((t) => t.bunTarget));
  for (const target of RELEASE_TARGETS) {
    if (!requested.has(target.bunTarget)) {
      console.log(`release: ${target.bunTarget} — not built (excluded by this run's target filter)`);
    }
  }

  const distDir = "dist";
  await mkdir(distDir, { recursive: true });

  const outcomes: BuildOutcome[] = [];
  for (const target of targets) {
    console.log(`release: building ${target.bunTarget}...`);
    const outcome = await buildTarget(target, { distDir, repoRoot: process.cwd() });
    outcomes.push(outcome);
    if (outcome.status === "ok") {
      console.log(`release: ${target.bunTarget} — OK, ${formatBytesAsMB(outcome.sizeBytes!)} (limit ${formatBytesAsMB(SIZE_LIMIT_BYTES)})`);
    } else if (outcome.status === "oversized") {
      console.error(
        `release: ${target.bunTarget} — FAILED (over size budget): ${formatBytesAsMB(outcome.sizeBytes!)} > ${formatBytesAsMB(SIZE_LIMIT_BYTES)}`,
      );
    } else {
      console.error(`release: ${target.bunTarget} — FAILED (exit ${outcome.exitCode}): ${outcome.reason}`);
    }
  }

  console.log("");
  console.log("release: summary");
  for (const outcome of outcomes) {
    const size = outcome.sizeBytes !== undefined ? formatBytesAsMB(outcome.sizeBytes) : "n/a";
    console.log(`  ${outcome.target.bunTarget}: ${outcome.status} (${size})`);
  }
  for (const target of RELEASE_TARGETS) {
    if (!requested.has(target.bunTarget)) {
      console.log(`  ${target.bunTarget}: not built`);
    }
  }

  const failed = outcomes.filter((o) => o.status !== "ok");
  if (unknown.length > 0 || failed.length > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error("release: failed:", cause);
    process.exit(1);
  });
}
