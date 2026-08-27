/**
 * Drives the compiled-binary release matrix (Issue #35 "4.4 Compiled binary
 * builds"; Req 8.5, 13.2; design.md §17: "Release: `bun build --compile` per
 * target (darwin/linux/windows × x64/arm64 in principle) from `cli`... A
 * `scripts/release.ts` drives the 4-target matrix and size assertions."),
 * plus (Issue #38 "5.2 User documentation and release") a SHA-256 checksum
 * written alongside each successfully built binary — {@link sha256Hex},
 * {@link formatChecksumLine}, {@link computeChecksumLine}, and
 * {@link writeChecksumFile} below — for the release workflow's publish job
 * to attach to the GitHub Release next to the binary it describes.
 *
 * **Only four of the six theoretically-possible targets are actually
 * published** — see "Two targets were dropped, not just left off this
 * machine" below for why `bun-darwin-x64` and `bun-windows-arm64` are gone
 * from {@link RELEASE_TARGETS} entirely, not merely unbuilt here.
 *
 * Usage: `bun run release [target ...]` — with no arguments, attempts all
 * four {@link RELEASE_TARGETS}; with one or more `bun build --target=...`
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
 * ## Why this machine cannot produce even the four remaining binaries
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
 * understands immediately why 3 of 4 targets "failed" here.
 *
 * **The fix is the matrix, not this script**: each target must be built on
 * a runner of that platform, so its OWN `@opentui/core-<platform>-<arch>`
 * links natively and the dynamic import above resolves normally. That is
 * exactly the tag-triggered CircleCI release pipeline (`.circleci/
 * config.yml`) — this script's target filter (`bun run release <target>`)
 * is the seam that pipeline uses: each platform's runner (two of them
 * self-hosted — see that config's own comments) invokes this script with
 * just its own target name.
 *
 * ## Two targets were dropped, not just left off this machine
 *
 * The matrix above is deliberately four targets, not six: `bun-darwin-x64`
 * and `bun-windows-arm64` are not merely "not built on this machine" the
 * way the other three non-host targets are — they are not in
 * {@link RELEASE_TARGETS} at all, because no machine anywhere in this
 * project's CI can build them, and cross-compiling them from another
 * platform is exactly as impossible as the paragraph above describes for
 * any other foreign target:
 *
 * - **`bun-darwin-x64` (Intel macOS)**: CircleCI removed every Intel macOS
 *   resource class in June 2024 — its hosted `macos` executor is Apple
 *   silicon only. The project owner's own Mac is Apple silicon
 *   (`bun-darwin-arm64`, self-hosted below); they have no Intel Mac to
 *   build or verify an Intel binary on.
 * - **`bun-windows-arm64` (Windows on Arm)**: CircleCI offers no Windows
 *   arm64 resource class, hosted or self-hosted. The owner's in-house
 *   Windows machine is x64 (`bun-windows-x64`, self-hosted below); they
 *   have no Windows-on-Arm device either.
 *
 * These two were considered and explicitly ruled out — not forgotten. If a
 * future CircleCI release adds an Intel-macOS or Windows-arm64 resource
 * class, or the project gains access to that hardware, re-adding the
 * corresponding entry to {@link RELEASE_TARGETS} (and a matching job to
 * `.circleci/config.yml`, and bumping that config's
 * `PUBLISH_EXPECTED_BINARIES`) is the only work needed — nothing else in
 * this script is target-count-specific. Until then, a user on either
 * platform has no binary to download; the README's "From source" section
 * (`bun run packages/cli/src/main.ts`) is what to point them at.
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
 * The three non-host targets' real builds, Windows `%APPDATA%\tecode\`
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

/** The real, published 4-target release matrix (Req 13.2, design.md §17) —
 * NOT the full darwin/linux/windows × x64/arm64 cross-product design.md §17
 * describes "in principle". `bun-darwin-x64` and `bun-windows-arm64` are
 * deliberately absent: CircleCI has no Intel-macOS resource class (removed
 * June 2024) and no Windows-arm64 resource class at all, and the project
 * owner has neither an Intel Mac nor a Windows-on-Arm machine to self-host
 * either one — see this module's TSDoc, "Two targets were dropped, not
 * just left off this machine", for the full reasoning. Order is
 * deterministic (platform, then arch) purely for stable, readable output —
 * it has no bearing on correctness since every target builds
 * independently. */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64" },
  { bunTarget: "bun-linux-x64", platform: "linux", arch: "x64" },
  { bunTarget: "bun-linux-arm64", platform: "linux", arch: "arm64" },
  { bunTarget: "bun-windows-x64", platform: "windows", arch: "x64" },
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
 * SHA-256 hex digest of `data` (Issue #38 "5.2 User documentation and
 * release": every binary a `v*` tag push publishes ships with a checksum
 * so a downloader can verify it before running an unfamiliar binary).
 * Uses Bun's built-in `CryptoHasher` directly — no checksum dependency for
 * something the runtime already provides natively, matching this
 * codebase's house convention of not reaching for a library where a
 * couple of lines against a platform API suffice.
 */
export function sha256Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/**
 * Render one checksum line in the exact format both `sha256sum` (GNU
 * coreutils, Linux) and `shasum -a 256` (macOS/BSD) produce AND consume
 * via their own `-c`/`--check` flag: `<hex digest><two spaces><filename>\n`
 * — the two spaces are that format's own "binary mode" marker, not
 * incidental whitespace, so this must not be collapsed to one.
 * `fileName` is always {@link binaryFileName}'s bare output, never a full
 * path: a checksum file is meant to sit ALONGSIDE the binary it describes
 * (the release workflow downloads every target's binary and its `.sha256`
 * file into the same flat directory before attaching both to the
 * Release), and embedding a build-machine-specific absolute path would
 * make the line fail `-c` verification anywhere else.
 */
