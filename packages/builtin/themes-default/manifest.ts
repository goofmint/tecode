/**
 * `themes-default`'s manifest (Req 11.4; Issue #124; design.md §3, §13): a
 * pure-contribution built-in extension providing Dark Modern, the one
 * theme embedded directly in the binary as the default (Req 11.4's "Dark
 * Modern is embedded as the built-in default theme"). Declares
 * `contributes.themes` only, exactly like `editor-core`'s `manifest.ts`
 * declares `contributes.commands`/`keybindings` — pure data, `export
 * default {...} satisfies Manifest`, read and validated by the host
 * WITHOUT executing `index.ts` (Req 2.2).
 *
 * **Light Modern moved out** (Issue #124): it now ships as a plain file at
 * the repository's top-level `themes/light-modern.json` — copyable to
 * `~/.config/tecode/themes/` and loaded through `packages/cli/src/
 * userThemes.ts`'s scanner, exactly like any other third-party theme, no
 * longer a `themes-default` contribution or an embedded asset.
 *
 * **No `activationEvents`** (design.md §13's "themes-default /
 * languages-basic: pure-contribution extensions (no `activate` logic
 * beyond registration)"): Dark Modern is registered directly from
 * `contributes.themes` during discovery/registration
 * (`host/registration.ts`'s `registerExtension`), which never executes
 * `index.ts` — there is nothing for an `activate(ctx)` call to do, so
 * this manifest declares no activation event at all rather than an
 * `onStartup` hook whose body would be empty. `index.ts` still exports a
 * (never-invoked, in this MVP) no-op `activate` purely to satisfy
 * `@tecode/builtin`'s `BuiltinExtensionModule` shape — see that file's
 * TSDoc.
 *
 * **Theme id** (`tecode.dark-modern`): namespaced under `tecode.` the
 * same way every other built-in id in this codebase is
 * (`tecode.editor-core`) — `packages/core/src/config/coreDefaults.ts`'s
 * `workbench.colorTheme` default DUPLICATES {@link DARK_MODERN_THEME_ID}'s
 * value as a literal string, rather than importing it, because `core`
 * cannot depend on `builtin` (the same one-directional layering
 * `extensionRecords.ts`'s `ColorDepth` type duplication follows for
 * `core`/`cli`) — so a fresh install with no `settings.json` entry
 * resolves to this extension's Dark Modern theme rather than the built-in
 * base palette (Req 7.5, `ThemeRegistry`'s `BASE_THEME_ID`).
 *
 * **`path` resolution**: relative to this extension's own directory
 * (`ui/themeRegistry.ts`'s `register`/`loadContributions` `baseDir`
 * parameter) — for a built-in, that directory is the synthetic
 * `<builtin>/tecode.themes-default` label `discovery.ts` assigns (no real
 * directory exists on disk), which is exactly why `packages/cli`'s
 * `createBuiltinThemeAssetsFs` (`themeAssetsFs.ts`) serves this path from
 * an embedded-JSON map (`assets.ts`'s `builtinThemeAssets`, keyed with
 * this EXACT `path` string) rather than a real `fs.readFile` — see that
 * module's TSDoc for the full pre-first-frame loading story (design.md
 * §3).
 */

import type { Manifest } from "@tecode/api";

/** `tecode.dark-modern`'s theme id — exported so `coreDefaults.ts` (the
 * `workbench.colorTheme` default) and every test that asserts against it
 * reference one shared constant rather than a duplicated string literal. */
export const DARK_MODERN_THEME_ID = "tecode.dark-modern";

export default {
  id: "tecode.themes-default",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [],
  contributes: {
    themes: [{ id: DARK_MODERN_THEME_ID, label: "Dark Modern", path: "themes/dark-modern.json" }],
  },
} satisfies Manifest;
