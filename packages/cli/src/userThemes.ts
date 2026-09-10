/**
 * Scans the user themes directory (Req 11.4, Issue #124; design.md §3,
 * §9) for `*.json` theme files and turns each into a
 * `PendingThemeContribution` — the same shape a manifest's
 * `contributes.themes` entry normalizes to (`@tecode/core`'s
 * `host/registration.ts`) — so `main.ts`'s deferred phase can feed them
 * into the SAME `ThemeRegistry.loadContributions` call every other theme
 * (built-in or manifest-declared) goes through. No new distribution or
 * loading mechanism: a user theme is just another `PendingThemeContribution`
 * against a synthetic `extensionId`, resolved by `ThemeRegistry`'s
 * ordinary `join(baseDir, contribution.path)` + real `fs.readFile` path —
 * `themeAssetsFs.ts`'s embedded-asset overlay only intercepts BUILT-IN
 * paths (a real path like this one falls straight through to
 * `createBuiltinThemeAssetsFs`'s `realFs.readFile` fallback, that module's
 * TSDoc).
 *
 * **id/label derivation**: a theme file's id is its filename stem (e.g.
 * `light-modern.json` -> `"light-modern"`); its label is the theme JSON's
 * own top-level `"name"` string when present, otherwise the same stem.
 * `themeLoader.ts`'s `ThemeJson` type has no `name` field of its own — an
 * extra top-level key is simply ignored by `loadThemeFromJsonText`, so
 * this scanner reads it itself, tolerantly (JSONC, `parseJsonc`), purely
 * for the label; a parse failure or a missing/non-string `name` just falls
 * back to the stem rather than failing this file's registration outright
 * — the REAL parse (and this MVP's per-key degrade to the base palette on
 * a genuinely broken file) still happens later, inside
 * `ThemeRegistry.loadContributions` itself (`themeLoader.ts`'s
 * `loadThemeFromJsonText`), exactly like any other theme.
 *
 * **Never fails startup**: a missing themes directory (ENOENT) is a
 * normal, expected case (Req 11.4's "copy `themes/light-modern.json` to
 * `~/.config/tecode/themes/`" is opt-in, README.md) — this returns `[]`
 * rather than throwing or logging. Any OTHER `readdir` failure (e.g.
 * permission denied) also degrades to `[]`, logged as a warning rather
 * than propagated, matching every other host-side scanner's "a bad
 * extension/theme is skipped and reported, startup continues" policy
 * (`host/registration.ts`'s own TSDoc). A single unreadable `*.json` file
 * is skipped individually (with its own warning) rather than failing the
 * whole scan — one bad file must not hide every other user theme.
 */

import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getUserThemesDir,
  parseJsonc,
  type HostLog,
  type PendingThemeContribution,
} from "@tecode/core";

/** The synthetic `extensionId` every user theme's `PendingThemeContribution`
 * is attributed to — mirrors a real extension id closely enough to read
 * naturally in logs/tests, but is not (and does not need to be) a
 * `Manifest.id` anywhere; nothing validates it against `validate.ts`'s
 * manifest rules, since these contributions never go through
 * `registerExtension` at all. */
export const USER_THEMES_EXTENSION_ID = "user.themes";

/** The narrow filesystem seam {@link scanUserThemes} needs: listing the
 * themes directory and reading one theme file's text. Injectable so tests
 * can simulate a themes directory without touching the real filesystem —
 * matches `ThemeRegistryFs`'s (`@tecode/core`'s `ui/themeRegistry.ts`)
 * same narrow-seam shape. */
export interface UserThemesFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

function createNodeUserThemesFs(): UserThemesFs {
  return {
    readdir: (path) => nodeReaddir(path),
    readFile: (path) => nodeReadFile(path, "utf8"),
  };
}

/** Dependencies for {@link scanUserThemes}. */
export interface ScanUserThemesDeps {
  /** Defaults to {@link getUserThemesDir}(). Overridable so a test can
   * point at a temp directory without relying on `HOME`/`APPDATA`
   * overrides alone. */
  themesDir?: string;
  /** Filesystem seam — see {@link UserThemesFs}. Defaults to
   * `node:fs/promises`. */
  fs?: UserThemesFs;
  log?: HostLog;
}

