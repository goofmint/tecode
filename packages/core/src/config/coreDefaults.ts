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
 * `workbench.sidebarWidth`'s default value (Issue #105) — DUPLICATED here
 * as a literal number for the SAME reason {@link DEFAULT_COLOR_THEME_ID}
 * above duplicates `themes-default`'s theme id: `layoutState.ts`'s
 * `DEFAULT_LAYOUT_STATE.sidebarWidth` is the real source of truth (`ui/` has
 * no existing import edge into `config/`, and introducing one for a single
 * literal number is not worth it, matching {@link DEFAULT_COLOR_THEME_ID}'s
 * identical "no new cross-module edge for one literal" reasoning one
 * paragraph up). Kept in sync by hand;
 * `sidebarWidthCommands.test.ts`/`coreDefaults.test.ts` assert this literal
 * equals `layoutState.ts`'s real `DEFAULT_LAYOUT_STATE.sidebarWidth`, so a
 * drift between the two fails a test rather than silently resolving to the
 * wrong default.
 */
export const DEFAULT_SIDEBAR_WIDTH = 30;

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
 * frame. **`keybindings.preset` (Req 4.8, design.md §6.6, Issue #81 Phase
 * 2) is deliberately NOT registered here any more (Issue #115)** — the
 * bundled Emacs/Windows keybinding schemes it selected were removed in
 * favor of copyable sample `keybindings.json` files
 * (`samples/keybindings.emacs.json`/`samples/keybindings.windows.json`),
 * since the highest-precedence `user` binding layer already expresses
 * everything a preset did. No migration path is provided for a
 * `settings.json` that still sets this key — there are no existing users
 * to migrate, so it is simply left inert, exactly like any other
 * unrecognized key `ConfigService` was never asked to interpret.
 * `workbench.sidebarWidth` (Issue #105, Req 6.4)
 * duplicates `layoutState.ts`'s own `sidebarWidth` persistence as a
 * user-editable setting — a hand-edited number here is floor-clamped
 * (`sidebarWidth.ts`'s `clampSidebarWidth`) and applied to
 * `LayoutStateService` by `ui/sidebarWidthConfigSync.ts`'s
 * `applyConfiguredSidebarWidth`/`wireSidebarWidthConfigSync`, wired at
 * `main.ts`'s composition root exactly like `workbench.colorTheme`; a
 * resize commit (a border drag's end, or the
 * `workbench.action.increase/decreaseSidebarWidth` commands,
 * `ui/sidebarWidthCommands.ts`) writes the result back here via
 * `ui/sidebarWidthSettingsWriter.ts`, so the two stay in sync in both
 * directions. */
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
    "workbench.sidebarWidth": {
      type: "number",
      default: DEFAULT_SIDEBAR_WIDTH,
      description:
        "The sidebar's width in columns. Also adjustable by dragging the sidebar's right border, or the workbench.action.increase/decreaseSidebarWidth commands (Issue #105).",
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
