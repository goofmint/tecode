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
 *
 * **Only an EXPLICIT setting is ever applied (Issue #105 Finding 3)**:
 * `ConfigService.get` reads the merged `defaults <- user <- workspace`
 * view, so an absent key returns the very same value a schema default
 * would (`coreDefaults.ts` registers `workbench.sidebarWidth`'s default as
 * `30`) — `get` alone cannot tell "the user configured 30" apart from "the
 * user configured nothing." Since `applyConfiguredSidebarWidth` runs on
 * EVERY startup (after `config.ready`, from the composition root) as well
 * as on every subsequent config change, applying whatever `get` returns
 * unconditionally would silently overwrite `state.json`'s own persisted
 * width with the schema default on every single launch where
 * `settings.json` happens not to mention the key — defeating the entire
 * point of `state.json` round-tripping a drag/commit across restarts. Both
 * {@link applyConfiguredSidebarWidth} and {@link wireSidebarWidthConfigSync}'s
 * `onDidChange` handler therefore gate on `ConfigService.isExplicitlySet`
 * first: apply the merged value only when the USER or WORKSPACE layer
 * genuinely names the key.
 *
 * **Deliberate choice for the "key REMOVED from settings.json" case**:
 * `onDidChange` still fires (the merged value's numeric identity may not
 * even have changed, but `isExplicitlySet` newly reads `false`), and this
 * module's answer is to leave `state.json`'s current width exactly alone,
 * NOT reset it to the schema default — the same "never overwrite with a
 * schema default" reasoning as the startup case above, just re-triggered
 * by a live edit instead of a fresh launch. Removing a line from
 * `settings.json` reads as "stop pinning the width", not "reset the width
 * to 30 right now" — the width remains whatever `state.json`/the live UI
 * already has, exactly as if the user had dragged the border to that width
 * without ever touching `settings.json` at all.
 */

import type { Disposable } from "@tecode/api";
import type { ConfigService } from "../config/service";
import type { LayoutStateService } from "./layoutState";
import { clampSidebarWidth } from "./sidebarWidth";

const SIDEBAR_WIDTH_CONFIG_KEY = "workbench.sidebarWidth";

/** Read `configKey` (`"workbench.sidebarWidth"` by default) from `config`
 * and, if the USER or WORKSPACE layer EXPLICITLY sets it
 * (`ConfigService.isExplicitlySet` — this module's TSDoc explains why `get`
 * alone cannot be trusted for this) to a number, apply it (floor-clamped
 * via `clampSidebarWidth`, this module's TSDoc) via
 * `layoutState.update({ sidebarWidth })`. Left alone entirely otherwise —
 * both when the key is absent (a bare schema default, this module's
 * TSDoc's "never overwrite `state.json` with the schema default") and when
 * it is present but non-numeric — `LayoutStateService` already has its own
 * default/persisted value, so there is nothing useful to overwrite it
 * with. */
export function applyConfiguredSidebarWidth(
  config: Pick<ConfigService, "get" | "isExplicitlySet">,
  layoutState: Pick<LayoutStateService, "update">,
  configKey: string = SIDEBAR_WIDTH_CONFIG_KEY,
): void {
  if (!config.isExplicitlySet(configKey)) return;
  const width = config.get<number>(configKey);
  if (typeof width === "number") {
    layoutState.update({ sidebarWidth: clampSidebarWidth(width) });
  }
}

/** Dependencies for {@link wireSidebarWidthConfigSync}. */
export interface WireSidebarWidthConfigSyncDeps {
  config: Pick<ConfigService, "get" | "isExplicitlySet" | "onDidChange">;
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
