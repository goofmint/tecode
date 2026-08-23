/**
 * `ThemeService` (Req 7.3, 7.5; design.md §9): owns the ONE active
 * {@link ResolvedTheme} the whole shell renders (`useTheme()`'s live
 * backing, `ui/theme.tsx`'s {@link useLiveTheme}) and the preview/commit/
 * revert workflow `theme.select` drives (design.md §9: "changing
 * `workbench.colorTheme` (or previewing via `theme.select`, which calls a
 * `previewTheme(name)`/`commitTheme()`/`revertTheme()` triple on the theme
 * service) swaps the context value and re-renders the tree").
 *
 * Built with {@link createThemeService} rather than a class, per house
 * convention (matches `createFindService`, `createEditorSessionService`).
 *
 * **Preview/commit/revert, precisely**:
 * - {@link ThemeService.previewTheme} switches the active theme to `id`
 *   immediately (so every `useTheme()` consumer re-renders with it right
 *   away — this is what makes `theme.select`'s "highlight move" a *live*
 *   preview, not just a staged choice) and, on the FIRST preview call since
 *   the last commit/revert, stashes whatever was active before — so a
 *   whole sequence of previews (arrowing through a quick-pick list) only
 *   ever remembers the theme that was active before the picker opened, not
 *   each intermediate hop.
 * - {@link ThemeService.commitTheme} finalizes whatever theme is currently
 *   active (whether or not it got there via a preview) as the real choice:
 *   clears the stash and calls `deps.onCommit(id)` — Phase 4's settings
 *   writer persists `workbench.colorTheme` there.
 * - {@link ThemeService.revertTheme} restores the stashed pre-preview theme
 *   (a no-op if nothing was ever stashed — nothing to revert) and clears
 *   the stash without calling `onCommit`.
 *
 * **`setTheme` vs. `previewTheme`+`commitTheme`**: {@link ThemeService.setTheme}
 * is the OTHER path to a live theme switch — an external
 * `workbench.colorTheme` config change (a user hand-editing `settings.json`,
 * Phase 4.4's `config.onDidChange` wiring) rather than an interactive
 * preview session. It switches immediately, clears any in-progress preview
 * stash (the config file is now the source of truth; an old preview has
 * nothing left to revert TO), and deliberately does NOT call `onCommit` —
 * the config file already reflects this value, so writing it back would
 * just be a redundant round-trip (and, worse, a feedback loop if the write
 * itself re-triggers the same `onDidChange`).
 */

import type { Disposable, Event, Listener, ResolvedTheme } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import { BASE_THEME_ID, type ThemeRegistry } from "./themeRegistry";

/** Dependencies for {@link createThemeService}. */
export interface ThemeServiceDeps {
  /** Resolves a theme id to its {@link ResolvedTheme} — narrowed to what
   * this service actually calls (a real `ThemeRegistry`, or a test fake). */
  registry: Pick<ThemeRegistry, "get">;
  /** The theme id to start active — typically the resolved
   * `workbench.colorTheme` setting (Req 7.5, `config/coreDefaults.ts`).
   * Falls back to {@link BASE_THEME_ID} if `registry.get(initialThemeId)`
   * has nothing for it yet (e.g. the configured theme hasn't finished
   * loading — the deferred-phase live-switch, Phase 4.4, picks it up once
   * it has). */
  initialThemeId?: string;
  /** Called once per {@link ThemeService.commitTheme} call, with the
   * committed theme's id — Phase 4's settings-writer wiring
   * (`themeSettingsWriter.ts`) persists `workbench.colorTheme` here.
   * Optional: a caller with no persistence wired yet (every unit test) just
   * commits in-memory. Guarded — a throwing `onCommit` cannot break
   * `commitTheme`'s own never-throwing contract. */
  onCommit?: (themeId: string) => void;
  log?: HostLog;
}

