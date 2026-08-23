/**
 * Aggregates every built-in extension's manifest into one array, for
 * `@tecode/core`'s `loadExtensions({ builtins, ... })` dependency (Req 2.1;
 * design.md §4.1, §4.4: "Built-ins are compiled into the binary as
 * ordinary imports [...] their manifest data in a static registry").
 *
 * `discovery.ts` never scans this package's directories off disk — a
 * built-in's manifest reaches the host as a plain compiled-in `import`,
 * not through the `user`/`workspace` filesystem-scanning path (which is
 * exactly why `discovery.ts`'s `DiscoveryDeps.builtins` exists as a
 * separate parameter rather than a third scanned directory).
 *
 * **`builtinModules`** (Task 2.3) is this same "compiled-in, not
 * filesystem-loaded" story for a built-in's actual `activate`/
 * `deactivate` implementation: `packages/cli/src/extensionRecords.ts`'s
 * `ExtensionRecord.loadModule` for a `source: "builtin"` extension has no
 * real directory to dynamically `import()` (`discovery.ts` gives built-ins
 * a synthetic `<builtin>/<id>` `sourcePath`) — it looks `extensionId` up in
 * this map instead, so adding a built-in here is "import its manifest AND
 * its module, push the manifest, add the module to the map" — one
 * composition point for both halves, not two separate wiring sites to keep
 * in sync.
 *
 * Every other `packages/builtin/*` package (`command-palette`, `explorer`,
 * `keybindings-editor`, `languages-basic`, `statusbar`) is still a
 * placeholder with no `manifest.ts` — each is its own later task
 * (tasks.md's Phase 2/3 built-in tasks). `themes-default` (Task 2.7, Req
 * 11.4) is the second one wired in here.
 *
 * **`builtinThemeAssets`** (Task 2.7, design.md §3): the embedded-JSON
 * counterpart to `builtinModules` above, for a built-in's
 * `contributes.themes` files specifically — see
 * `themes-default/assets.ts`'s TSDoc for the full "why" (a built-in has no
 * real directory for `ThemeRegistry`'s normal `fs.readFile` to resolve
 * against) and `packages/cli/src/themeAssetsFs.ts` for how this map is
 * spliced into `ThemeRegistry`'s filesystem seam. Aggregated the same way
 * `builtinManifests`/`builtinModules` are — one object literal per
 * built-in, spread together here — so adding a built-in with its own theme
 * assets later is "add its manifest, its module, AND its asset map" at
 * this one composition point, not a fourth wiring site to keep in sync.
 */

import type { ExtensionContext, Manifest } from "@tecode/api";
import * as editorCoreModule from "./editor-core/index";
import editorCoreManifest from "./editor-core/manifest";
import * as themesDefaultModule from "./themes-default/index";
import themesDefaultManifest, {
  DARK_MODERN_THEME_ID,
  LIGHT_MODERN_THEME_ID,
} from "./themes-default/manifest";
import { builtinThemeAssets as themesDefaultAssets } from "./themes-default/assets";
import * as languagesBasicModule from "./languages-basic/index";
import languagesBasicManifest, { LANGUAGES_BASIC_EXTENSION_ID } from "./languages-basic/manifest";
import {
  builtinLanguageGrammarAssets as languagesBasicGrammarAssets,
  builtinLanguageQueryAssets as languagesBasicQueryAssets,
} from "./languages-basic/assets";

// Re-exported so callers outside this package (`packages/cli`'s tests,
// mainly) can reference the real built-in theme/language-pack ids without a
// package subpath import into `themes-default/manifest.ts` or
// `languages-basic/manifest.ts` directly.
export { DARK_MODERN_THEME_ID, LIGHT_MODERN_THEME_ID, LANGUAGES_BASIC_EXTENSION_ID };

/**
 * The `activate(ctx)`/`deactivate()` shape a built-in's `index.ts` exports
 * (Req 2.6) — `@tecode/core`'s `host/activation.ts` `ExtensionModule`
 * structurally, duplicated locally since `@tecode/api` declares no such
 * type (an extension module's shape is a host/runtime concern, not part of
 * the public API surface extensions program against) and `editor-core`
 * cannot import `@tecode/core` (the ESLint layering rule).
 */
interface BuiltinExtensionModule {
  activate?(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Every built-in extension's manifest, compiled in as a static import
 * (this module's TSDoc). */
export const builtinManifests: Manifest[] = [
  editorCoreManifest,
  themesDefaultManifest,
  languagesBasicManifest,
];

/** Every built-in extension's real implementation module, keyed by
 * `manifest.id` (this module's TSDoc's `builtinModules`) — what
 * `extensionRecords.ts`'s `loadModule` resolves to for a built-in instead
 * of a dynamic `import()`. */
export const builtinModules: Record<string, BuiltinExtensionModule> = {
  [editorCoreManifest.id]: editorCoreModule,
  [themesDefaultManifest.id]: themesDefaultModule,
  [languagesBasicManifest.id]: languagesBasicModule,
};

/** Every built-in extension's embedded theme JSON assets, keyed by the
 * synthetic `<builtin>/<id>/<path>` `ThemeRegistry` resolves a manifest
 * theme's `path` to (this module's TSDoc's `builtinThemeAssets`). Only
 * `themes-default` contributes any today. */
export const builtinThemeAssets: Record<string, string> = {
  ...themesDefaultAssets,
};

/** Every built-in extension's embedded language GRAMMAR (WASM) assets,
 * keyed by the synthetic `<builtin>/<id>/<path>` `AssetResolver` resolves a
 * manifest language's `grammar` path to (Req 8.4, 8.5;
 * `languages-basic/assets.ts`'s TSDoc's `builtinLanguageGrammarAssets`) —
 * one lazy `() => Promise<Uint8Array>` reader per path, not the bytes
 * themselves (that module's TSDoc explains why). Only `languages-basic`
 * contributes any today. */
export const builtinLanguageGrammarAssets: Record<string, () => Promise<Uint8Array>> = {
  ...languagesBasicGrammarAssets,
};

/** Every built-in extension's embedded language highlight-QUERY (`.scm`)
 * assets, keyed the same way as {@link builtinLanguageGrammarAssets} above
 * — plain already-decoded strings, since Bun's `"text"` loader gives
 * `languages-basic/assets.ts` the text synchronously at module-eval time.
 * Only `languages-basic` contributes any today. */
export const builtinLanguageQueryAssets: Record<string, string> = {
  ...languagesBasicQueryAssets,
};
