# `languages-basic` — vendored asset provenance (Req 8.4, Task 2.9)

This built-in extension bundles 12 tree-sitter grammar WASMs and 12
`.scm` highlight queries for the MVP language set (Req 8.4). This file
records where each came from, its license, and every trade-off made while
vendoring it. Upstream `LICENSE` texts are preserved verbatim under
[`LICENSES/`](./LICENSES).

**Total vendored grammar size**: 12 files, **5,780,762 bytes (≈5.51 MB)** —
comfortably inside design.md §15's "~10–15 MB total" estimate for Task
4.4's ≤120 MB binary-size budget. Query text adds ~52 KB more.

| Language id | Extensions | Grammar source (npm package @ version) | Wasm file | License | Query source |
|---|---|---|---|---|---|
| `typescript` | `.ts` `.tsx` `.mts` `.cts` | `tree-sitter-typescript@0.23.2` — the `tsx` grammar (see "TypeScript uses the `tsx` grammar" below) | `tree-sitter-tsx.wasm` → `typescript.wasm` | MIT | `tree-sitter-typescript@0.23.2`'s `queries/highlights.scm`, **concatenated with** `tree-sitter-javascript@0.25.0`'s `queries/highlights.scm` (see "TypeScript's query is JS ∪ TS-only" below) |
| `javascript` | `.js` `.jsx` `.mjs` `.cjs` | `tree-sitter-javascript@0.25.0` | `tree-sitter-javascript.wasm` | MIT | `tree-sitter-javascript@0.25.0`'s `queries/highlights.scm`, unmodified |
| `json` | `.json` | `tree-sitter-json@0.24.8` | `tree-sitter-json.wasm` | MIT | `tree-sitter-json@0.24.8`'s `queries/highlights.scm`, unmodified |
| `markdown` | `.md` `.markdown` | `@tree-sitter-grammars/tree-sitter-markdown` — **GitHub Release `v0.5.3`** (see "Markdown: release asset, not npm" below), block grammar only | `tree-sitter-markdown.wasm` (release asset) | MIT | Custom (this task) — see "Markdown query rewritten" below |
| `python` | `.py` `.pyi` | `tree-sitter-python@0.25.0` | `tree-sitter-python.wasm` | MIT | `tree-sitter-python@0.25.0`'s `queries/highlights.scm`, unmodified |
| `rust` | `.rs` | `tree-sitter-rust@0.24.0` | `tree-sitter-rust.wasm` | MIT | `tree-sitter-rust@0.24.0`'s `queries/highlights.scm`, unmodified |
| `go` | `.go` | `tree-sitter-go@0.25.0` | `tree-sitter-go.wasm` | MIT | `tree-sitter-go@0.25.0`'s `queries/highlights.scm`, unmodified |
| `html` | `.html` `.htm` | `tree-sitter-html@0.23.2` | `tree-sitter-html.wasm` | MIT | `tree-sitter-html@0.23.2`'s `queries/highlights.scm`, unmodified |
| `css` | `.css` | `tree-sitter-css@0.25.0` | `tree-sitter-css.wasm` | MIT | `tree-sitter-css@0.25.0`'s `queries/highlights.scm`, unmodified |
| `yaml` | `.yaml` `.yml` | `@tree-sitter-grammars/tree-sitter-yaml@0.7.1` | `tree-sitter-yaml.wasm` | MIT | `@tree-sitter-grammars/tree-sitter-yaml@0.7.1`'s `queries/highlights.scm`, unmodified |
| `toml` | `.toml` | `@tree-sitter-grammars/tree-sitter-toml@0.7.0` | `tree-sitter-toml.wasm` | MIT | `@tree-sitter-grammars/tree-sitter-toml@0.7.0`'s `queries/highlights.scm`, unmodified |
| `bash` | `.sh` `.bash` | `tree-sitter-bash@0.25.1` | `tree-sitter-bash.wasm` | MIT | `tree-sitter-bash@0.25.1`'s `queries/highlights.scm`, unmodified |