/** What {@link scanUserThemes} produces: the same
 * `PendingThemeContribution[]` / `extensionId -> directory` pair shape
 * `collectBuiltinPendingThemes` (`main.ts`) produces for built-ins, and
 * `ThemeRegistry.loadContributions` itself takes — {@link
 * USER_THEMES_EXTENSION_ID} maps to `themesDir` for every entry, since
 * every user theme file lives directly in that one directory (Req 11.4:
 * `path` is a bare filename, not a subpath). */
export interface ScanUserThemesResult {
  pending: PendingThemeContribution[];
  extensionDirs: Record<string, string>;
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

/** `true` for a Node `ENOENT` (`readdir`/`readFile` on a path that does
 * not exist) — checked structurally (`code` property) rather than via
 * `instanceof`, matching how the rest of this codebase narrows caught
 * filesystem errors (`documentManager.ts`'s ENOENT handling). */
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** Guarded `log.append` (matches every other module's `logSafely`). */
function logSafely(log: HostLog | undefined, message: string): void {
  if (!log) return;
  try {
    log.append("warning", { message });
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Best-effort label for one user theme file's already-read text: its
 * JSON's top-level `name` string when it parses AND declares one,
 * otherwise `fallback` (the filename stem). A parse failure here does NOT
 * skip the file — it only loses the nicer label; the REAL parse (and its
 * per-key degrade to the base palette on genuinely broken JSON) happens
 * later, inside `ThemeRegistry.loadContributions` itself (this module's
 * TSDoc). */
function resolveLabel(text: string, fallback: string): string {
  const parsed = parseJsonc<unknown>(text);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return fallback;
  const name = (parsed.value as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0 ? name : fallback;
}

/**
 * Scan the user themes directory for `*.json` files and build the
 * `PendingThemeContribution[]`/`extensionId -> directory` pair `main.ts`'s
 * deferred phase feeds into `ThemeRegistry.loadContributions` (this
 * module's TSDoc). Never rejects.
 */
export async function scanUserThemes(deps: ScanUserThemesDeps = {}): Promise<ScanUserThemesResult> {
  const themesDir = deps.themesDir ?? getUserThemesDir();
  const fs = deps.fs ?? createNodeUserThemesFs();

  let entries: string[];
  try {
    entries = await fs.readdir(themesDir);
  } catch (cause) {
    if (!isEnoent(cause)) {
      logSafely(deps.log, `Could not scan user themes directory (${themesDir}): ${describeError(cause)}.`);
    }
    return { pending: [], extensionDirs: {} };
  }

  const jsonFiles = entries.filter((entry) => entry.toLowerCase().endsWith(".json"));
  if (jsonFiles.length === 0) return { pending: [], extensionDirs: {} };

  const pending: PendingThemeContribution[] = [];
  for (const fileName of jsonFiles) {
    // `basename(name, suffix)` strips the suffix case-SENSITIVELY, but the
    // filter above accepts the extension case-INSENSITIVELY — so `ocean.JSON`
    // was collected and then kept its extension, yielding the theme id
    // `"ocean.JSON"`. Strip whatever the filter matched instead of a fixed
    // literal, so the two halves agree on what counts as the extension.
    const stem = fileName.slice(0, fileName.length - ".json".length);
    if (stem.length === 0) continue;
    const path = join(themesDir, fileName);
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      // Individually unreadable (permission denied, deleted between
      // readdir and readFile, ...) — skip just this file, warn, and keep
      // scanning the rest (this module's TSDoc: "one bad file must not
      // hide every other user theme").
      logSafely(deps.log, `Skipping unreadable user theme file (${path}): ${describeError(cause)}.`);
      continue;
    }
    pending.push({
      extensionId: USER_THEMES_EXTENSION_ID,
      theme: { id: stem, label: resolveLabel(text, stem), path: fileName },
    });
  }

  return {
    pending,
    extensionDirs: { [USER_THEMES_EXTENSION_ID]: themesDir },
  };
}
