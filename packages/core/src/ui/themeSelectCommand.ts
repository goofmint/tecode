/**
 * The `theme.select` command (Req 7.5, design.md §9): lets the user pick a
 * theme from a quick-pick list, with live preview as the highlighted item
 * changes and commit/revert on accept/cancel — "the `theme.select` command
 * SHALL offer theme switching with live preview from the command palette."
 *
 * **Registered directly on the core `CommandRegistry`, not through the
 * extension API** (this task's plan, following `shell.tsx`'s
 * `workbench.view.<id>` precedent of `props.commands.register(...)`):
 * `ThemeService.previewTheme`/`commitTheme`/`revertTheme` are privileged
 * operations with no equivalent on `@tecode/api`'s `ThemesNamespace`
 * (which exposes only `register`/`current` to extensions, `namespaces.ts`'s
 * TSDoc) — `theme.select`'s handler closes over the real `ThemeService`
 * directly, something only composition-root code (`main.ts`) can wire, the
 * same privilege boundary `workbench.view.<id>`'s handler has over
 * `LayoutStateService`.
 *
 * **Structured around preview/commit/revert, ahead of live-preview-while-
 * browsing** (this task's plan): Task 3.1 gave `WindowNamespace.
 * showQuickPick` a real implementation (`ui/modalService.ts`), but
 * `QuickPickOptions` still carries no "the highlighted item changed"
 * callback — so this handler can only preview-then-immediately-commit on
 * accept, or revert on cancel, not preview *while the user is still
 * browsing*. This module is written so that upgrade is additive:
 * {@link createThemeSelectHandler} takes `showQuickPick` as an injected
 * dependency (not hardcoded to `window.showQuickPick`), so a future
 * "active item changed" callback only needs a new call site here, not a
 * rewrite of the preview/commit/revert sequencing itself.
 */

import type { CommandHandler, Disposable, QuickPickItem, QuickPickOptions } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import type { ThemeRegistry } from "./themeRegistry";
import type { ThemeService } from "./themeService";

/** Dependencies for {@link createThemeSelectHandler}. */
export interface ThemeSelectDeps {
  /** Enumerates the choices (Req 7.1's theme list) — narrowed to `list`,
   * the only method this command needs. */
  themeRegistry: Pick<ThemeRegistry, "list">;
  /** The privileged preview/commit/revert surface this handler drives
   * (this module's TSDoc) — narrowed to exactly those three methods. */
  themeService: Pick<ThemeService, "previewTheme" | "commitTheme" | "revertTheme">;
  /** The quick-pick surface (`@tecode/api`'s `WindowNamespace.showQuickPick`
   * shape) — injected rather than hardcoded so a future real picker (Task
   * 3.1) is a substitution, not a rewrite (this module's TSDoc). */
  showQuickPick: (
    items: QuickPickItem[],
    options?: QuickPickOptions,
  ) => Promise<QuickPickItem | undefined>;
  log?: HostLog;
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

/**
 * Build the `theme.select` command handler (Req 7.5). Enumerates
 * `themeRegistry.list()` as quick-pick items (`description` carries the
 * theme id, `label` its display name — round-tripped back through the
 * SAME list on return, since `showQuickPick`'s contract only promises back
 * whichever `QuickPickItem` the user picked, not the original
 * `ThemeListEntry`); on accept, previews then immediately commits the
 * picked theme (this module's TSDoc on why "preview" and "commit" are not
 * yet temporally separated); on cancel (or an empty registry, or a
 * throwing `showQuickPick`), reverts to whatever was active before this
 * invocation. Never throws — matches `CommandRegistry.execute`'s
 * guaranteed-not-to-throw contract, and every handler exception is caught
 * either way so a broken `showQuickPick` cannot leave the theme service in
 * a stuck preview.
 */
export function createThemeSelectHandler(deps: ThemeSelectDeps): CommandHandler {
  return async () => {
    const themes = deps.themeRegistry.list();
    if (themes.length === 0) {
      logSafely(deps.log, "warning", { message: "theme.select: no themes are registered." });
      return;
    }

    const items: QuickPickItem[] = themes.map((t) => ({ label: t.label, description: t.id }));

    let picked: QuickPickItem | undefined;
    try {
      picked = await deps.showQuickPick(items, { placeHolder: "Select a color theme" });
    } catch (cause) {
      logSafely(deps.log, "error", {
        message: `theme.select: showQuickPick threw: ${describeError(cause)}`,
      });
      deps.themeService.revertTheme();
      return;
    }

    if (!picked) {
      deps.themeService.revertTheme();
      return;
    }

    const match = themes.find((t) => t.id === picked!.description);
    if (!match) {
      logSafely(deps.log, "warning", {
        message: `theme.select: picked item did not match any known theme id.`,
      });
      deps.themeService.revertTheme();
      return;
    }

    deps.themeService.previewTheme(match.id);
    deps.themeService.commitTheme();
  };
}

/** Register {@link createThemeSelectHandler}'s handler as `"theme.select"`
 * on the core `CommandRegistry` (this module's TSDoc — a direct
 * `commands.register` call, not routed through `tecode.commands`). */
export function registerThemeSelectCommand(
  commands: { register(id: string, handler: CommandHandler): Disposable },
  deps: ThemeSelectDeps,
): Disposable {
  return commands.register("theme.select", createThemeSelectHandler(deps));
}
