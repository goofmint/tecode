/**
 * OS-dependent configuration-directory resolution (Req 9.1, design.md §11),
 * confined entirely to this module: every other module that needs a config
 * path calls one of these helpers rather than branching on
 * `process.platform` itself.
 *
 * - POSIX (macOS, Linux, ...): `~/.config/tecode/`.
 * - Windows: `%APPDATA%\tecode\`, falling back to `~/AppData/Roaming/tecode`
 *   when `APPDATA` is unset (rare, but not impossible in a stripped-down
 *   shell).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The user-level tecode configuration directory for the current OS (Req
 * 9.1). Does not create the directory or check that it exists — callers
 * that need it to exist do that themselves. */
export function getUserConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) return join(appData, "tecode");
    return join(homedir(), "AppData", "Roaming", "tecode");
  }
  return join(homedir(), ".config", "tecode");
}

/** Path to the user-level `settings.json` (Req 9.1). */
export function getUserSettingsPath(): string {
  return join(getUserConfigDir(), "settings.json");
}

/** Path to the user-level `keybindings.json` (Req 9.1). */
export function getUserKeybindingsPath(): string {
  return join(getUserConfigDir(), "keybindings.json");
}

/** Path to the user-level `state.json` — persisted UI layout state (sidebar
 * width/visibility, panel height/visibility, active view — Req 6.4,
 * design.md §8.2: "Layout state ... persists to `~/.config/tecode/state.json`
 * on change (debounced) and on exit"). */
export function getUserLayoutStatePath(): string {
  return join(getUserConfigDir(), "state.json");
}

/** Path to a workspace's `.tecode/settings.json`, overlaid on top of user
 * settings when the workspace declares one (Req 9.2). `workspaceRoot` is
 * the workspace's root directory (an absolute path). */
export function getWorkspaceSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".tecode", "settings.json");
}

/**
 * The user-level extensions directory, scanned second (after built-ins)
 * during discovery (Req 2.1, design.md §4.1): `~/.config/tecode/extensions`
 * (or the Windows equivalent under {@link getUserConfigDir}). Each
 * immediate subdirectory is one extension.
 *
 * **Deviation from the original plan**: the plan mentioned `XDG_CONFIG_HOME`
 * for this path, but `paths.ts` deliberately does not branch on that env
 * var anywhere else (see the module TSDoc) — this helper stays consistent
 * with the existing homedir-based resolution rather than introducing new
 * OS-conventions handling for extensions alone.
 */
export function getUserExtensionsDir(): string {
  return join(getUserConfigDir(), "extensions");
}

/** The workspace-level extensions directory, scanned last (highest
 * precedence) during discovery (Req 2.1, design.md §4.1):
 * `<workspaceRoot>/.tecode/extensions`. `workspaceRoot` is the workspace's
 * root directory (an absolute path). */
export function getWorkspaceExtensionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".tecode", "extensions");
}
