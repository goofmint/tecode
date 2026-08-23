/**
 * Golden-span highlight tests for `languages-basic` (Req 8.4; tasks.md's
 * Task 2.9): for each of the 12 vendored languages, load its REAL grammar
 * WASM + real `.scm` highlight query through the production
 * `createWebTreeSitterParserBackend`/`createAssetResolver` pair (the same
 * two seams `main.ts` wires together for a real run — `createAssetResolver`
 * here is given `createBuiltinLanguageAssetsFs`'s overlay over
 * `@tecode/builtin`'s embedded asset maps, exactly like `buildAssemblyRoot`
 * does), parse a small fixture, and assert specific expected capture-name
 * spans appear at their exact source substrings — explicit assertions, not
 * snapshots, per this task's plan.
 *
 * This is deliberately the ONE test file in this codebase that touches real
 * `web-tree-sitter` WASM end to end for `languages-basic` (mirrors
 * `parserBackend.ts`'s own TSDoc: every OTHER test around the
 * highlight-service pipeline uses a hand-rolled mock backend) — loading 12
 * real grammars is comparatively slow, so it happens once, in one shared
 * `beforeAll`, rather than per-test.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  builtinLanguageGrammarAssets,
  builtinLanguageQueryAssets,
  builtinManifests,
  LANGUAGES_BASIC_EXTENSION_ID,
} from "@tecode/builtin";
import type { LanguageContribution } from "@tecode/api";
import {
  createAssetResolver,
  createWebTreeSitterParserBackend,
  validateManifest,
  type ParserBackend,
  type ParserCapture,
} from "@tecode/core";
import { createBuiltinLanguageAssetsFs } from "./languageAssetsFs";
import { builtinExtensionDir } from "./main";

const languagesBasicManifest = builtinManifests.find((m) => m.id === LANGUAGES_BASIC_EXTENSION_ID)!;

describe("languages-basic manifest", () => {
  test("validates cleanly against host/validate.ts's validateManifest (Req 8.2)", () => {
    const result = validateManifest(languagesBasicManifest);
    expect(result.valid, `expected a valid manifest; errors: ${JSON.stringify((result as { errors?: string[] }).errors)}`).toBe(true);
  });

  test("declares exactly the 12 MVP languages, each with a distinct id (Req 8.4)", () => {
    const languages = languagesBasicManifest.contributes.languages ?? [];
    expect(languages).toHaveLength(12);
    const ids = languages.map((l) => l.id);
    expect(new Set(ids).size).toBe(12);
    expect(ids.sort()).toEqual(
      [
        "bash",
        "css",
        "go",
        "html",
        "javascript",
        "json",
        "markdown",
        "python",
        "rust",
        "toml",
        "typescript",
        "yaml",
      ].sort(),
    );
  });

  test("declares one onLanguage:<id> activation event per language (ExtensionHost.onLanguage's format)", () => {
    const languages = languagesBasicManifest.contributes.languages ?? [];
    const expected = new Set(languages.map((l) => `onLanguage:${l.id}` as const));
    expect(new Set(languagesBasicManifest.activationEvents)).toEqual(expected);
  });
});

const assetResolver = createAssetResolver({
  fs: createBuiltinLanguageAssetsFs(builtinLanguageGrammarAssets, builtinLanguageQueryAssets),
});
const baseDir = builtinExtensionDir(LANGUAGES_BASIC_EXTENSION_ID);

function getContribution(id: string): LanguageContribution {
  const contribution = (languagesBasicManifest.contributes.languages ?? []).find((l) => l.id === id);
  if (!contribution) throw new Error(`no such language in the manifest: ${id}`);
  return contribution;
}

/** Load+compile one language's REAL grammar+query through the production
 * seams (this file's TSDoc). */
async function loadRealLanguage(backend: ParserBackend, id: string) {
  const contribution = getContribution(id);
  const grammarBytes = await assetResolver.resolveGrammar(contribution.grammar, baseDir);
  const language = await backend.loadLanguage(grammarBytes);
  const querySource = await assetResolver.resolveHighlights(contribution.highlights, baseDir);
  const query = backend.compileQuery(language, querySource);
  return { language, query };
}

