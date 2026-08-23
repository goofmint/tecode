/**
 * `AssetResolver` (Req 8.2, 8.5; design.md §10): resolves a
 * {@link LanguageContribution}'s `grammar` (tree-sitter WASM) and
 * `highlights` (`.scm` query) paths against the owning extension's
 * directory (`languageRegistry.ts`'s `LanguageRegistry.getBaseDir`) and
 * reads them.
 *
 * **Dev-mode fs resolution only** (this task's scope): {@link
 * createAssetResolver}'s default implementation is a thin wrapper over
 * `node:fs/promises`, exactly like `themeRegistry.ts`'s
 * `createNodeThemeRegistryFs`. Task 4.4's compiled-mode binary embeds
 * grammar WASM/`.scm` files instead of shipping them on disk
 * (design.md §10's "resolved through an asset-URI indirection that works
 * identically in dev and compiled mode", `themeAssetsFs.ts`'s
 * `createBuiltinThemeAssetsFs` is the existing precedent for themes) — this
 * interface is deliberately narrow (two `readBinary`/`readText`-shaped
 * methods, taking already-resolved paths, with no other assumption about
 * where the bytes come from) so a future embedded-asset implementation can
 * satisfy {@link AssetResolver} exactly, and swap in at the composition
 * root, with zero changes to `highlightService.ts`.
 */

import { join } from "node:path";
import { readFile as nodeReadFile } from "node:fs/promises";

/** The narrow filesystem seam {@link createAssetResolver} needs: reading a
 * grammar's raw bytes and a highlight query's text. Injectable (matches
 * `themeRegistry.ts`'s `ThemeRegistryFs`, `documentManager.ts`'s
 * `DocumentManagerFs`) so tests can simulate language assets without
 * touching the real filesystem. */
export interface AssetResolverFs {
  readBinary(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}

function createNodeAssetResolverFs(): AssetResolverFs {
  return {
    readBinary: async (path) => new Uint8Array(await nodeReadFile(path)),
    readText: (path) => nodeReadFile(path, "utf8"),
  };
}

/** Dependencies for {@link createAssetResolver}. */
export interface AssetResolverDeps {
  /** Filesystem seam — see {@link AssetResolverFs}. Defaults to
   * `node:fs/promises`. */
  fs?: AssetResolverFs;
}

/** The asset resolver's public surface (Req 8.2, 8.5). */
export interface AssetResolver {
  /** Read a language's grammar WASM bytes. `grammarPath` is
   * `LanguageContribution.grammar`; `baseDir` (typically
   * `LanguageRegistry.getBaseDir(languageId)`) resolves it when given —
   * omitted, `grammarPath` is used as-is (mirrors `ThemeRegistry.register`'s
   * "no baseDir -> path used as-is" trade-off for a runtime
   * `tecode.languages.register` call, `languageRegistry.ts`'s TSDoc). */
  resolveGrammar(grammarPath: string, baseDir?: string): Promise<Uint8Array>;
  /** Read a language's `highlights.scm` query text. Same `baseDir`
   * resolution rule as {@link resolveGrammar}. */
  resolveHighlights(highlightsPath: string, baseDir?: string): Promise<string>;
}

function resolvePath(path: string, baseDir?: string): string {
  return baseDir ? join(baseDir, path) : path;
}

/** Build an {@link AssetResolver} (Req 8.2, 8.5). */
export function createAssetResolver(deps: AssetResolverDeps = {}): AssetResolver {
  const fs = deps.fs ?? createNodeAssetResolverFs();
  return {
    resolveGrammar(grammarPath, baseDir) {
      return fs.readBinary(resolvePath(grammarPath, baseDir));
    },
    resolveHighlights(highlightsPath, baseDir) {
      return fs.readText(resolvePath(highlightsPath, baseDir));
    },
  };
}
