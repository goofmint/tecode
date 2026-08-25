/**
 * `theme.select` exercised against the REAL built-in Dark Modern/Light
 * Modern themes (Task 2.7, Req 7.5, 11.4) — follows
 * `@tecode/core`'s `ui/themeSelectCommand.test.ts`'s `buildHarness()`
 * pattern (a real `ThemeRegistry`/`ThemeService`/`ThemeSettingsWriter`,
 * not mocks), but loads `@tecode/builtin`'s actual `themes-default`
 * contribution through the same `createBuiltinThemeAssetsFs` overlay
 * `main.ts`'s `buildAssemblyRoot` wires in production, rather than a
 * synthetic `"/dark.json"` fixture — proving the command palette's
 * `theme.select` genuinely lists, previews, commits, and reverts THESE
 * two themes end to end. Lives in `packages/cli` rather than
 * `@tecode/core` because it needs `@tecode/builtin`'s theme data, and
 * `core` may not import `builtin` (the ESLint layering rule runs the
 * other direction) — `themeSelectCommand.test.ts`'s own TSDoc note on
 * where to put this.
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
import {
  builtinManifests,
  builtinThemeAssets,
  DARK_MODERN_THEME_ID,
  LIGHT_MODERN_THEME_ID,
} from "@tecode/builtin";
import { collectBuiltinPendingThemes } from "./main";
import { createBuiltinThemeAssetsFs } from "./themeAssetsFs";

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

/** Builds a `ThemeRegistry` seeded with the real `themes-default`
 * contributions, loaded through the same embedded-asset overlay
 * `buildAssemblyRoot` uses in production (`themeAssetsFs.ts`), plus a
 * `ThemeService`/`ThemeSettingsWriter` pair wired exactly like
 * `main.ts`'s composition root wires them. */
async function buildHarness() {
  const themeRegistry = createThemeRegistry({ fs: createBuiltinThemeAssetsFs(builtinThemeAssets) });
  const { pending, extensionDirs } = collectBuiltinPendingThemes(builtinManifests);
  await themeRegistry.loadContributions(pending, extensionDirs);

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

describe("theme.select over the real Dark Modern / Light Modern themes (Req 7.5, 11.4)", () => {
  test("both built-in themes are listed", async () => {
    const { themeRegistry } = await buildHarness();
    const listed = themeRegistry.list();
    expect(listed.some((t) => t.id === DARK_MODERN_THEME_ID && t.label === "Dark Modern")).toBe(true);
    expect(listed.some((t) => t.id === LIGHT_MODERN_THEME_ID && t.label === "Light Modern")).toBe(true);
  });

  test("picking Light Modern previews and commits it, persisting workbench.colorTheme", async () => {
    const { themeRegistry, themeService, settings } = await buildHarness();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async (items) => items.find((i) => i.description === LIGHT_MODERN_THEME_ID),
    });

    expect(themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);

    await handler();

    // Preview + commit both landed: the active theme switched, and its
    // resolved colors are genuinely Light Modern's (not still Dark
    // Modern's, and not the base palette's).
    expect(themeService.getActiveThemeId()).toBe(LIGHT_MODERN_THEME_ID);
    expect(themeService.get().colors["editor.background"]).toEqual({ r: 255, g: 255, b: 255 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = parseJsonc<Record<string, unknown>>(settings.get());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe(LIGHT_MODERN_THEME_ID);
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

  test("registerThemeSelectCommand registers \"theme.select\" and it switches themes end to end", async () => {
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
        items.find((i) => i.description === LIGHT_MODERN_THEME_ID),
    });

    expect(registered["theme.select"]).toBeDefined();
    await registered["theme.select"]!();
    expect(themeService.getActiveThemeId()).toBe(LIGHT_MODERN_THEME_ID);
  });
});