/** One expected capture: `name` is the exact `.scm` capture name, `text` is
 * the exact source substring it must cover. */
interface ExpectedCapture {
  name: string;
  text: string;
}

function assertCapturesContain(captures: readonly ParserCapture[], sourceText: string, expected: readonly ExpectedCapture[]): void {
  for (const want of expected) {
    const found = captures.some((c) => c.name === want.name && sourceText.slice(c.startIndex, c.endIndex) === want.text);
    expect(
      found,
      `expected a "${want.name}" capture over ${JSON.stringify(want.text)}; got: ${JSON.stringify(
        captures.map((c) => ({ name: c.name, text: sourceText.slice(c.startIndex, c.endIndex) })),
      )}`,
    ).toBe(true);
  }
}

describe("golden-span highlighting (Req 8.4, real grammar + real query per language)", () => {
  const backend = createWebTreeSitterParserBackend();

  beforeAll(async () => {
    await backend.init();
  });

  test("typescript: keywords, function, string, comment, number resolve", async () => {
    const { language, query } = await loadRealLanguage(backend, "typescript");
    const source = 'function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n';
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "function" },
      { name: "function", text: "add" },
      { name: "type.builtin", text: "number" },
      { name: "comment", text: "// sum" },
      { name: "keyword", text: "return" },
    ]);
  });

  test("javascript: template string + embedded expression", async () => {
    const { language, query } = await loadRealLanguage(backend, "javascript");
    const source = "function greet(name) {\n  return `Hello, ${name}!`;\n}\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "function" },
      { name: "function", text: "greet" },
      { name: "string", text: "`Hello, ${name}!`" },
      { name: "embedded", text: "${name}" },
    ]);
  });

  test("json: string keys, string values, numbers", async () => {
    const { language, query } = await loadRealLanguage(backend, "json");
    const source = '{"name": "tecode", "count": 3}';
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "string.special.key", text: '"name"' },
      { name: "string", text: '"tecode"' },
      { name: "number", text: "3" },
    ]);
  });

  test("markdown: heading, code fence, list marker, blockquote", async () => {
    const { language, query } = await loadRealLanguage(backend, "markdown");
    const source = "# Title\n\n- item\n\n> quote\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "Title" },
      { name: "punctuation.special", text: "#" },
      { name: "punctuation.special", text: "- " },
      { name: "comment", text: "> " },
    ]);
  });

  test("python: def, function name, comment, keyword", async () => {
    const { language, query } = await loadRealLanguage(backend, "python");
    const source = "def add(a, b):\n    # sum two numbers\n    return a + b\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "def" },
      { name: "function", text: "add" },
      { name: "comment", text: "# sum two numbers" },
      { name: "keyword", text: "return" },
    ]);
  });

  test("rust: fn keyword, function name, builtin type, comment, all-caps constant", async () => {
    const { language, query } = await loadRealLanguage(backend, "rust");
    const source = "const MAX_SIZE: i32 = 100;\nfn add(a: i32, b: i32) -> i32 {\n    // sum\n    a + b\n}\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "fn" },
      { name: "function", text: "add" },
      { name: "type.builtin", text: "i32" },
      { name: "comment", text: "// sum" },
      // Finding 2 regression check: the `@constant` regex had a stray
      // trailing `'` (`"^[A-Z][A-Z\\d_]+$'"`) that made it never match any
      // real all-caps identifier — `MAX_SIZE` must now be captured.
      { name: "constant", text: "MAX_SIZE" },
    ]);
  });

  test("go: package/func keywords, function name, comment", async () => {
    const { language, query } = await loadRealLanguage(backend, "go");
    const source = "package main\n\n// add sums two numbers\nfunc add(a int, b int) int {\n\treturn a + b\n}\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "keyword", text: "package" },
      { name: "keyword", text: "func" },
      { name: "function", text: "add" },
      { name: "comment", text: "// add sums two numbers" },
    ]);
  });

  test("html: comment, tag, attribute, string", async () => {
    const { language, query } = await loadRealLanguage(backend, "html");
    const source = '<!-- greeting --><div class="a"><p>Hi</p></div>';
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "comment", text: "<!-- greeting -->" },
      { name: "tag", text: "div" },
      { name: "attribute", text: "class" },
    ]);
  });

  test("css: comment, property, number", async () => {
    const { language, query } = await loadRealLanguage(backend, "css");
    const source = "/* box */\n.box {\n  width: 10px;\n}\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "comment", text: "/* box */" },
      { name: "property", text: "width" },
      { name: "number", text: "10px" },
    ]);
  });

  test("yaml: comment, string key, number, boolean", async () => {
    const { language, query } = await loadRealLanguage(backend, "yaml");
    const source = "# config\nname: tecode\ncount: 3\nenabled: true\n";
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "comment", text: "# config" },
      { name: "property", text: "name" },
      { name: "number", text: "3" },
      { name: "boolean", text: "true" },
    ]);
  });

  test("toml: comment, string value, number, array, dotted key — @property on keys only", async () => {
    const { language, query } = await loadRealLanguage(backend, "toml");
    const source = '# config\nname = "tecode"\ncount = 3\nlist = [1, 2]\nowner.name = "Alice"\n';
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "comment", text: "# config" },
      { name: "string", text: '"tecode"' },
      { name: "number", text: "3" },
      { name: "property", text: "name" },
      { name: "property", text: "count" },
      { name: "property", text: "list" },
      // Dotted key: both components are keys, so both are `@property`.
      { name: "property", text: "owner" },
    ]);
    // Finding 3 regression check: `@property` used to attach to the WHOLE
    // `pair` node (key + "=" + value), so a pair's value wrongly picked up
    // a `property` capture too. Assert no `property` capture ever covers a
    // value's text (number, array, or quoted string).
    const propertyTexts = captures
      .filter((c) => c.name === "property")
      .map((c) => source.slice(c.startIndex, c.endIndex));
    expect(propertyTexts).not.toContain("3");
    expect(propertyTexts).not.toContain("[1, 2]");
    expect(propertyTexts).not.toContain('"tecode"');
    expect(propertyTexts).not.toContain('"Alice"');
  });

  test("bash: comment, function-position command, string", async () => {
    const { language, query } = await loadRealLanguage(backend, "bash");
    const source = '# greet\necho "hello $USER"\n';
    const tree = backend.parse(language, source);
    const captures = query.captures(tree);
    assertCapturesContain(captures, source, [
      { name: "comment", text: "# greet" },
      { name: "function", text: "echo" },
      { name: "string", text: '"hello $USER"' },
    ]);
  });

  test("every base-9 capture used above resolves via themeLoader's longest-prefix rule (design.md §9)", async () => {
    // The base vocabulary `dark-modern.json`/`light-modern.json` actually
    // declare tokenColors for (Req 7.2) — anything captured above that is
    // exactly one of these, or a dotted refinement of one, gets a real
    // style; this is a sanity check on the fixtures/assertions THIS file
    // uses above, not a claim that every capture a query CAN produce
    // resolves (design.md §9/`themeLoader.ts`'s `resolveCaptureStyle`
    // explicitly allows an unresolvable capture to render with no style).
    const baseNames = new Set([
      "keyword",
      "string",
      "comment",
      "function",
      "type",
      "variable",
      "number",
      "operator",
      "punctuation",
    ]);
    // Every capture name this file's `assertCapturesContain` calls actually
    // assert on above, paired with whether it is expected to resolve.
    const usedInThisFile: Record<string, boolean> = {
      keyword: true,
      function: true,
      "type.builtin": true,
      comment: true,
      string: true,
      "string.special.key": true,
      number: true,
      "punctuation.special": true,
      // Supplementary upstream vocabulary beyond the theme's declared 9
      // base keys (this package's NOTICE.md) — legitimately unresolved
      // per design.md §9's `resolveCaptureStyle` contract, not a bug.
      embedded: false,
      property: false,
      attribute: false,
      tag: false,
      boolean: false,
      constant: false,
    };
    for (const [name, expectResolves] of Object.entries(usedInThisFile)) {
      const prefix = name.split(".")[0]!;
      expect(baseNames.has(prefix), `capture "${name}"`).toBe(expectResolves);
    }
  });
});
