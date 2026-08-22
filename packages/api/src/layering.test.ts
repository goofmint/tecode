/**
 * Verifies the `no-restricted-imports` layering rule in the root
 * `eslint.config.mjs` (Req 1.3, design.md §2): `packages/builtin/**` may
 * not import `@tecode/core` directly, while `packages/cli/**` — the one
 * place wiring core together is legitimate — is exempt.
 *
 * These fixtures are written to temp locations under the real packages
 * (ESLint's flat-config `files`/`ignores` globs match on path, so the
 * fixture has to actually live under `packages/builtin` or
 * `packages/cli/src`) and are always removed again in a `finally`, so a
 * failed assertion never leaves a permanently-lint-breaking file behind.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BAD_DIR = path.join(REPO_ROOT, "packages/builtin/__lint-fixture__");
const BAD_FILE = path.join(BAD_DIR, "bad.ts");
const OK_FILE = path.join(REPO_ROOT, "packages/cli/src/__lint-fixture__.ts");

async function cleanupFixtures(): Promise<void> {
  await rm(BAD_DIR, { recursive: true, force: true });
  await rm(OK_FILE, { force: true });
}

// Belt-and-suspenders: also clean up after the suite in case a test is
// interrupted between its own try/finally and completion.
afterEach(cleanupFixtures);

interface EslintMessage {
  ruleId: string | null;
}

interface EslintFileResult {
  messages: EslintMessage[];
}

async function runEslint(
  relFile: string,
): Promise<{ exitCode: number; results: EslintFileResult[] }> {
  const proc = Bun.spawn({
    cmd: ["bunx", "eslint", "--no-ignore", "-f", "json", relFile],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  const results = stdout.trim().length > 0 ? (JSON.parse(stdout) as EslintFileResult[]) : [];
  return { exitCode, results };
}

test("blocks @tecode/core imports from packages/builtin", async () => {
  await cleanupFixtures();
  try {
    await mkdir(BAD_DIR, { recursive: true });
    await writeFile(BAD_FILE, 'import "@tecode/core";\n');

    const { exitCode, results } = await runEslint(
      "packages/builtin/__lint-fixture__/bad.ts",
    );

    const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
    expect(exitCode).not.toBe(0);
    expect(ruleIds).toContain("no-restricted-imports");
  } finally {
    await cleanupFixtures();
  }
});

test("allows @tecode/core imports from packages/cli", async () => {
  await cleanupFixtures();
  try {
    await writeFile(OK_FILE, 'import "@tecode/core";\n');

    const { results } = await runEslint("packages/cli/src/__lint-fixture__.ts");

    const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
    expect(ruleIds).not.toContain("no-restricted-imports");
  } finally {
    await cleanupFixtures();
  }
});
