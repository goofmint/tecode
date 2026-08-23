/**
 * `languages-basic`'s manifest (Req 8.4, 11.5; design.md §13; tasks.md's
 * Task 2.9): a pure-contribution built-in extension — "languages-basic
 * SHALL provide the language set of Requirement 8" (Req 11.5) — bundling
 * declarations, vendored tree-sitter grammar WASMs, and highlight queries
 * for the 12 MVP languages (Req 8.4): TypeScript (incl. `.tsx`), JavaScript
 * (incl. `.jsx`), JSON, Markdown, Python, Rust, Go, HTML, CSS, YAML, TOML,
 * and Bash.
 *
 * **Pure-contribution, no `activationEvents`** (design.md §13's
 * "themes-default / languages-basic: pure-contribution extensions (no
 * `activate` logic beyond registration)"): every language here is
 * registered directly from `contributes.languages` during discovery/
 * registration (`@tecode/core`'s `host/registration.ts`), which never
 * executes `index.ts` — mirrors `themes-default/manifest.ts`'s identical
 * reasoning for `contributes.themes`. `onLanguage:<id>` activation events
 * exist purely so a `user`/`workspace` extension COULD declare interest in
 * one of these ids (`ExtensionHost.onLanguage`, `host/activation.ts`) —
 * this extension itself has no `activate` logic that would run on one.
 *
 * **`grammar`/`highlights` paths**: relative to this extension's own
 * directory (`languageRegistry.ts`'s `baseDir` parameter) — for a built-in,
 * that directory is the synthetic `<builtin>/tecode.languages-basic` label
 * `discovery.ts` assigns (no real directory exists on disk), which is why
 * `packages/cli`'s `languageAssetsFs.ts` (this task's counterpart to
 * `themeAssetsFs.ts`) serves these paths from `assets.ts`'s embedded maps
 * rather than a real `fs.readFile` (design.md §10).
 *
 * **One grammar per language id** (`@tecode/api`'s `LanguageContribution`
 * has exactly one `grammar` field): TypeScript's contribution uses the
 * `tsx` grammar (a strict syntactic superset of the plain `typescript`
 * grammar — every `.ts` file the `typescript` grammar accepts, the `tsx`
 * grammar accepts identically, with the sole, rare exception of the
 * legacy `<T>value` angle-bracket type-assertion syntax, ambiguous with a
 * JSX element and disabled in `tsx`; modern code uses `value as T`
 * instead) for BOTH `.ts` and `.tsx`, rather than shipping a second
 * `typescript-tsx`-id/grammar pair — keeping this extension at exactly 12
 * vendored grammar WASMs (design.md §15's "12 grammar WASMs (~10-15 MB
 * total)"), not 13. JavaScript needs no such trade-off: the `javascript`
 * grammar natively parses JSX, so one grammar covers `.js`/`.jsx`/`.mjs`/
 * `.cjs` already. See `NOTICE.md` for exact upstream source/version/license
 * per language and every other vendoring trade-off (the Markdown grammar's
 * block-only scope, chiefly).
 */

import type { Manifest } from "@tecode/api";

/** This extension's manifest id — exported so `NOTICE.md`/tests/`index.ts`
 * reference one shared constant. */
export const LANGUAGES_BASIC_EXTENSION_ID = "tecode.languages-basic";

const CURLY_PAREN_SQUARE = [
  { open: "{", close: "}" },
  { open: "(", close: ")" },
  { open: "[", close: "]" },
] as const;

const CURLY_SQUARE = [
  { open: "{", close: "}" },
  { open: "[", close: "]" },
] as const;

export default {
  id: LANGUAGES_BASIC_EXTENSION_ID,
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [
    "onLanguage:typescript",
    "onLanguage:javascript",
    "onLanguage:json",
    "onLanguage:markdown",
    "onLanguage:python",
    "onLanguage:rust",
    "onLanguage:go",
    "onLanguage:html",
    "onLanguage:css",
    "onLanguage:yaml",
    "onLanguage:toml",
    "onLanguage:bash",
  ],
  contributes: {
    languages: [
      {
        id: "typescript",
        extensions: [".ts", ".tsx", ".mts", ".cts"],
        grammar: "grammars/typescript.wasm",
        highlights: "queries/typescript.scm",
        comments: { line: "//", block: ["/*", "*/"] },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "javascript",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        grammar: "grammars/javascript.wasm",
        highlights: "queries/javascript.scm",
        comments: { line: "//", block: ["/*", "*/"] },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "json",
        extensions: [".json"],
        grammar: "grammars/json.wasm",
        highlights: "queries/json.scm",
        // Standard JSON has no comment syntax at all (unlike JSONC, which
        // `config/jsonc.ts` parses separately) — no `comments` entry.
        brackets: [...CURLY_SQUARE],
      },
      {
        id: "markdown",
        extensions: [".md", ".markdown"],
        grammar: "grammars/markdown.wasm",
        highlights: "queries/markdown.scm",
        // Markdown has no native line-comment syntax; an HTML comment is
        // the closest widely-supported equivalent, block-only.
        comments: { block: ["<!--", "-->"] },
        brackets: [],
      },
      {
        id: "python",
        extensions: [".py", ".pyi"],
        grammar: "grammars/python.wasm",
        highlights: "queries/python.scm",
        // Python has no real block-comment syntax (a triple-quoted string
        // is a string literal, not a comment) — line only.
        comments: { line: "#" },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "rust",
        extensions: [".rs"],
        grammar: "grammars/rust.wasm",
        highlights: "queries/rust.scm",
        comments: { line: "//", block: ["/*", "*/"] },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "go",
        extensions: [".go"],
        grammar: "grammars/go.wasm",
        highlights: "queries/go.scm",
        comments: { line: "//", block: ["/*", "*/"] },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "html",
        extensions: [".html", ".htm"],
        grammar: "grammars/html.wasm",
        highlights: "queries/html.scm",
        // HTML has only the SGML comment form — block only.
        comments: { block: ["<!--", "-->"] },
        brackets: [
          { open: "{", close: "}" },
          { open: "(", close: ")" },
          { open: "<", close: ">" },
        ],
      },
      {
        id: "css",
        extensions: [".css"],
        grammar: "grammars/css.wasm",
        highlights: "queries/css.scm",
        // CSS has only `/* ... */` — no line-comment form.
        comments: { block: ["/*", "*/"] },
        brackets: [...CURLY_PAREN_SQUARE],
      },
      {
        id: "yaml",
        extensions: [".yaml", ".yml"],
        grammar: "grammars/yaml.wasm",
        highlights: "queries/yaml.scm",
        comments: { line: "#" },
        brackets: [...CURLY_SQUARE],
      },
      {
        id: "toml",
        extensions: [".toml"],
        grammar: "grammars/toml.wasm",
        highlights: "queries/toml.scm",
        comments: { line: "#" },
        brackets: [...CURLY_SQUARE],
      },
      {
        id: "bash",
        extensions: [".sh", ".bash"],
        grammar: "grammars/bash.wasm",
        highlights: "queries/bash.scm",
        comments: { line: "#" },
        brackets: [...CURLY_PAREN_SQUARE],
      },
    ],
  },
} satisfies Manifest;