export function formatChecksumLine(hexDigest: string, fileName: string): string {
  return `${hexDigest}  ${fileName}\n`;
}

/** Dependencies {@link computeChecksumLine}/{@link writeChecksumFile} need
 * beyond the target itself — matches {@link BuildTargetOptions}'s
 * injectable-seam convention (a real default, overridable so
 * `scripts/release.test.ts` can inject a fixed byte buffer and a fake hash
 * function instead of needing a real ~110 MB compiled binary on disk). */
export interface ChecksumOptions {
  /** Directory (relative to `repoRoot`, or absolute) the binary was
   * written into by {@link buildTarget}. Defaults to `"dist"` — must
   * match whatever `buildTarget` actually used for this to find anything. */
  distDir?: string;
  /** Working directory the (relative) `distDir` is resolved against.
   * Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Reads the binary's raw bytes. Defaults to `Bun.file(path).bytes()`. */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /** Computes the hex digest from those bytes. Defaults to
   * {@link sha256Hex}. */
  hash?: (data: Uint8Array) => string;
}

async function defaultReadBytes(path: string): Promise<Uint8Array> {
  return await Bun.file(path).bytes();
}

/**
 * Compute one target's checksum line ({@link formatChecksumLine}'s shape)
 * by reading its already-built binary off disk. Resolves the binary's path
 * the exact same way {@link buildTarget} does —
 * `resolve(repoRoot, distDir, binaryFileName(target))` — deliberately
 * reusing that same expression rather than a second hand-rolled join, for
 * the identical reason {@link buildTarget}'s own TSDoc gives for computing
 * its `--outfile`/`stat` path exactly once ("Absolute vs. relative
 * `distDir`"): two independently-written path-joins have already
 * silently disagreed for an absolute `distDir` once in this file's
 * history, and this avoids repeating that mistake for a third callsite.
 */
export async function computeChecksumLine(
  target: ReleaseTarget,
  options: ChecksumOptions = {},
): Promise<string> {
  const distDir = options.distDir ?? "dist";
  const repoRoot = options.repoRoot ?? process.cwd();
  const readBytes = options.readBytes ?? defaultReadBytes;
  const hash = options.hash ?? sha256Hex;

  const fileName = binaryFileName(target);
  const filePath = resolve(repoRoot, distDir, fileName);
  const bytes = await readBytes(filePath);
  return formatChecksumLine(hash(bytes), fileName);
}

/**
 * Write `<binaryFileName(target)>.sha256` next to the binary itself — the
 * exact sibling-file convention `sha256sum <file> > <file>.sha256`
 * produces by hand, and what the release workflow's per-target build job
 * uploads as its own artifact (alongside the binary) for the publish job
 * to download and attach to the GitHub Release. Returns the checksum
 * file's own absolute path.
 */
export async function writeChecksumFile(
  target: ReleaseTarget,
  options: ChecksumOptions = {},
): Promise<string> {
  const distDir = options.distDir ?? "dist";
  const repoRoot = options.repoRoot ?? process.cwd();
  const line = await computeChecksumLine(target, options);
  const checksumPath = resolve(repoRoot, distDir, `${binaryFileName(target)}.sha256`);
  await Bun.write(checksumPath, line);
  return checksumPath;
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
      "machine cannot produce even the four remaining binaries\")"
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
 * build (see this module's TSDoc "Usage"). No arguments means "all four
 * {@link RELEASE_TARGETS}" — matches this task's own "default to all
 * targets" requirement. Any argument
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
  // target filter and the other three are expected to be built elsewhere.
  const requested = new Set(targets.map((t) => t.bunTarget));
  for (const target of RELEASE_TARGETS) {
    if (!requested.has(target.bunTarget)) {
      console.log(`release: ${target.bunTarget} — not built (excluded by this run's target filter)`);
    }
  }

  const distDir = "dist";
  await mkdir(distDir, { recursive: true });

  const outcomes: BuildOutcome[] = [];
  // Tracked separately from `outcomes` (whose `status` field only ever
  // describes the BUILD step) — a checksum failure is its own distinct
  // failure mode (a successfully built, correctly sized binary whose
  // `.sha256` sibling failed to write) and must still fail the script, not
  // be silently swallowed just because the build itself was fine.
  let checksumFailed = false;
  for (const target of targets) {
    console.log(`release: building ${target.bunTarget}...`);
    const outcome = await buildTarget(target, { distDir, repoRoot: process.cwd() });
    outcomes.push(outcome);
    if (outcome.status === "ok") {
      console.log(`release: ${target.bunTarget} — OK, ${formatBytesAsMB(outcome.sizeBytes!)} (limit ${formatBytesAsMB(SIZE_LIMIT_BYTES)})`);
      // Only a successfully-built, in-budget binary gets a checksum — an
      // "oversized"/"build-failed" outcome has no binary worth checksumming
      // (or, for "oversized", one that must not be shipped at all).
      try {
        const checksumPath = await writeChecksumFile(target, { distDir, repoRoot: process.cwd() });
        console.log(`release: ${target.bunTarget} — checksum written to ${checksumPath}`);
      } catch (cause) {
        checksumFailed = true;
        console.error(`release: ${target.bunTarget} — FAILED to write checksum: ${cause}`);
      }
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
  if (unknown.length > 0 || failed.length > 0 || checksumFailed) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error("release: failed:", cause);
    process.exit(1);
  });
}
