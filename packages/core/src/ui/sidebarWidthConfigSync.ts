/**
 * `applyConfiguredSidebarWidth`/`wireSidebarWidthConfigSync` (Issue #105;
 * Req 6.4, 9.5; design.md §8.2, §11): keeps `LayoutState.sidebarWidth` in
 * sync with the `workbench.sidebarWidth` setting — mirrors
 * `themeConfigSync.ts`'s `applyConfiguredTheme`/`wireThemeConfigSync` pair
 * for `workbench.colorTheme` almost exactly, just with
 * `LayoutStateService.update({ sidebarWidth })` standing in for
 * `ThemeService.setTheme`.
 *
 * **Same "two call sites, one helper, deliberately NOT auto-synced at wire
 * time" shape `themeConfigSync.ts`'s TSDoc documents**: `ConfigService`'s
 * initial load fires no `onDidChange` at all (`config/service.ts`'s
 * `initialLoad` TSDoc), so reading `config.get(...)` before `config.ready`
 * settles would only ever see the schema default — harmless in isolation
 * (the schema default IS 30, `coreDefaults.ts`'s own registration), but
 * `applyConfiguredSidebarWidth` is still called explicitly by the
 * composition root AFTER `await config.ready`, exactly like
 * `applyConfiguredTheme`, rather than eagerly at
 * {@link wireSidebarWidthConfigSync}'s own construction time — so the two
 * functions' contracts stay symmetric with their theme counterparts, not
 * just individually correct.
 *
 * **The setting is only ever a FLOOR-clamped value here** — `sidebarWidth.
 * ts`'s `clampSidebarWidth` is applied with no `terminalWidth` argument
 * (this module has no live terminal to cap against, exactly like
 * `layoutState.ts`'s `coerceLayoutState`); `shell.tsx`'s `Shell` is the one
 * call site that additionally caps against a live terminal width, on every
 * render, regardless of what this module or `coerceLayoutState` already
 * did (`sidebarWidth.ts`'s TSDoc's "Two independent floors/ceilings").
 *
 * **This is a config -> state sync only, not a round trip loop**: applying
 * `workbench.sidebarWidth` calls `layoutState.update`, which persists to
 * `state.json`, NOT back to `settings.json` — writing the setting itself
 * only ever happens from a genuine resize COMMIT
 * (`sidebarWidthCommands.ts`'s two commands, `shell.tsx`'s `Shell`'s
 * `onSidebarWidthCommit` on drag-end), via
 * `sidebarWidthSettingsWriter.ts`. A user who hand-edits
 * `workbench.sidebarWidth` in `settings.json` sees it take effect
 * immediately (this module's live `onDidChange` subscription) without this
 * module ever writing back to the file it just read from.
 */

import type { Disposable } from "@tecode/api";
import type { ConfigService } from "../config/service";
import type { LayoutStateService } from "./layoutState";
import { clampSidebarWidth } from "./sidebarWidth";

const SIDEBAR_WIDTH_CONFIG_KEY = "workbench.sidebarWidth";

/** Read `configKey` (`"workbench.sidebarWidth"` by default) from `config`
 * and, if it currently names a number, apply it (floor-clamped via
 * `clampSidebarWidth`, this module's TSDoc) via
 * `layoutState.update({ sidebarWidth })`. A non-numeric or missing value is
 * left alone entirely — `LayoutStateService` already has its own default/
 * persisted value, so there is nothing useful to overwrite it with. */
export function applyConfiguredSidebarWidth(
  config: Pick<ConfigService, "get">,
  layoutState: Pick<LayoutStateService, "update">,
  configKey: string = SIDEBAR_WIDTH_CONFIG_KEY,
): void {
  const width = config.get<number>(configKey);
  if (typeof width === "number") {
    layoutState.update({ sidebarWidth: clampSidebarWidth(width) });
  }
}

/** Dependencies for {@link wireSidebarWidthConfigSync}. */
export interface WireSidebarWidthConfigSyncDeps {
  config: Pick<ConfigService, "get" | "onDidChange">;
  layoutState: Pick<LayoutStateService, "update">;
  /** Overrides the config key watched — defaults to
   * `"workbench.sidebarWidth"`. Test-only knob; production never sets
   * this. */
  configKey?: string;
}

/**
 * Subscribe `layoutState` to live `workbench.sidebarWidth` config changes
 * (Issue #105) — see this module's TSDoc for why the INITIAL value is
 * applied by the composition root calling
 * {@link applyConfiguredSidebarWidth} directly, not by this function on
 * construction. Returns a {@link Disposable} that stops the subscription;
 * idempotent.
 */
export function wireSidebarWidthConfigSync(deps: WireSidebarWidthConfigSyncDeps): Disposable {
  const key = deps.configKey ?? SIDEBAR_WIDTH_CONFIG_KEY;

  const sub = deps.config.onDidChange((event) => {
    if (event.affectsConfiguration(key)) {
      applyConfiguredSidebarWidth(deps.config, deps.layoutState, key);
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
