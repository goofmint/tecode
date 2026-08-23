/**
 * Embedded-asset wiring for `languages-basic`'s vendored grammar WASMs and
 * `.scm` highlight queries (Req 8.4, 8.5; design.md §10, §13) — this
 * package's counterpart to `themes-default/assets.ts`, which that module's
 * TSDoc documents in full ("why this exists at all", "key shape"); this
 * TSDoc covers only what differs for binary grammar assets.
 *
 * **Binary bytes, not JSON text**: `themes-default/assets.ts` re-serializes
 * a statically-imported JSON module back into a string (its own loader
 * already gives it a parsed object) — a grammar WASM has no such text
 * form. Each `.wasm` is instead imported with Bun's `"file"` loader
 * (`import path from "./grammars/x.wasm" with { type: "file" }`), which
 * embeds the ASSET ITSELF (not its path) into a `bun build --compile`
 * binary and binds `path` to wherever it landed — a real filesystem path
 * under `bun run`, a `/$bunfs/...` virtual path once compiled — either way
 * `Bun.file(path).arrayBuffer()` reads the actual bytes back correctly
 * (verified empirically for this task, both under `bun run` and a
 * `bun build --compile` smoke build — see `NOTICE.md`). `.scm` query text
 * uses Bun's `"text"` loader instead (`with { type: "text" }`): the
 * import's binding IS the decoded UTF-8 string already, inlined as a JS
 * string literal at bundle time in BOTH modes — no further read needed,
 * which is why {@link builtinLanguageQueryAssets} below is a plain
 * `Record<string, string>` synchronously built at module-eval time exactly
 * like `themes-default`'s theme map, while {@link builtinLanguageGrammarAssets}
 * is a `Record<string, () => Promise<Uint8Array>>` — an async accessor per
 * path — since reading a `Bun.file(path)` IS itself an (async) read,
 * unlike a string already sitting in memory.
 *
 * **Key shape**: identical convention to `themes-default/assets.ts` —
 * `join("<builtin>/tecode.languages-basic", contribution.grammar |
 * contribution.highlights)` — the exact string `LanguageRegistry`/
 * `AssetResolver` build internally by joining a manifest language's
 * `grammar`/`highlights` path against its owning extension's directory
 * (`assetResolver.ts`'s `resolvePath`), so `languageAssetsFs.ts`'s overlay
 * (`packages/cli`) needs no path transformation — a straight map lookup.
 */

import { join } from "node:path";
import manifest from "./manifest";

import typescriptGrammarPath from "./grammars/typescript.wasm" with { type: "file" };
import javascriptGrammarPath from "./grammars/javascript.wasm" with { type: "file" };
import jsonGrammarPath from "./grammars/json.wasm" with { type: "file" };
import markdownGrammarPath from "./grammars/markdown.wasm" with { type: "file" };
import pythonGrammarPath from "./grammars/python.wasm" with { type: "file" };
import rustGrammarPath from "./grammars/rust.wasm" with { type: "file" };
import goGrammarPath from "./grammars/go.wasm" with { type: "file" };
import htmlGrammarPath from "./grammars/html.wasm" with { type: "file" };
import cssGrammarPath from "./grammars/css.wasm" with { type: "file" };
import yamlGrammarPath from "./grammars/yaml.wasm" with { type: "file" };
import tomlGrammarPath from "./grammars/toml.wasm" with { type: "file" };
import bashGrammarPath from "./grammars/bash.wasm" with { type: "file" };

import typescriptHighlights from "./queries/typescript.scm" with { type: "text" };
import javascriptHighlights from "./queries/javascript.scm" with { type: "text" };
import jsonHighlights from "./queries/json.scm" with { type: "text" };
import markdownHighlights from "./queries/markdown.scm" with { type: "text" };
import pythonHighlights from "./queries/python.scm" with { type: "text" };
import rustHighlights from "./queries/rust.scm" with { type: "text" };
import goHighlights from "./queries/go.scm" with { type: "text" };
import htmlHighlights from "./queries/html.scm" with { type: "text" };
import cssHighlights from "./queries/css.scm" with { type: "text" };
import yamlHighlights from "./queries/yaml.scm" with { type: "text" };
import tomlHighlights from "./queries/toml.scm" with { type: "text" };
import bashHighlights from "./queries/bash.scm" with { type: "text" };

/** This extension's synthetic built-in directory (`themes-default/
 * assets.ts`'s TSDoc) — matches `discovery.ts`'s
 * `sourcePath: \`<builtin>/${extensionId}\`` for `extensionId === manifest.id`. */
const EXTENSION_DIR = `<builtin>/${manifest.id}`;

/** `<builtin>/tecode.languages-basic/grammars/<lang>.wasm` -> a lazy reader
 * for that grammar's raw bytes (this module's TSDoc). A function, not the
 * bytes themselves: `Bun.file(path).arrayBuffer()` is itself async (unlike
 * `builtinLanguageQueryAssets`' plain strings), and only 1-2 of these 12
 * grammars are ever actually read in a typical run (`highlightService.ts`'s
 * per-language, first-open-only load) — building every `Uint8Array` eagerly
 * at module-eval time would do the other 10+ languages' worth of I/O for
 * nothing. */
export const builtinLanguageGrammarAssets: Record<string, () => Promise<Uint8Array>> = {
  [join(EXTENSION_DIR, "grammars/typescript.wasm")]: () => Bun.file(typescriptGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/javascript.wasm")]: () => Bun.file(javascriptGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/json.wasm")]: () => Bun.file(jsonGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/markdown.wasm")]: () => Bun.file(markdownGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/python.wasm")]: () => Bun.file(pythonGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/rust.wasm")]: () => Bun.file(rustGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/go.wasm")]: () => Bun.file(goGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/html.wasm")]: () => Bun.file(htmlGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/css.wasm")]: () => Bun.file(cssGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/yaml.wasm")]: () => Bun.file(yamlGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/toml.wasm")]: () => Bun.file(tomlGrammarPath).bytes(),
  [join(EXTENSION_DIR, "grammars/bash.wasm")]: () => Bun.file(bashGrammarPath).bytes(),
};

/** `<builtin>/tecode.languages-basic/queries/<lang>.scm` -> that language's
 * raw highlight-query text (this module's TSDoc) — already-decoded strings,
 * synchronously available at module-eval time (Bun's `"text"` loader). */
export const builtinLanguageQueryAssets: Record<string, string> = {
  [join(EXTENSION_DIR, "queries/typescript.scm")]: typescriptHighlights,
  [join(EXTENSION_DIR, "queries/javascript.scm")]: javascriptHighlights,
  [join(EXTENSION_DIR, "queries/json.scm")]: jsonHighlights,
  [join(EXTENSION_DIR, "queries/markdown.scm")]: markdownHighlights,
  [join(EXTENSION_DIR, "queries/python.scm")]: pythonHighlights,
  [join(EXTENSION_DIR, "queries/rust.scm")]: rustHighlights,
  [join(EXTENSION_DIR, "queries/go.scm")]: goHighlights,
  [join(EXTENSION_DIR, "queries/html.scm")]: htmlHighlights,
  [join(EXTENSION_DIR, "queries/css.scm")]: cssHighlights,
  [join(EXTENSION_DIR, "queries/yaml.scm")]: yamlHighlights,
  [join(EXTENSION_DIR, "queries/toml.scm")]: tomlHighlights,
  [join(EXTENSION_DIR, "queries/bash.scm")]: bashHighlights,
};
