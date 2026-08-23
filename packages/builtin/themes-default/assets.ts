/**
 * Embedded-asset wiring for `themes-default`'s two theme JSON files (Req
 * 11.4; design.md §3's "themes-default's JSON files are embedded assets,
 * so no extension activation is needed to paint").
 *
 * **Why this exists at all**: a built-in extension has no real directory
 * on disk — `discovery.ts` gives it a synthetic `<builtin>/<id>`
 * `sourcePath` (`packages/cli/src/extensionRecords.ts`'s TSDoc) — so
 * `ThemeRegistry`'s normal `fs.readFile(join(baseDir, contribution.path))`
 * load path (`@tecode/core`'s `ui/themeRegistry.ts`) can never resolve a
 * manifest theme's `path` for a built-in; it would always fail to the
 * base-palette fallback. `packages/cli/src/themeAssetsFs.ts` fixes this by
 * overlaying `ThemeRegistry`'s filesystem seam: any path this module's
 * {@link builtinThemeAssets} map has an entry for is served from that
 * embedded string instead of a real `fs.readFile` — in BOTH `bun run` dev
 * mode and a `bun build --compile` binary, since Bun embeds an imported
 * JSON module's contents into the compiled binary at build time either
 * way (design.md §4.4, §10's "Loading inside the compiled binary").
 *
 * **Key shape**: `join("<builtin>/tecode.themes-default", contribution.path)`
 * — the exact same string `ThemeRegistry.register`/`loadContributions`
 * build internally by joining a manifest theme's `path` against its owning
 * extension's directory (`themeRegistry.ts`'s `register`'s TSDoc), so a
 * lookup against this map hits on the FIRST attempt to read either theme,
 * whether that attempt happens in `packages/cli/src/main.ts`'s sync-phase
 * pre-first-frame load or the deferred phase's `loadContributions` (both
 * paths share the one overlaid `fs` seam — `main.ts`'s TSDoc).
 *
 * **Text, not the parsed object**: `ThemeRegistryFs.readFile` returns a
 * `Promise<string>` (raw JSON *text*, then parsed by `themeLoader.ts`'s
 * `loadThemeFromJsonText` exactly like a file read off disk would be) —
 * `JSON.stringify` round-trips the statically-imported JSON module back
 * into that same text shape, rather than this module (or `packages/cli`)
 * inventing a second, object-shaped loading path that would diverge from
 * the one every non-built-in theme already goes through.
 */

import { join } from "node:path";
import darkModernJson from "./themes/dark-modern.json";
import lightModernJson from "./themes/light-modern.json";
import manifest from "./manifest";

/** This extension's synthetic built-in directory (this module's TSDoc) —
 * matches `discovery.ts`'s `sourcePath: \`<builtin>/${extensionId}\`` for
 * `extensionId === manifest.id`. */
const EXTENSION_DIR = `<builtin>/${manifest.id}`;

/** `<builtin>/tecode.themes-default/<path>` -> that theme's raw JSON text
 * (this module's TSDoc). Keyed exactly like `ThemeRegistry`'s own
 * `join(baseDir, contribution.path)` resolution, so `themeAssetsFs.ts`'s
 * overlay needs no path transformation of its own — a straight map
 * lookup. */
export const builtinThemeAssets: Record<string, string> = {
  [join(EXTENSION_DIR, "themes/dark-modern.json")]: JSON.stringify(darkModernJson),
  [join(EXTENSION_DIR, "themes/light-modern.json")]: JSON.stringify(lightModernJson),
};
