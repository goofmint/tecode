/**
 * Overlays `@tecode/core`'s `ThemeRegistry` filesystem seam
 * (`ThemeRegistryFs`) with `@tecode/builtin`'s embedded theme JSON assets
 * (Req 11.4; design.md §3, §4.4) — so a built-in's `contributes.themes`
 * entry loads correctly from BOTH `ThemeRegistry.loadContributions`'s
 * deferred-phase path and `main.ts`'s own sync-phase pre-first-frame load,
 * in dev mode (`bun run`) and inside a `bun build --compile` binary alike.
 *
 * **Why an overlay is needed at all**: a built-in extension has no real
 * directory on disk — `discovery.ts` gives it a synthetic
 * `<builtin>/<id>` `sourcePath` (`extensionRecords.ts`'s TSDoc) — so
 * `ThemeRegistry`'s normal `join(baseDir, contribution.path)` then
 * `fs.readFile(...)` load path can never actually resolve for a built-in
 * theme; without this overlay it would silently fail to `themeLoader.ts`'s
 * base-palette fallback (Req 7.2's per-key degrade), which would satisfy
 * NO test asserting the real Dark Modern/Light Modern colors are active.
 * `@tecode/builtin`'s `builtinThemeAssets` map — keyed by exactly that
 * same `<builtin>/<id>/<path>` string (`themes-default/assets.ts`'s TSDoc)
 * — supplies the theme's JSON text directly instead.
 *
 * **One overlay, every call site**: `createThemeRegistry({ fs, ... })`
 * takes this overlay ONCE, in `buildAssemblyRoot` — every subsequent
 * `register`/`loadContributions` call against that same registry instance
 * (the sync-phase built-in pre-load in `buildAssemblyRoot` itself, and the
 * deferred phase's `loadContributions` re-registering every discovered
 * `contributes.themes` entry, including the SAME two built-in ones) reads
 * through this one seam — no second, divergent loading path to keep in
 * sync.
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import type { ThemeRegistryFs } from "@tecode/core";

/**
 * Build a {@link ThemeRegistryFs} that serves any path present in `assets`
 * from that embedded string, falling back to a real `node:fs/promises`
 * read for everything else (a `user`/`workspace` extension's real theme
 * file, which DOES live on disk). `assets` is a parameter (rather than
 * hardcoding `@tecode/builtin`'s `builtinThemeAssets`) purely so tests can
 * substitute a small fixture map without depending on the real built-in
 * theme JSON.
 */
export function createBuiltinThemeAssetsFs(assets: Readonly<Record<string, string>>): ThemeRegistryFs {
  const realFs = { readFile: (path: string) => nodeReadFile(path, "utf8") };
  return {
    readFile(path: string): Promise<string> {
      const embedded = assets[path];
      return embedded !== undefined ? Promise.resolve(embedded) : realFs.readFile(path);
    },
  };
}
