/**
 * `theme.select` exercised against the REAL built-in Dark Modern theme
 * PLUS a fixture user theme (Task 2.7, Req 7.5, 11.4; Issue #124) —
 * follows `@tecode/core`'s `ui/themeSelectCommand.test.ts`'s
 * `buildHarness()` pattern (a real `ThemeRegistry`/`ThemeService`/
 * `ThemeSettingsWriter`, not mocks), loading Dark Modern through the same
 * `createBuiltinThemeAssetsFs` overlay `main.ts`'s `buildAssemblyRoot`
 * wires in production, and Light Modern through `ThemeRegistry`'s
 * ORDINARY real-`fs.readFile` path against the repository's own top-level
 * `themes/` directory — exactly what `packages/cli/src/userThemes.ts`'s
 * `scanUserThemes` would find if that directory were copied to
 * `~/.config/tecode/themes/` (README.md's "Themes" section) — rather than
 * a synthetic `"/dark.json"` fixture.
 *
 * **Only Dark Modern is embedded now** (Issue #124): `themes-default` no
 * longer contributes Light Modern at all — it moved to the top-level
 * `themes/light-modern.json`, no longer a `builtinManifests`/
 * `builtinThemeAssets` entry. This suite therefore builds its
 * `ThemeRegistry` the same two-step way `main.ts`'s real startup does:
 * `collectBuiltinPendingThemes` + `createBuiltinThemeAssetsFs` for Dark
 * Modern (the sync-phase pre-load), THEN a second
 * `loadContributions` call carrying a `PendingThemeContribution` built
 * directly from the top-level `themes/light-modern.json` file (the
 * deferred-phase equivalent of what `scanUserThemes` + `main.ts`'s
 * `runDeferredPhase` do for a real user themes directory) — proving the
 * command palette's `theme.select` genuinely lists, previews, commits,
 * and reverts BOTH a built-in and a user theme end to end, through the
 * exact same registry API.
 *
 * Lives in `packages/cli` rather than `@tecode/core` because it needs
 * `@tecode/builtin`'s theme data, and `core` may not import `builtin`
 * (the ESLint layering rule runs the other direction) —
 * `themeSelectCommand.test.ts`'s own TSDoc note on where to put this.
 */

import { describe, expect, test } from "bun:test";
import type { QuickPickItem } from "@tecode/api";
import {
  createThemeRegistry,
  createThemeSelectHandler,
  createThemeService,
  createThemeSettingsWriter,
  parseJsonc,
  registerThemeSelectCommand,
  type ThemeSettingsWriterFs,
} from "@tecode/core";
import { builtinManifests, builtinThemeAssets, DARK_MODERN_THEME_ID } from "@tecode/builtin";
import { collectBuiltinPendingThemes } from "./main";
import { createBuiltinThemeAssetsFs } from "./themeAssetsFs";

/** The fixture user theme this suite exercises alongside Dark Modern:
 * `tecode.dark-modern`'s sibling at the repository's top-level `themes/`
 * — the exact file README.md tells a user to copy to
 * `~/.config/tecode/themes/light-modern.json` (this module's TSDoc). Its
 * id, per `userThemes.ts`'s id-derivation rule (the filename stem), is
 * `"light-modern"` — NOT `tecode.light-modern` (that id no longer exists
 * anywhere; it was `themes-default`'s pre-Issue-#124 built-in id). */
const LIGHT_MODERN_USER_THEME_ID = "light-modern";
const LIGHT_MODERN_USER_THEME_PATH = `${import.meta.dir}/../../../themes/light-modern.json`;

function createFakeSettingsFs(initial: string): { fs: ThemeSettingsWriterFs; get(): string } {
  let content = initial;
  return {
    get: () => content,
    fs: {
      readFile: () => Promise.resolve(content),
      mkdir: () => Promise.resolve(),
      writeFile: (_path, data) => {
        content = data;
        return Promise.resolve();
      },
    },
  };
}

/** Builds a `ThemeRegistry` seeded with the real embedded Dark Modern
 * contribution (exactly like `main.ts`'s sync-phase pre-load), PLUS the
 * fixture Light Modern user theme (this module's TSDoc) loaded through a
 * second `loadContributions` call — mirroring `main.ts`'s
 * `runDeferredPhase` running `scanUserThemes` + a second
 * `loadContributions` after the built-in pre-load — plus a
 * `ThemeService`/`ThemeSettingsWriter` pair wired exactly like `main.ts`'s
 * composition root wires them. */
