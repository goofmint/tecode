/**
 * `applyConfiguredPanelHeight`/`wirePanelHeightConfigSync` (Issue #118; Req
 * 6.4, design.md §8.2): keeps `LayoutState.panelHeight` in sync with the
 * `workbench.panelHeight` setting — mirrors `sidebarWidthConfigSync.ts`'s
 * `applyConfiguredSidebarWidth`/`wireSidebarWidthConfigSync` pair for
 * `workbench.sidebarWidth` almost exactly, just with `panelHeight` standing
 * in for `sidebarWidth` and `clampPanelHeight` standing in for
 * `clampSidebarWidth`.
 *
 * **Same "two call sites, one helper, deliberately NOT auto-synced at wire
 * time" shape `sidebarWidthConfigSync.ts`'s TSDoc documents**:
 * `ConfigService`'s initial load fires no `onDidChange` at all
 * (`config/service.ts`'s `initialLoad` TSDoc), so reading `config.get(...)`
 * before `config.ready` settles would only ever see the schema default —
 * harmless in isolation (the schema default IS 10,
 * `coreDefaults.ts`'s own registration), but
 * {@link applyConfiguredPanelHeight} is still called explicitly by the
 * composition root AFTER `await config.ready`, exactly like
 * `applyConfiguredSidebarWidth`, rather than eagerly at
 * {@link wirePanelHeightConfigSync}'s own construction time — so the two
 * functions' contracts stay symmetric with their sidebar-width
 * counterparts, not just individually correct.
 *
 * **The setting is only ever a FLOOR-clamped value here** —
 * `panelHeight.ts`'s `clampPanelHeight` is applied with no `terminalHeight`
 * argument (this module has no live terminal to cap against, exactly like
 * `layoutState.ts`'s `coerceLayoutState`); `shell.tsx`'s `Shell` is the one
 * call site that additionally caps against a live terminal height, on every
 * render, regardless of what this module or `coerceLayoutState` already did
 * (`panelHeight.ts`'s TSDoc's "Two independent floors/ceilings").
 *
 * **This is a config -> state sync only, not a round trip loop** (Issue
 * #118's scope): applying `workbench.panelHeight` calls
 * `layoutState.update`, which persists to `state.json`, NOT back to
 * `settings.json`. Unlike `sidebarWidth`'s pair, there is (yet) no resize
 * COMMIT to write back in the first place — Issue #118 does not add a
 * `workbench.action.increase/decreasePanelHeight` command or a mouse-drag
 * commit, so no `panelHeightSettingsWriter.ts` exists, and none should be
 * added here. A user who hand-edits `workbench.panelHeight` in
 * `settings.json` sees it take effect immediately (this module's live
 * `onDidChange` subscription) exactly as `workbench.sidebarWidth` does.
 *
 * **Only an EXPLICIT setting is ever applied**, for the identical Finding-3
 * reason `sidebarWidthConfigSync.ts`'s TSDoc explains in full:
 * `ConfigService.get`'s merged view cannot tell "the user configured 10"
 * apart from "the user configured nothing" when the schema default also
 * happens to be 10, and {@link applyConfiguredPanelHeight} runs on EVERY
 * startup as well as on every subsequent config change — applying whatever
 * `get` returns unconditionally would silently overwrite `state.json`'s own
 * persisted height with the schema default on every launch where
 * `settings.json` happens not to mention the key. Both
 * {@link applyConfiguredPanelHeight} and {@link wirePanelHeightConfigSync}'s
 * `onDidChange` handler therefore gate on `ConfigService.isExplicitlySet`
 * first.
 *
 * **Deliberate choice for the "key REMOVED from settings.json" case**: the
 * same as `sidebarWidthConfigSync.ts:59-69` — `onDidChange` still fires
 * (`isExplicitlySet` newly reads `false`), and this module's answer is to
 * leave `state.json`'s current height exactly alone, NOT reset it to the
 * schema default. Removing a line from `settings.json` reads as "stop
 * pinning the height", not "reset the height to 10 right now" — the height
 * remains whatever `state.json` already has, exactly as if the user had
 * never touched `settings.json` at all.
 */

import type { Disposable } from "@tecode/api";
import type { ConfigService } from "../config/service";
import type { LayoutStateService } from "./layoutState";
import { clampPanelHeight } from "./panelHeight";

const PANEL_HEIGHT_CONFIG_KEY = "workbench.panelHeight";

/** Read `configKey` (`"workbench.panelHeight"` by default) from `config`
 * and, if the USER or WORKSPACE layer EXPLICITLY sets it
 * (`ConfigService.isExplicitlySet` — this module's TSDoc explains why `get`
 * alone cannot be trusted for this) to a number, apply it (floor-clamped
 * via `clampPanelHeight`, this module's TSDoc) via
 * `layoutState.update({ panelHeight })`. Left alone entirely otherwise —
 * both when the key is absent (a bare schema default, this module's
 * TSDoc's "never overwrite `state.json` with the schema default") and when
 * it is present but non-numeric — `LayoutStateService` already has its own
 * default/persisted value, so there is nothing useful to overwrite it
 * with. */
export function applyConfiguredPanelHeight(
  config: Pick<ConfigService, "get" | "isExplicitlySet">,
  layoutState: Pick<LayoutStateService, "update">,
  configKey: string = PANEL_HEIGHT_CONFIG_KEY,
): void {
  if (!config.isExplicitlySet(configKey)) return;
  const height = config.get<number>(configKey);
  if (typeof height === "number") {
    layoutState.update({ panelHeight: clampPanelHeight(height) });
  }
}

/** Dependencies for {@link wirePanelHeightConfigSync}. */
export interface WirePanelHeightConfigSyncDeps {
  config: Pick<ConfigService, "get" | "isExplicitlySet" | "onDidChange">;
  layoutState: Pick<LayoutStateService, "update">;
  /** Overrides the config key watched — defaults to
   * `"workbench.panelHeight"`. Test-only knob; production never sets
   * this. */
  configKey?: string;
}

/**
 * Subscribe `layoutState` to live `workbench.panelHeight` config changes
 * (Issue #118) — see this module's TSDoc for why the INITIAL value is
 * applied by the composition root calling
 * {@link applyConfiguredPanelHeight} directly, not by this function on
 * construction. Returns a {@link Disposable} that stops the subscription;
 * idempotent.
 */
export function wirePanelHeightConfigSync(deps: WirePanelHeightConfigSyncDeps): Disposable {
  const key = deps.configKey ?? PANEL_HEIGHT_CONFIG_KEY;

  const sub = deps.config.onDidChange((event) => {
    if (event.affectsConfiguration(key)) {
      applyConfiguredPanelHeight(deps.config, deps.layoutState, key);
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
