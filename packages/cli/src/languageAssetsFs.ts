/**
 * Overlays `@tecode/core`'s `AssetResolver` filesystem seam
 * (`AssetResolverFs`) with `@tecode/builtin`'s embedded grammar/query
 * assets (Req 8.4, 8.5; design.md §10, §13) — this package's counterpart to
 * `themeAssetsFs.ts`, which that module's TSDoc documents in full ("why an
 * overlay is needed at all", "one overlay, every call site"); the same
 * reasoning applies verbatim here, substituting `LanguageRegistry`/
 * `AssetResolver`/a language's `grammar`/`highlights` paths for
 * `ThemeRegistry`/a theme's `path`.
 *
 * **Two asset maps, two read shapes**: `@tecode/builtin`'s
 * `builtinLanguageQueryAssets` is a plain `Record<string, string>` (a
 * `.scm` query's text is already decoded at module-eval time, exactly like
 * `builtinThemeAssets`) — `readText` below serves it with a synchronous
 * lookup wrapped in `Promise.resolve`, identical in shape to
 * `createBuiltinThemeAssetsFs.readFile`. `builtinLanguageGrammarAssets` is
 * instead `Record<string, () => Promise<Uint8Array>>` — a lazy per-path
 * reader (`languages-basic/assets.ts`'s TSDoc explains why: reading a
 * grammar's actual bytes off its embedded `Bun.file` handle is itself an
 * async operation, unlike a string already sitting in memory) — `readBinary`
 * below calls that accessor, rather than indexing straight into a
 * pre-built `Uint8Array` map, to preserve the "only the 1-2 languages a run
 * actually opens ever get their bytes read" property that module's TSDoc
 * documents.
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import type { AssetResolverFs } from "@tecode/core";

/**
 * Build an {@link AssetResolverFs} that serves any path present in
 * `grammarAssets`/`queryAssets` from that embedded source, falling back to
 * a real `node:fs/promises` read for everything else (a `user`/`workspace`
 * language extension's real grammar/query files, which DO live on disk).
 * Both maps are parameters (rather than hardcoding `@tecode/builtin`'s
 * exports) purely so tests can substitute small fixture maps without
 * depending on the real vendored grammars.
 */
export function createBuiltinLanguageAssetsFs(
  grammarAssets: Readonly<Record<string, () => Promise<Uint8Array>>>,
  queryAssets: Readonly<Record<string, string>>,
): AssetResolverFs {
  return {
    readBinary(path: string): Promise<Uint8Array> {
      const embedded = grammarAssets[path];
      return embedded ? embedded() : nodeReadFile(path).then((buf) => new Uint8Array(buf));
    },
    readText(path: string): Promise<string> {
      const embedded = queryAssets[path];
      return embedded !== undefined ? Promise.resolve(embedded) : nodeReadFile(path, "utf8");
    },
  };
}
