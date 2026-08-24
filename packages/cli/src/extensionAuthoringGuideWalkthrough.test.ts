/**
 * Pipeline-level validation for `docs/extension-authoring-guide.md`'s
 * walkthrough extension (Issue #37 "5.1 Extension authoring guide"; Req
 * 2.3, 2.7, 10; design.md §4, §12). Completion requirement: "Following the
 * walkthrough verbatim on a released binary yields a working extension" —
 * there is no released binary and no TTY in this environment (the guide's
 * own "What remains unverified" section says so plainly), so this is the
 * strongest thing actually achievable here: the guide's `manifest.ts`/
 * `index.ts` listings, extracted from the doc BY EXACT TEXT (not
 * retyped/duplicated), driven through the real discover → validate →
 * register → activate pipeline via `externalExtensionLoadHarness.ts` — the
 * same established pattern `externalExtensionLoading.test.ts` uses for
 * Issue #32, reused rather than reinvented.
 *
 * **Why extraction, not a separate fixtures module**: a hand-maintained
 * copy of the walkthrough's source living in two places (the doc's prose
 * and a `.ts` fixture file) drifts the moment either one is edited without
 * the other. Reading the doc's own fenced code blocks and running THAT
 * text is the one arrangement where drift is structurally impossible — if
 * this test passes, the guide's listings are, byte for byte, a real,
 * working extension.
 */

import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cold subprocess module resolution/transpilation (matches
// `externalExtensionLoading.test.ts`'s own override of the 5s default).
setDefaultTimeout(30_000);

const GUIDE_PATH = join(import.meta.dir, "..", "..", "..", "docs", "extension-authoring-guide.md");

/**
 * Pull the fenced ```ts code block immediately following
 * `<!-- walkthrough-fixture:<name> -->` out of the guide's raw markdown.
 * Throws (failing the test with a clear message) if the marker or its
 * fence is missing — a silently-empty extraction would make every
 * assertion below vacuous instead of catching a broken doc edit.
 */
function extractFixture(markdown: string, name: string): string {
  const marker = `<!-- walkthrough-fixture:${name} -->`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`extension-authoring-guide.md: marker "${marker}" not found`);
  }
  const fenceStart = markdown.indexOf("```ts", markerIndex);
  if (fenceStart === -1) {
    throw new Error(`extension-authoring-guide.md: no \`\`\`ts fence after "${marker}"`);
  }
  const codeStart = markdown.indexOf("\n", fenceStart) + 1;
  const fenceEnd = markdown.indexOf("\n```", codeStart);
  if (fenceEnd === -1) {
    throw new Error(`extension-authoring-guide.md: unterminated fence after "${marker}"`);
  }
  return markdown.slice(codeStart, fenceEnd);
}

interface HarnessResult {
  loadedIds: string[];
  skipped: { extensionId: string; reason: string }[];
  states: Record<string, string | undefined>;
  commandResult: unknown;
  sidebarViewResolved: boolean;
  errorLogMessages: string[];
  configValue: unknown;
  fatal?: string;
}

async function runHarness(
  homeDir: string,
  commandId: string,
  viewId: string,
  configKey: string,
): Promise<HarnessResult> {
  const harnessPath = join(import.meta.dir, "externalExtensionLoadHarness.ts");
  const proc = Bun.spawn({
    cmd: ["bun", "run", harnessPath, commandId, viewId, "", configKey],
    env: { ...process.env, HOME: homeDir, APPDATA: homeDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  expect(line, `harness printed no JSON line; exitCode=${exitCode}, stderr:\n${stderr}`).toBeDefined();
  const result = JSON.parse(line!) as HarnessResult;
  expect(result.fatal, `harness reported a fatal error: ${result.fatal}; stderr:\n${stderr}`).toBeUndefined();
  return result;
}

test("the guide's walkthrough manifest.ts/index.ts, extracted verbatim, load/validate/register/activate for real and every declared piece works (Issue #37)", async () => {
  const markdown = await readFile(GUIDE_PATH, "utf8");
  const manifestSource = extractFixture(markdown, "manifest.ts");
  const indexSource = extractFixture(markdown, "index.ts");

  // Sanity on the extraction itself, independent of the pipeline below —
  // if these ever fail, the doc's own listings changed shape in a way
  // that would make a false-negative pipeline failure hard to diagnose.
  expect(manifestSource).toContain('id: "example.word-count"');
  expect(manifestSource).toContain('apiVersion: "1.0"');
  expect(manifestSource).toContain('key: "ctrl+alt+w"');
  expect(indexSource).toContain("export function activate(ctx: ExtensionContext)");
  expect(indexSource).toContain("export function deactivate(): void {}");

  const homeDir = await mkdtemp(join(tmpdir(), "tecode-guide-walkthrough-home-"));
  try {
    const extensionDir = join(homeDir, ".config", "tecode", "extensions", "word-count");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "manifest.ts"), manifestSource, "utf8");
    await writeFile(join(extensionDir, "index.ts"), indexSource, "utf8");

    const result = await runHarness(
      homeDir,
      "wordCount.refresh",
      "wordCount.view",
      "wordCount.showChars",
    );

    // Manifest (id, apiVersion, activationEvents) validated and registered.
    expect(result.skipped).toEqual([]);
    expect(result.loadedIds).toContain("example.word-count");

    // Activation code ran to completion (onStartup).
    expect(result.states["example.word-count"]).toBe("active");

    // The contributed command executed for real, through the real
    // registry, and its handler's real logic ran (no active editor in this
    // harness, so the deterministic "No document open." branch).
    expect(result.commandResult).toBe("No document open.");

    // The contributed sidebar view resolved to a real, non-lazy component.
    expect(result.sidebarViewResolved).toBe(true);

    // The contributed configuration key's schema default reached
    // tecode.config.get through the real ConfigService.
    expect(result.configValue).toBe(false);

    // No error was surfaced for this extension — it is a "healthy" load
    // throughout the pipeline.
    expect(result.errorLogMessages).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
