/**
 * `applyConfiguredKeybindingPreset`/`wireKeybindingPresetConfigSync` (Req
 * 4.8, design.md §6.6, Issue #81 Phase 2): keeps `KeymapState`'s
 * `preset` layer in sync with the `keybindings.preset` setting — mirrors
 * `@tecode/core`'s `ui/themeConfigSync.ts`'s `applyConfiguredTheme`/
 * `wireThemeConfigSync` pair for `workbench.colorTheme` almost exactly,
 * just with `KeymapState.setPresetEntries` standing in for
 * `ThemeService.setTheme`, and living HERE, in `packages/cli`, rather than
 * in `@tecode/core` — `KeymapState` (`keymapState.ts`) is a `cli`-local
 * type with no `@tecode/core` equivalent (`core` has `BindingTable`/
 * `KeymapLayers`, but nothing that owns the mutable `defaults`/`fallback`/
 * `extension`/`preset`/`user` state the way `KeymapState` does), so a
 * reusable helper over it cannot live in `core` alongside
 * `themeConfigSync.ts` the way `wireThemeConfigSync` does for
 * `ThemeService`.
 *
 * **Same "two call sites, one helper, deliberately NOT auto-synced at wire
 * time" shape `ui/themeConfigSync.ts`'s TSDoc documents for
 * `workbench.colorTheme`**: `ConfigService`'s initial load fires no
 * `onDidChange` at all (`config/service.ts`'s `initialLoad` TSDoc), so
 * reading `config.get(...)` before `config.ready` settles would only ever
 * see the schema default (`"default"`) — harmless here specifically,
 * since that default resolves to `[]` anyway, but {@link
 * applyConfiguredKeybindingPreset} is still called explicitly by
 * `main.ts`'s `runTecode` AFTER `await root.config.ready`, exactly like
 * `applyConfiguredTheme`, rather than eagerly at
 * {@link wireKeybindingPresetConfigSync}'s own construction time — so the
 * two functions' contracts stay symmetric with their theme counterparts,
 * not just individually correct. Unlike `workbench.colorTheme`, a preset
 * name never depends on anything `loadExtensions`/discovery resolves
 * later (`keymap/presetKeybindings.ts`'s fixed, closed
 * `KEYBINDING_PRESET_NAMES` set), so there is no `runDeferredPhase`
 * equivalent of `applyConfiguredTheme`'s second, retroactive call.
 */

import type { HostLog } from "@tecode/core";
import { resolveKeybindingPreset } from "@tecode/core";
import type { Disposable, KeybindingContribution } from "@tecode/api";
import type { ConfigService } from "@tecode/core";
import type { KeymapState } from "./keymapState";

const KEYBINDINGS_PRESET_CONFIG_KEY = "keybindings.preset";

/** Render a caught `unknown` value as a message string, matching
 * `main.ts`'s own module-level `describeError` (design.md §5). Duplicated
 * locally (house style: small, non-shared per-module helpers — this
 * codebase's own `fallbackKeybindings.ts`/`bindingTable.ts` each keep
 * their own copy too) rather than importing `main.ts`'s, which would
 * create a reverse (`main.ts` already imports this module) circular
 * import. */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Dependencies shared by {@link applyConfiguredKeybindingPreset} and
 * {@link wireKeybindingPresetConfigSync}. */
export interface KeybindingPresetConfigSyncDeps {
  config: Pick<ConfigService, "get" | "onDidChange">;
  keymap: Pick<KeymapState, "setPresetEntries">;
  log: HostLog;
  /** Overrides the config key watched — defaults to
   * `"keybindings.preset"`. Test-only knob; production never sets this. */
  configKey?: string;
}

/**
 * Read `keybindings.preset` from `deps.config` and feed the resolved
 * entries into `deps.keymap.setPresetEntries` (Req 4.8). A
 * non-string (or missing/not-yet-ready) config value falls back to
 * `"default"` — the schema default, resolving to `[]`. Never throws:
 * `config.get`/`resolveKeybindingPreset` are both guarded defensively
 * (house style, matching `main.ts`'s `applyKittyKeyboardVerdict`), each
 * degrading to the empty preset layer on any unexpected failure rather
 * than propagating.
 */
export function applyConfiguredKeybindingPreset(deps: KeybindingPresetConfigSyncDeps): void {
  const key = deps.configKey ?? KEYBINDINGS_PRESET_CONFIG_KEY;

  let presetName = "default";
  try {
    const raw = deps.config.get<string>(key);
    if (typeof raw === "string") presetName = raw;
  } catch (cause) {
    deps.log.append("error", {
      message: `applyConfiguredKeybindingPreset: config.get threw: ${describeError(cause)}`,
    });
  }

  let entries: KeybindingContribution[];
  try {
    entries = resolveKeybindingPreset(presetName, { log: deps.log });
  } catch (cause) {
    deps.log.append("error", {
      message: `applyConfiguredKeybindingPreset: resolveKeybindingPreset threw: ${describeError(cause)}`,
    });
    entries = [];
  }

  deps.keymap.setPresetEntries(entries);
}

/**
 * Subscribe `deps.keymap` to live `keybindings.preset` config changes (Req
 * 4.8) — see this module's TSDoc for why the INITIAL value is applied by
 * the composition root calling {@link applyConfiguredKeybindingPreset}
 * directly, not by this function on construction. Returns a
 * {@link Disposable} that stops the subscription; idempotent.
 */
export function wireKeybindingPresetConfigSync(
  deps: KeybindingPresetConfigSyncDeps,
): Disposable {
  const key = deps.configKey ?? KEYBINDINGS_PRESET_CONFIG_KEY;

  const sub = deps.config.onDidChange((event) => {
    if (event.affectsConfiguration(key)) {
      applyConfiguredKeybindingPreset(deps);
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
