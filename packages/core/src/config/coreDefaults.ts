/**
 * Core's own `contributes.configuration`-shaped defaults (Req 9.5, design.md
 * §11) — settings the core itself depends on (the `EditorView`'s gutter and
 * indentation width, design.md §8.3; the active theme, Req 7.5) rather than
 * a bundled extension's manifest. Extensions register their schemas through
 * `ConfigService.registerConfiguration` via `host/registration.ts`'s
 * `contributes.configuration` handling; core has no manifest of its own to
 * walk, so {@link registerCoreConfiguration} is the equivalent one-shot call
 * for the handful of keys core needs a default for before any extension has
 * had a chance to register them (`editor.lineNumbers`, `editor.tabSize`,
 * `workbench.colorTheme` — Req 9.5's MVP settings list).
 *
 * Called once from the composition root (`packages/cli/src/main.ts`'s
 * `buildAssemblyRoot`, the one place outside `core` allowed to wire services
 * together) right after `createConfigService`, mirroring how
 * `registerExtension` feeds a manifest's `contributes.configuration` into
 * the same `registerConfiguration` method (`host/registration.ts`) — core
 * defaults and extension defaults share one registration path, just two
 * different callers.
 */

import type { ConfigurationContribution, Disposable } from "@tecode/api";

/**
 * `themes-default`'s Dark Modern theme id (Task 2.7, Req 7.5, 11.4) — the
 * `workbench.colorTheme` default below. DUPLICATED here as a literal
 * string, rather than importing `packages/builtin/themes-default/
 * manifest.ts`'s own `DARK_MODERN_THEME_ID` export, because `core` cannot
 * depend on `builtin` (one-directional layering — the same constraint
 * `packages/cli/src/extensionRecords.ts`'s `ColorDepth` type duplication
 * follows for `core`/`cli`, that module's TSDoc). Keep this string in sync
 * with `themes-default/manifest.ts`'s `DARK_MODERN_THEME_ID` by hand;
 * `packages/cli/src/main.test.ts`/`themesDefaultStartup.test.ts` assert
 * against the real built-in manifest's id, not this literal, so a drift
 * between the two fails a test rather than silently resolving to the
 * base palette.
 */
export const DEFAULT_COLOR_THEME_ID = "tecode.dark-modern";

/**
 * `keybindings.preset`'s default value (Req 4.8, design.md §6.6, Issue
 * #81 Phase 2) — the `keymap/presetKeybindings.ts`'s
 * `DEFAULT_KEYBINDING_PRESET_NAME` value, DUPLICATED here as a literal
 * string for the SAME reason {@link DEFAULT_COLOR_THEME_ID} above
 * duplicates `themes-default`'s theme id rather than importing it: unlike
 * that case this isn't a `core`/`builtin` layering constraint (both
 * `config/` and `keymap/` live inside `core`), but `config/` has no
 * EXISTING import from `keymap/` anywhere in this codebase today — only
 * the reverse (`keymap/fallbackKeybindings.ts`'s `../config/jsonc`) — and
 * introducing a brand-new `config -> keymap` edge for one literal string
 * is not worth it. Kept in sync by hand;
 * `packages/cli/src/keybindingPresets.test.ts` asserts this literal
 * equals the real `DEFAULT_KEYBINDING_PRESET_NAME` export, so a drift
 * between the two fails a test rather than silently resolving to the
 * wrong default.
 */
export const DEFAULT_KEYBINDING_PRESET = "default";

/** The narrow slice of `ConfigService` {@link registerCoreConfiguration}
 * needs — the same shape as `host/registration.ts`'s `ConfigRegistrar`,
 * duplicated locally rather than imported so `config/` never depends on
 * `host/` (both depend only on `@tecode/api`'s types, per the module
 * layering this codebase otherwise keeps one-directional: `host` depends on
 * `config`'s `ConfigService` shape, not the other way around). */
export interface CoreConfigRegistrar {
  registerConfiguration(contribution: ConfigurationContribution): Disposable;
}

/** Core's own configuration schema (Req 7.5, 9.5, 11.1; design.md §8.3,
 * §9): `editor.lineNumbers` gates the `EditorView` gutter; `editor.tabSize`
 * sizes indentation for both the gutter-adjacent text layer and
 * editor-core's indent commands (Task 2.3); `editor.insertSpaces` picks
 * what those same commands' Tab key inserts — spaces up to the next
 * `editor.tabSize` stop when `true` (the default, matching most editors),
 * a literal `"\t"` otherwise; `workbench.colorTheme` (Task 2.6, 2.7)
 * selects the active theme by id (`ThemeRegistry`'s ids), defaulting to
 * `themes-default`'s Dark Modern theme ({@link DEFAULT_COLOR_THEME_ID}) —
 * loaded synchronously, pre-first-frame, from an embedded asset
 * (`packages/cli/src/main.ts`'s sync-phase theme wiring, design.md §3) —
 * rather than `ThemeRegistry`'s bare `BASE_THEME_ID` fallback palette, so
 * a fresh install with no `settings.json` entry still resolves to a real,
 * always-present, VS-Code-equivalent theme (Req 11.4) from the very first
 * frame; `keybindings.preset` (Req 4.8, design.md §6.6, Issue #81
 * Phase 2) selects a bundled keybinding scheme by name
 * (`keymap/presetKeybindings.ts`'s `KEYBINDING_PRESET_NAMES` —
 * `"default"`/`"emacs"`/`"windows"`), defaulting to
 * {@link DEFAULT_KEYBINDING_PRESET} (no preset — the `preset` layer
 * resolves to `[]`), applied and live-reloaded by `packages/cli/src/
 * main.ts`'s `buildAssemblyRoot` exactly like `workbench.colorTheme`
 * (`ui/themeConfigSync.ts`'s wiring pattern). An unrecognized value
 * degrades to no preset with a logged warning
 * (`resolveKeybindingPreset`'s own TSDoc) rather than throwing or
 * crashing startup. */
export const CORE_CONFIGURATION: ConfigurationContribution = {
  title: "Editor",
  properties: {
    "editor.lineNumbers": {
      type: "boolean",
      default: true,
      description: "Show line numbers in the editor gutter.",
    },
    "editor.tabSize": {
      type: "number",
      default: 4,
      description: "The number of spaces a tab is equal to.",
    },
    "editor.insertSpaces": {
      type: "boolean",
      default: true,
      description: "Insert spaces when pressing Tab.",
    },
    "workbench.colorTheme": {
      type: "string",
      default: DEFAULT_COLOR_THEME_ID,
      description: "The id of the active color theme.",
    },
    "keybindings.preset": {
      type: "string",
      default: DEFAULT_KEYBINDING_PRESET,
      description:
        'A bundled keybinding scheme to layer over the defaults: "default" (none), "emacs", or "windows".',
    },
  },
};

/**
 * Register core's own configuration schema/defaults (Req 9.5) against
 * `registrar` (typically a live `ConfigService`, narrowed to
 * {@link CoreConfigRegistrar}). Returns the `Disposable`
 * `registerConfiguration` itself returns — callers that never tear down the
 * composition root (the CLI's normal lifetime) can safely ignore it, but
 * tests building/discarding many roots should dispose it like any other
 * registration.
 */
export function registerCoreConfiguration(registrar: CoreConfigRegistrar): Disposable {
  return registrar.registerConfiguration(CORE_CONFIGURATION);
}
