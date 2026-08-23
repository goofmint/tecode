/**
 * `ThemeRegistry` (Req 7.1, 7.4; design.md §9): collects every known theme
 * — the built-in base palette (always present, registered synchronously at
 * construction so the sync phase always has *something* to paint before any
 * extension has activated, design.md §3), `contributes.themes` entries
 * discovered during the deferred phase ({@link ThemeRegistry.loadContributions}),
 * and runtime `tecode.themes.register` calls ({@link ThemeRegistry.register})
 * — resolves each to a {@link ResolvedTheme} via `themeLoader.ts`, and
 * quantizes it once at build time for a less-than-truecolor terminal
 * (`colorQuantize.ts`) so no render path ever branches on color depth (Req
 * 7.4).
 *
 * Built with {@link createThemeRegistry} rather than a class, per house
 * convention (matches `createSlotRegistry`, `createConfigService`).
 *
 * **Async loading behind a synchronous `register`** (mirrors
 * `slotRegistry.ts`'s lazy-view pattern): {@link ThemeRegistry.register} —
 * the same shape both a manifest's `contributes.themes` entry and a runtime
 * `tecode.themes.register(contribution)` call normalize to (`@tecode/api`'s
 * `ThemeContribution` TSDoc) — must return a `Disposable` synchronously
 * (the frozen `ThemesNamespace.register` signature), but reading and
 * parsing the theme's JSON file is unavoidably async. `register` therefore
 * kicks the load off in the background and returns a `Disposable`
 * immediately; the theme appears in {@link ThemeRegistry.list}/
 * {@link ThemeRegistry.get} once the load settles, firing
 * {@link ThemeRegistry.onDidChange} so a live consumer (the `theme.select`
 * command, `ThemeService`'s config-driven live-switch) notices. Disposing
 * before the load settles cancels the store (a guard flag), matching
 * `slotRegistry.ts`'s "a no-op if a later registration has already
 * superseded it" discipline in spirit.
 *
 * **Path resolution** (this task's plan, following `extensionRecords.ts`'s
 * `dirname(sourcePath)` shape): a manifest-declared theme's `path` is
 * resolved relative to its OWNING EXTENSION's directory — the
 * `extensionId -> directory` map {@link ThemeRegistry.loadContributions}
 * takes, built by the composition root the same way
 * `extensionRecords.ts`'s `buildExtensionRecord` derives `extensionDir`.
 * A runtime `tecode.themes.register` call carries no manifest/extension
 * attribution in this MVP (`create.ts`'s `themesNamespace.register` has no
 * extension-id parameter to plumb through) — its `path` is used as-is
 * (resolved against the process's cwd by the underlying `fs.readFile`),
 * which in practice means a runtime registration must pass an absolute
 * path. Documented trade-off, not a design.md requirement either way.
 */

import { join } from "node:path";
import { readFile as nodeReadFile } from "node:fs/promises";
import type { Disposable, Event, Listener, ResolvedTheme, ThemeContribution } from "@tecode/api";
import type { PendingThemeContribution } from "../host/registration";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { createBaseTheme } from "../api/stubs";
import { quantizeTheme } from "./colorQuantize";
import { loadThemeFallbackForReadError, loadThemeFromJsonText } from "./themeLoader";

/** The terminal color depths {@link ThemeRegistry} quantizes for (Req 7.4)
 * — the same union `packages/cli`'s `detectTerminalCapabilities` reports,
 * duplicated here (rather than imported) because `core` cannot depend on
 * `cli` (the ESLint layering rule runs the other direction). */
export type ColorDepth = "truecolor" | "256" | "16";

/** The id/label {@link createBaseTheme}'s always-present palette registers
 * under (this module's TSDoc: "always present... before any extension has
 * activated"). Exported so `themeService.ts`/composition-root code can
 * reference the built-in default without a magic string. */
export const BASE_THEME_ID = "tecode-base";
export const BASE_THEME_LABEL = "Base (Built-in)";

/** One resolved theme entry as {@link ThemeRegistry.get} returns it. */
export interface ThemeRegistryEntry {
  id: string;
  label: string;
  theme: ResolvedTheme;
}

/** One theme's id/label, as {@link ThemeRegistry.list} enumerates them —
 * exactly what a `theme.select` quick-pick needs, without handing out the
 * (potentially large) resolved color/token maps for every theme just to
 * list them. */