async function buildHarness() {
  const themeRegistry = createThemeRegistry({ fs: createBuiltinThemeAssetsFs(builtinThemeAssets) });
  const { pending, extensionDirs } = collectBuiltinPendingThemes(builtinManifests);
  await themeRegistry.loadContributions(pending, extensionDirs);

  // The fixture user theme — `ThemeRegistry`'s ORDINARY real-`fs.readFile`
  // path (no embedded-asset overlay involved at all), same as any real
  // `~/.config/tecode/themes/*.json` file would go through.
  await themeRegistry.loadContributions(
    [
      {
        extensionId: "fixture.user-themes",
        theme: { id: LIGHT_MODERN_USER_THEME_ID, label: "Light Modern", path: "light-modern.json" },
      },
    ],
    { "fixture.user-themes": `${import.meta.dir}/../../../themes` },
  );

  const settings = createFakeSettingsFs("{}\n");
  const settingsWriter = createThemeSettingsWriter({ path: "/settings.json", fs: settings.fs });

  const themeService = createThemeService({
    registry: themeRegistry,
    initialThemeId: DARK_MODERN_THEME_ID,
    onCommit: (id) => {
      void settingsWriter.write(id);
    },
  });

  return { themeRegistry, themeService, settings };
}

describe("theme.select over the real Dark Modern theme + a fixture user theme (Req 7.5, 11.4, Issue #124)", () => {
  test("both Dark Modern and the fixture Light Modern user theme are listed", async () => {
    const { themeRegistry } = await buildHarness();
    const listed = themeRegistry.list();
    expect(listed.some((t) => t.id === DARK_MODERN_THEME_ID && t.label === "Dark Modern")).toBe(true);
    expect(listed.some((t) => t.id === LIGHT_MODERN_USER_THEME_ID && t.label === "Light Modern")).toBe(true);
  });

  test("picking the fixture Light Modern user theme previews and commits it, persisting workbench.colorTheme", async () => {
    const { themeRegistry, themeService, settings } = await buildHarness();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async (items) => items.find((i) => i.description === LIGHT_MODERN_USER_THEME_ID),
    });

    expect(themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);

    await handler();

    // Preview + commit both landed: the active theme switched, and its
    // resolved colors are genuinely the fixture file's Light Modern
    // colors (not still Dark Modern's, and not the base palette's) — the
    // exact same `#ffffff` `editor.background` the pre-Issue-#124 built-in
    // Light Modern test asserted, now read from a real file instead of an
    // embedded asset.
    expect(themeService.getActiveThemeId()).toBe(LIGHT_MODERN_USER_THEME_ID);
    expect(themeService.get().colors["editor.background"]).toEqual({ r: 255, g: 255, b: 255 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = parseJsonc<Record<string, unknown>>(settings.get());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe(LIGHT_MODERN_USER_THEME_ID);
  });

  test("canceling the picker reverts to Dark Modern and never commits", async () => {
    const { themeRegistry, themeService, settings } = await buildHarness();
    const before = settings.get();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async () => undefined,
    });

    await handler();

    expect(themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);
    expect(settings.get()).toBe(before);
  });

  test("registerThemeSelectCommand registers \"theme.select\" and it switches from Dark Modern to the fixture user theme end to end", async () => {
    const { themeRegistry, themeService } = await buildHarness();
    const registered: Record<string, () => unknown> = {};
    const commands = {
      registerCore(id: string, handler: () => unknown) {
        registered[id] = handler;
        return { dispose() {} };
      },
    };

    registerThemeSelectCommand(commands, {
      themeRegistry,
      themeService,
      showQuickPick: async (items: QuickPickItem[]) =>
        items.find((i) => i.description === LIGHT_MODERN_USER_THEME_ID),
    });

    expect(registered["theme.select"]).toBeDefined();
    await registered["theme.select"]!();
    expect(themeService.getActiveThemeId()).toBe(LIGHT_MODERN_USER_THEME_ID);
  });
});

// Sanity check that the fixture path this suite hand-builds above really
// does point at the same file README.md tells a user to copy — a typo in
// that relative path would otherwise make every test above pass for the
// wrong reason (silently falling back to the base palette per-key, not a
// read error `loadThemeFallbackForReadError` would report loudly).
test("fixture path sanity check: themes/light-modern.json exists and is genuinely Light Modern", async () => {
  const text = await Bun.file(LIGHT_MODERN_USER_THEME_PATH).text();
  const parsed = parseJsonc<{ name?: string; colors?: Record<string, string> }>(text);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.name).toBe("Light Modern");
    expect(parsed.value.colors?.["editor.background"]).toBe("#ffffff");
  }
});