All 12 wasm binaries were loaded and their queries compiled against the
repo's own `web-tree-sitter@0.25.10` (`Parser.init()` + `Language.load(bytes)`
+ `new Query(language, source)`) as part of this task's verification —
every one of them loads and compiles cleanly (see
`packages/cli/src/languagesBasicHighlights.test.ts`). Grammar ABI versions
observed: 14 (typescript/tsx, json, rust, html, yaml, toml) and 15
(javascript, markdown, python, go, bash, css) — both within
`web-tree-sitter@0.25.10`'s supported range.

## TypeScript uses the `tsx` grammar for both `.ts` and `.tsx`

`@tecode/api`'s `LanguageContribution` has exactly one `grammar` field per
language id, and `tree-sitter-typescript` ships two separate grammars
(`typescript`, no JSX; `tsx`, JSX-enabled). Rather than adding a 13th
vendored grammar (splitting `typescript`/`typescript-tsx` into two language
ids and breaking design.md §15's "12 grammar WASMs" count), this extension
uses the `tsx` grammar — a near-total syntactic superset of `typescript` —
for **both** extensions. The one known gap: the legacy `<T>value`
angle-bracket type-assertion syntax is ambiguous with a JSX element and
disabled in the `tsx` grammar; modern code writes `value as T` instead, so
this is a narrow, MVP-acceptable trade-off. `javascript` needs no such
choice — `tree-sitter-javascript` parses JSX natively, so one grammar
already covers `.js`/`.jsx`/`.mjs`/`.cjs`.

## TypeScript's query is JS ∪ TS-only

`tree-sitter-typescript@0.23.2`'s own `queries/highlights.scm` is
deliberately partial upstream (types, TS-only keywords, generics) — it is
designed to be **layered on top of** `tree-sitter-javascript`'s query
(the TypeScript grammar reuses most of JavaScript's node types), which is
exactly what nvim-treesitter/helix do for TS. `queries/typescript.scm` in
this extension is therefore the literal concatenation of
`tree-sitter-javascript@0.25.0`'s `highlights.scm` followed by
`tree-sitter-typescript@0.23.2`'s own — verified (with a real fixture) to
produce full keyword/function/string/comment/number captures, not just the
TS-only additions.

## Markdown: release asset, not npm

`@tree-sitter-grammars/tree-sitter-markdown`'s latest npm publish is
`0.3.2`, but its `package.json`/`tree-sitter.json` ship **no `.wasm` file**
at all (only native `.node` prebuilds for the Node binding) — none of the
several prebuilt-WASM aggregator packages surveyed for this task
(`tree-sitter-wasms`, `@repomix/tree-sitter-wasms`,
`@unit-mesh/treesitter-artifacts`, `@vscode/tree-sitter-wasm`,
`tree-sitter-wasm-prebuilt`) include a Markdown grammar either — Markdown's
two-grammar (block + inline) design with a native scanner makes it an
outlier that most WASM-aggregator projects skip. Its GitHub repository's
own release CI (`tree-sitter/workflows`'s reusable `release.yml`, which
itself runs `tree-sitter build --wasm` — **their** build step, not this
task's) does publish `.wasm` files as **GitHub Release assets** on every
tag, independent of npm publishing. This task downloaded the already-built
`tree-sitter-markdown.wasm` and `tree-sitter-markdown_inline.wasm` from
release tag `v0.5.3`
(`https://github.com/tree-sitter-grammars/tree-sitter-markdown/releases/download/v0.5.3/`)
— a prebuilt artifact, per this task's "prefer prebuilt WASMs, do not build
from source with emscripten" instruction; no grammar was compiled from
source for this task. Only `tree-sitter-markdown.wasm` (the **block**
grammar) is vendored; `tree-sitter-markdown_inline.wasm` was downloaded but
is **not** wired into the manifest — see "Markdown is block-only" below.
`tree-sitter.json`'s `metadata.version` at this tag is `0.5.3`, license
MIT (`LICENSES/tree-sitter-markdown.LICENSE`, copyright Matthias Deiml).

### Markdown is block-only (no inline emphasis/link/code-span highlighting)

Real Markdown highlighting needs TWO tree-sitter grammars: `markdown`
(headings, lists, code fences, block quotes — the structural, "block"
layer) and `markdown_inline` (bold/italic/inline-code/links — the "inline"
layer nested inside paragraph/inline text). Upstream wires these together
via an **injection query** (`injections.scm`): the block grammar leaves
inline spans as an opaque `(inline)` node, and the injection tells the host
editor to re-parse that span's text with the *inline* grammar and merge its
captures back in. `@tecode/api`'s `LanguageContribution` (Req 8.2) has
exactly one `grammar`/`highlights` pair and no injection mechanism at all —
there is currently no seam for a second, nested grammar. This MVP therefore
highlights Markdown's **block structure only** (headings, code fences,
list/blockquote markers, thematic breaks, link destinations) via
`markdown.wasm` + a from-scratch `queries/markdown.scm` (see below);
emphasis, strong emphasis, inline code spans, and inline links inside
paragraph text render as plain, unhighlighted text. Wiring the inline
grammar in is future work gated on `@tecode/api` gaining an injection
mechanism — out of this task's scope.

### Markdown query rewritten, not the upstream nvim-treesitter one

The task's fallback plan was "nvim-treesitter's query" if no first-party
`highlights.scm` exists for a grammar (true here — the vendored
`tree-sitter-markdown` package ships no query at all in its npm tarball;
one only exists in the GitHub source tree, credited there as "From
nvim-treesitter/nvim-treesitter"). That query's capture names
(`@text.title`, `@text.literal`, `@text.uri`, `@text.reference`,
`@punctuation.special`, `@string.escape`, `@none`) are nvim's own
highlight-group vocabulary, not this project's — `themeLoader.ts`'s
`resolveCaptureStyle` longest-prefix fallback only resolves a capture to a
style if it (or a dotted-prefix ancestor) is one of the theme's declared 9
base keys (`keyword`/`string`/`comment`/`function`/`type`/`variable`/
`number`/`operator`/`punctuation`, design.md §9) — a `text.*` capture has no
such ancestor and would render completely unstyled, which would make this
MVP's Markdown highlighting a no-op in practice. `queries/markdown.scm` is
therefore a **from-scratch rewrite**, targeting the SAME grammar node types
the nvim-treesitter query does (confirmed against `tree-sitter-markdown`'s
own `node-types.json`) but captured under this project's base vocabulary
instead (e.g. heading text → `@keyword`, code blocks → `@string`, list/rule
markers → `@punctuation.special`, block quotes → `@comment`). Verified to
compile against the real grammar and to produce the expected spans on a
sample fixture (`packages/cli/src/languagesBasicHighlights.test.ts`).

## No query predicates needed stripping

Every vendored query was checked for tree-sitter predicates
(`#eq?`/`#match?`/`#is-not?`/etc.) and each one compiled successfully,
as-is, against its real grammar via `web-tree-sitter@0.25.10`'s `Query`
constructor — none needed simplifying or stripping. (Only `#match?`,
`#eq?`, and `#is-not?` appear across the whole set — all natively supported
by `web-tree-sitter`.)

## Captures beyond the theme's 9 base keys render unstyled — by design

Several vendored (unmodified, upstream) queries emit captures with no
matching prefix in the theme's declared `tokenColors` keys — e.g. `@tag`/
`@attribute` (HTML), `@property` (CSS/YAML/TOML/JS/Go/Bash), `@constant`/
`@constructor` (JS/TS/Python/Rust), `@escape` (not `.escape` — Go/Python/
JSON), `@embedded` (JS/Python/Bash), `@boolean` (YAML). This is a
legitimate, explicitly-designed outcome, not a bug: design.md §9 / Req 7.2
and `themeLoader.ts`'s `resolveCaptureStyle` TSDoc both state a capture
with no theme match simply renders with no style opinion — "does not
require every possible capture to have one." No query was edited to avoid
this; editing upstream queries to chase 100% theme coverage would diverge
them from their maintained source for no functional benefit (a future
theme can always add `tokenColors` entries for any of these keys without
touching this package at all).

## How grammar WASM / query text are embedded (Req 8.5)

`assets.ts` imports each `.wasm` with Bun's `"file"` loader
(`import p from "./grammars/x.wasm" with { type: "file" }`) and reads it
via `Bun.file(p).bytes()`, and each `.scm` with Bun's `"text"` loader
(`import t from "./queries/x.scm" with { type: "text" }`, already-decoded
text, no further read). **Verified working in both modes**:

- `bun run` (dev): `p` is a real filesystem path; `Bun.file(p).bytes()`
  reads it straight off disk.
- `bun build --compile`: Bun embeds the referenced asset INTO the compiled
  binary and rebinds `p` to a `/$bunfs/...` virtual path; `Bun.file(p)
  .bytes()` reads the embedded bytes correctly — confirmed with a
  throwaway `bun build --compile` smoke test using a real grammar wasm
  (deleting the source file afterward to prove it wasn't reading off disk).

## Compiled-mode finding for Task 4.4 — RESOLVED: `web-tree-sitter`'s own runtime wasm is now embedded

Smoke-testing this task's whole `packages/cli/src/main.ts` through
`bun build --compile` and opening a recognized-extension file (e.g. a
`.ts` file) used to surface:

```text
failed to asynchronously prepare wasm: Error: ENOENT: no such file or directory, open '/$bunfs/root/tree-sitter.wasm'
Aborted(Error: ENOENT: no such file or directory, open '/$bunfs/root/tree-sitter.wasm')
```

This was **not** one of `languages-basic`'s own vendored grammar/query
assets (those load correctly, per the previous section) — it was
`web-tree-sitter`'s own Emscripten-compiled RUNTIME wasm
(`node_modules/web-tree-sitter/tree-sitter.wasm`, the tree-sitter C library
itself, loaded once by `Parser.init()` before any grammar can load), which
`parserBackend.ts`'s `createWebTreeSitterParserBackend` (Task 2.8) used to
call with no arguments: `Parser.init()`.

**Fixed** (a code-review follow-up on this task): `createWebTreeSitterParserBackend`
now takes an optional `runtimeWasm?: Uint8Array | (() => Promise<Uint8Array>)`
dependency (`parserBackend.ts`'s `WebTreeSitterParserBackendDeps`) and, when
given, calls `Parser.init({ wasmBinary })` with the resolved bytes instead of
letting Emscripten's `locateFile` machinery look for a `tree-sitter.wasm`
path on disk — bytes, not a relocated path, since that's what stays
deterministic under Bun in both dev and compiled mode. `packages/cli`'s
composition root (`main.ts`) supplies those bytes: it embeds
`web-tree-sitter/tree-sitter.wasm` the exact same way this package's own
`assets.ts` embeds grammar wasms (`import path from "web-tree-sitter/
tree-sitter.wasm" with { type: "file" }` + `Bun.file(path).bytes()`), since
`@tecode/core` has no bundler-visible asset file of its own to embed for
this — `web-tree-sitter` is an ordinary npm dependency there, not a vendored
asset. Verified in both modes: `TECODE_HEADLESS=1 bun packages/cli/src/
main.ts <dir-with-a-.ts-file>` (dev) and a `bun build --compile` binary run
the same way both exit 0 with no `tree-sitter.wasm` ENOENT/`Aborted` on
stderr and `loaded: 3`; the SAME compiled-binary smoke rebuilt from the
pre-fix code reproduces the exact `ENOENT`/`Aborted` output above, confirming
this is what fixed it.