/** The theme service's public surface (Req 7.3, 7.5). */
export interface ThemeService {
  /** The currently active, fully resolved theme — what `useTheme()`/
   * `tecode.themes.current` read. */
  get(): ResolvedTheme;
  /** The currently active theme's id. */
  getActiveThemeId(): string;
  /** Preview switching to `id` (this module's TSDoc). A no-op (with a
   * warning logged) if `id` is not yet known to the registry. */
  previewTheme(id: string): void;
  /** Finalize the currently active theme (this module's TSDoc). */
  commitTheme(): void;
  /** Undo a preview back to the pre-preview theme (this module's TSDoc). A
   * no-op if nothing is currently stashed. */
  revertTheme(): void;
  /** Switch the active theme directly, bypassing the preview/stash
   * workflow (this module's TSDoc) — the config-file-driven live-switch
   * path. A no-op (with a warning logged) if `id` is not yet known to the
   * registry. */
  setTheme(id: string): void;
  /** Fires whenever the active theme changes, from any of the four
   * methods above. Carries no payload, matching this codebase's other
   * `onDidChange` events. */
  onDidChange: Event<void>;
  /** Clear every listener. Idempotent. */
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

/** Build a theme service (Req 7.3, 7.5). */
export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  const { registry, log } = deps;

  const startId = deps.initialThemeId && registry.get(deps.initialThemeId) ? deps.initialThemeId : BASE_THEME_ID;
  const startEntry = registry.get(startId) ?? registry.get(BASE_THEME_ID);

  let activeThemeId = startId;
  // `startEntry` is only `undefined` if even the always-seeded base theme
  // is somehow missing from `registry` (a misbehaving/fake registry in a
  // test) — an empty ResolvedTheme is a safe, never-throwing fallback for
  // that unreachable-in-production case.
  let activeTheme: ResolvedTheme = startEntry?.theme ?? { colors: {} as ResolvedTheme["colors"], tokens: {} };

  let stash: { id: string; theme: ResolvedTheme } | undefined;
  const listeners = new Set<Listener<void>>();
  let disposed = false;

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches
    // every other `onDidChange` in this codebase.
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch (cause) {
        logSafely(log, "error", {
          message: `ThemeService onDidChange listener threw: ${describeError(cause)}`,
        });
      }
    }
  }

  function get(): ResolvedTheme {
    return activeTheme;
  }

  function getActiveThemeId(): string {
    return activeThemeId;
  }

  function previewTheme(id: string): void {
    const entry = registry.get(id);
    if (!entry) {
      logSafely(log, "warning", {
        message: `theme.select: cannot preview unknown theme id "${id}".`,
      });
      return;
    }
    if (!stash) {
      stash = { id: activeThemeId, theme: activeTheme };
    }
    activeThemeId = entry.id;
    activeTheme = entry.theme;
    fireChange();
  }

  function commitTheme(): void {
    stash = undefined;
    const id = activeThemeId;
    if (deps.onCommit) {
      try {
        deps.onCommit(id);
      } catch (cause) {
        logSafely(log, "error", {
          message: `ThemeService onCommit callback threw: ${describeError(cause)}`,
        });
      }
    }
  }

  function revertTheme(): void {
    if (!stash) return;
    const { id, theme } = stash;
    stash = undefined;
    activeThemeId = id;
    activeTheme = theme;
    fireChange();
  }

  function setTheme(id: string): void {
    const entry = registry.get(id);
    if (!entry) {
      logSafely(log, "warning", {
        message: `Cannot switch to unknown theme id "${id}".`,
      });
      return;
    }
    stash = undefined;
    if (activeThemeId === entry.id && activeTheme === entry.theme) return;
    activeThemeId = entry.id;
    activeTheme = entry.theme;
    fireChange();
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
    get,
    getActiveThemeId,
    previewTheme,
    commitTheme,
    revertTheme,
    setTheme,
    onDidChange,
    dispose,
  };
}