export interface ThemeListEntry {
  id: string;
  label: string;
}

/** The narrow filesystem seam {@link createThemeRegistry} needs: reading a
 * theme JSON file's text. Injectable (matches `config/service.ts`'s
 * `ConfigServiceFs`, `layoutState.ts`'s `LayoutStateFs`) so tests can
 * simulate theme files without touching the real filesystem. */
export interface ThemeRegistryFs {
  readFile(path: string): Promise<string>;
}

function createNodeThemeRegistryFs(): ThemeRegistryFs {
  return { readFile: (path) => nodeReadFile(path, "utf8") };
}

/** Dependencies for {@link createThemeRegistry}. */
export interface ThemeRegistryDeps {
  /** The terminal's detected color depth (Req 7.4) — `"truecolor"` (the
   * default) never quantizes; `"256"`/`"16"` quantize every theme
   * (including the built-in base palette) once, at registration time, via
   * `colorQuantize.ts`. */
  colorDepth?: ColorDepth;
  /** Filesystem seam — see {@link ThemeRegistryFs}. Defaults to
   * `node:fs/promises`. */
  fs?: ThemeRegistryFs;
  log?: HostLog;
  sink?: StatusSink;
}

/** The theme registry's public surface (Req 7.1, 7.4). */
export interface ThemeRegistry {
  /**
   * Register one theme (a manifest's `contributes.themes` entry, or a
   * runtime `tecode.themes.register` call — both normalize to
   * {@link ThemeContribution}, `@tecode/api`'s own TSDoc). `baseDir`, when
   * given, resolves `contribution.path` relative to it (a manifest theme's
   * owning extension directory); omitted, `contribution.path` is used
   * as-is (this module's TSDoc on runtime registrations).
   *
   * Returns a {@link Disposable} synchronously even though loading is
   * async (this module's TSDoc) — the theme appears in
   * {@link list}/{@link get} once the background load settles.
   */
  register(contribution: ThemeContribution, baseDir?: string): Disposable;
  /**
   * Load every manifest-declared theme discovered during the deferred
   * phase (`host/registration.ts`'s `LoadExtensionsResult.pendingThemes`)
   * against an `extensionId -> directory` map (this module's TSDoc).
   * Resolves once every theme in `pending` has settled (successfully or
   * not — a failed load still resolves, having fallen back to the base
   * palette and reported through `log`/`sink`), so a caller that wants to
   * live-switch to a just-arrived theme (`ThemeService`'s deferred-phase
   * wiring) knows exactly when it's safe to look it up.
   */
  loadContributions(
    pending: readonly PendingThemeContribution[],
    extensionDirs: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** One theme by id, or `undefined` if unknown (not yet loaded, load
   * failed to settle yet, or never registered). */
  get(id: string): ThemeRegistryEntry | undefined;
  /** Every currently-resolved theme's id/label, in registration order
   * (the built-in base theme first — this module's TSDoc). */
  list(): readonly ThemeListEntry[];
  /** Fires whenever a theme is registered, finishes loading, or is
   * disposed. Carries no payload — same "just re-render/re-check, don't
   * diff what changed" shape as `slotRegistry.ts`'s `onDidChange`. */
  onDidChange: Event<void>;
  /** Clear every listener. The registered theme entries themselves are
   * left in place (there is no meaningful "unload" for the built-in base
   * theme, and in-flight loads have nowhere to report cancellation to) —
   * this only stops `onDidChange` from doing anything further, matching
   * the narrow "stop reacting" contract `dispose()` has elsewhere in this
   * codebase for registries with no owned resources beyond listeners. */
  dispose(): void;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` (matches every other module's `logSafely`). */
function logSafely(log: HostLog | undefined, level: "error" | "warning", err: HostError): void {
  if (!log) return;
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Build a theme registry (Req 7.1, 7.4). Registers the built-in base
 * palette under {@link BASE_THEME_ID} synchronously before returning —
 * `list()`/`get(BASE_THEME_ID)` are correct immediately, with no `await`
 * needed (design.md §3's sync-phase requirement). */
export function createThemeRegistry(deps: ThemeRegistryDeps = {}): ThemeRegistry {
  const { log, sink, colorDepth } = deps;
  const fs = deps.fs ?? createNodeThemeRegistryFs();
  const shouldQuantize = colorDepth === "256" || colorDepth === "16";

  const entries = new Map<string, ThemeRegistryEntry>();
  const listeners = new Set<Listener<void>>();
  let disposed = false;
  // Per-id load generation (Req 7.1/7.4's "later registrations win"):
  // registering the same `id` twice starts two independent async loads: an
  // older one that settles after a newer one must NOT clobber the newer
  // registration's theme. Each `startLoad` for a given id bumps this
  // counter and captures its own generation number; `storeEntry` only
  // commits when its generation is still the latest one recorded for that
  // id — a stale load's result is discarded, matching `slotRegistry.ts`'s
  // "a no-op if a later registration has already superseded it" discipline
  // this module's TSDoc already cites for `register`.
  const loadGenerations = new Map<string, number>();

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches
    // every other `onDidChange` in this codebase.
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch (cause) {
        logSafely(log, "error", {
          message: `ThemeRegistry onDidChange listener threw: ${describeError(cause)}`,
        });
      }
    }
  }

  function finalizeTheme(theme: ResolvedTheme): ResolvedTheme {
    return shouldQuantize ? quantizeTheme(theme) : theme;
  }

  function storeEntry(entry: ThemeRegistryEntry): void {
    entries.set(entry.id, entry);
    // A no-op once dispose() has cleared every listener (below) — kept
    // unconditional rather than early-returning on `disposed` so an
    // in-flight load that settles after dispose() still leaves a correct,
    // queryable entry behind for get()/list() (this module's TSDoc:
    // dispose() only stops onDidChange from firing further, it does not
    // erase already-registered themes).
    fireChange();
  }

  // Seed the always-present built-in base theme synchronously (this
  // function's TSDoc) — quantized up front too, if the terminal needs it,
  // so the very first frame never renders an unquantized theme on a
  // 256-color terminal.
  entries.set(BASE_THEME_ID, {
    id: BASE_THEME_ID,
    label: BASE_THEME_LABEL,
    theme: finalizeTheme(createBaseTheme()),
  });

  /** Kick off a background load for one theme id/label/resolved-path;
   * returns a `Disposable` that cancels the eventual store (this module's
   * TSDoc), plus the `Promise` that settles once the load has either
   * stored the theme or given up and fallen back — {@link loadContributions}
   * awaits a batch of these; {@link register}'s caller only gets the
   * `Disposable`. */
  function startLoad(
    id: string,
    label: string,
    path: string,
  ): { disposable: Disposable; done: Promise<void> } {
    let loadDisposed = false;
    // Claim this id's next generation now, synchronously, so two
    // same-tick `register()` calls for the same id are ordered correctly
    // regardless of which one's `fs.readFile` settles first (see
    // `loadGenerations`'s TSDoc above).
    const generation = (loadGenerations.get(id) ?? 0) + 1;
    loadGenerations.set(id, generation);
    const done = (async () => {
      let theme: ResolvedTheme;
      try {
        const text = await fs.readFile(path);
        theme = loadThemeFromJsonText(text, { path, log, sink });
      } catch (cause) {
        theme = loadThemeFallbackForReadError(cause, { path, log, sink });
      }
      if (loadDisposed) return;
      if (loadGenerations.get(id) !== generation) return; // Superseded by a later registration.
      storeEntry({ id, label, theme: finalizeTheme(theme) });
    })();

    return {
      done,
      disposable: {
        dispose() {
          loadDisposed = true;
        },
      },
    };
  }

  function register(contribution: ThemeContribution, baseDir?: string): Disposable {
    const path = baseDir ? join(baseDir, contribution.path) : contribution.path;
    return startLoad(contribution.id, contribution.label, path).disposable;
  }

  async function loadContributions(
    pending: readonly PendingThemeContribution[],
    extensionDirs: Readonly<Record<string, string>>,
  ): Promise<void> {
    const loads = pending.map((entry) => {
      const dir = extensionDirs[entry.extensionId];
      const path = dir ? join(dir, entry.theme.path) : entry.theme.path;
      return startLoad(entry.theme.id, entry.theme.label, path);
    });
    await Promise.all(loads.map((l) => l.done));
  }

  function get(id: string): ThemeRegistryEntry | undefined {
    return entries.get(id);
  }

  function list(): readonly ThemeListEntry[] {
    return Array.from(entries.values(), ({ id, label }) => ({ id, label }));
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        listeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
  }

  return {
    register,
    loadContributions,
    get,
    list,
    onDidChange,
    dispose,
  };
}
