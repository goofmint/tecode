/**
 * `wireThemeConfigSync`/`applyConfiguredTheme` (Req 7.5, design.md §9, §11):
 * keeps the active theme in sync with the `workbench.colorTheme` setting —
 * "the active theme SHALL be selected by the `workbench.colorTheme`
 * setting." Deliberately wired here, at the composition root
 * (`packages/cli`'s `main.ts`), rather than inside a React render — same
 * rationale `editorLangId.ts`'s TSDoc gives for `wireEditorLangIdContext`:
 * setting the active theme from a config value is a side effect with no
 * rendering purpose of its own, and `ConfigService.onDidChange` already
 * exists as a plain event this module can subscribe to directly, with no
 * React tree required to observe it.
 *
 * **Two call sites, one helper, deliberately NOT auto-synced at wire time**
 * (unlike `wireEditorLangIdContext`, which DOES run its sync once
 * immediately): `ConfigService`'s own documented policy is that its
 * *initial* load fires no `onDidChange` at all (`config/service.ts`'s
 * `initialLoad` TSDoc: "no listener could have subscribed before this
 * promise was even returned to the caller, so no `onDidChange` fires for
 * startup") — so `wireThemeConfigSync`, if it read `config.get(...)`
 * immediately at construction time (typically inside `buildAssemblyRoot`,
 * before `config.ready` has settled), would only ever see the schema
 * default, not whatever `settings.json` actually says. The composition
 * root therefore calls {@link applyConfiguredTheme} explicitly, once, after
 * `await config.ready` (`main.ts`'s `runTecode`) — the sync-phase's initial
 * theme selection — and again after the deferred phase's
 * `ThemeRegistry.loadContributions` settles, so a `workbench.colorTheme`
 * naming an extension-contributed theme that only just finished loading
 * gets applied retroactively (`ThemeService.setTheme` is a safe no-op, with
 * a logged warning, for a still-unknown id — this is exactly why a second
 * call after contributions load is both necessary and harmless).
 * {@link wireThemeConfigSync} itself only has to handle changes AFTER that
 * point: a user hand-editing `settings.json`, or `theme.select`'s own
 * commit round-tripping through `ThemeSettingsWriter` back into
 * `ConfigService`'s file watcher.
 */

import type { Disposable } from "@tecode/api";
import type { ConfigService } from "../config/service";
import type { ThemeService } from "./themeService";

const DEFAULT_CONFIG_KEY = "workbench.colorTheme";

/** Read `configKey` (`"workbench.colorTheme"` by default) from `config`
 * and, if it currently names a string, apply it via
 * `themeService.setTheme` (a no-op — with a logged warning — if the id is
 * not yet known to the registry, this module's TSDoc). */
export function applyConfiguredTheme(
  config: Pick<ConfigService, "get">,
  themeService: Pick<ThemeService, "setTheme">,
  configKey: string = DEFAULT_CONFIG_KEY,
): void {
  const id = config.get<string>(configKey);
  if (typeof id === "string") themeService.setTheme(id);
}

/** Dependencies for {@link wireThemeConfigSync}. */
export interface WireThemeConfigSyncDeps {
  config: Pick<ConfigService, "get" | "onDidChange">;
  themeService: Pick<ThemeService, "setTheme">;
  /** Overrides the config key watched — defaults to
   * `"workbench.colorTheme"`. Test-only knob; production never sets this. */
  configKey?: string;
}

/**
 * Subscribe `themeService` to live `workbench.colorTheme` config changes
 * (Req 7.5) — see this module's TSDoc for why the INITIAL value is applied
 * by the composition root calling {@link applyConfiguredTheme} directly,
 * not by this function on construction. Returns a {@link Disposable} that
 * stops the subscription; idempotent.
 */
export function wireThemeConfigSync(deps: WireThemeConfigSyncDeps): Disposable {
  const key = deps.configKey ?? DEFAULT_CONFIG_KEY;

  const sub = deps.config.onDidChange((event) => {
    if (event.affectsConfiguration(key)) {
      applyConfiguredTheme(deps.config, deps.themeService, key);
    }
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      sub.dispose();
    },
  };
}
