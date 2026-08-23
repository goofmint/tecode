/**
 * Core's own `contributes.configuration`-shaped defaults (Req 9.5, design.md
 * §11) — settings the core itself depends on (the `EditorView`'s gutter and
 * indentation width, design.md §8.3) rather than a bundled extension's
 * manifest. Extensions register their schemas through
 * `ConfigService.registerConfiguration` via `host/registration.ts`'s
 * `contributes.configuration` handling; core has no manifest of its own to
 * walk, so {@link registerCoreConfiguration} is the equivalent one-shot call
 * for the handful of keys core needs a default for before any extension has
 * had a chance to register them (`editor.lineNumbers`, `editor.tabSize`
 * — Req 9.5's MVP settings list).
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

/** The narrow slice of `ConfigService` {@link registerCoreConfiguration}
 * needs — the same shape as `host/registration.ts`'s `ConfigRegistrar`,
 * duplicated locally rather than imported so `config/` never depends on
 * `host/` (both depend only on `@tecode/api`'s types, per the module
 * layering this codebase otherwise keeps one-directional: `host` depends on
 * `config`'s `ConfigService` shape, not the other way around). */
export interface CoreConfigRegistrar {
  registerConfiguration(contribution: ConfigurationContribution): Disposable;
}

/** Core's own configuration schema (Req 9.5, design.md §8.3): `editor.
 * lineNumbers` gates the `EditorView` gutter; `editor.tabSize` sizes
 * indentation for both the gutter-adjacent text layer and (in a later task)
 * editor-core's indent commands. */
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
