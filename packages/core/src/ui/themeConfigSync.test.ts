/**
 * Tests for {@link applyConfiguredTheme}/{@link wireThemeConfigSync} (Req
 * 7.5) — exercised against the REAL `ConfigService`/`ThemeRegistry`/
 * `ThemeService` so "config-file-driven live switching" is proven through
 * the actual `onDidChange`/`affectsConfiguration` wiring, not a fake.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";
import { createConfigService, type ConfigServiceFs } from "../config/service";
import { BASE_THEME_ID, createThemeRegistry, type ThemeRegistryFs } from "./themeRegistry";
import { createThemeService } from "./themeService";
import { applyConfiguredTheme, wireThemeConfigSync } from "./themeConfigSync";

function createConfigFs(initial: Record<string, string>): { fs: ConfigServiceFs; set(path: string, text: string): void; trigger(path: string): void } {
  const files = { ...initial };
  const onChangeHandlers: Record<string, () => void> = {};
  return {
    set(path, text) {
      files[path] = text;
    },
    trigger(path) {
      onChangeHandlers[path]?.();
    },
    fs: {
      readFile: (path) => {
        const text = files[path];
        return text === undefined
          ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          : Promise.resolve(text);
      },
      watch: (path, onChange) => {
        onChangeHandlers[path] = onChange;
        return { close: () => delete onChangeHandlers[path] };
      },
    },
  };
}

function createThemeFs(files: Record<string, string>): ThemeRegistryFs {
  return {
    readFile: (path) => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : Promise.resolve(text);
    },
  };
}

// Computed the same way `createConfigService` itself computes it
// (`host/paths.ts`), so this suite's fake `fs` dictionary is keyed
// correctly no matter what `HOME`/`APPDATA` happen to be in this
// environment — no real file is ever read (the `fs` seam is fully
// injected), only the path *string* needs to match.
const USER_SETTINGS_PATH = getUserSettingsPath();

async function buildHarness(initialSettings: string) {
  const configFs = createConfigFs({ [USER_SETTINGS_PATH]: initialSettings });
  const config = createConfigService({
    log: createHostLog(),
    sink: { error() {} },
    fs: configFs.fs,
  });
  await config.ready;

  const themeRegistry = createThemeRegistry({
    fs: createThemeFs({ "/dark.json": JSON.stringify({ colors: { "editor.background": "#020202" } }) }),
  });
  themeRegistry.register({ id: "dark", label: "Dark", path: "/dark.json" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const themeService = createThemeService({ registry: themeRegistry, initialThemeId: BASE_THEME_ID });

  return { config, configFs, themeRegistry, themeService };
}

describe("applyConfiguredTheme (Req 7.5)", () => {
  test("applies the configured theme id when it names a known theme", async () => {
    const { config, themeService } = await buildHarness(`{ "workbench.colorTheme": "dark" }`);
    applyConfiguredTheme(config, themeService);
    expect(themeService.getActiveThemeId()).toBe("dark");
  });

  test("is a no-op when the config value is not a string", async () => {
    const { config, themeService } = await buildHarness(`{}`);
    applyConfiguredTheme(config, themeService);
    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
  });

  test("is a safe no-op when the configured id is not yet known to the registry", async () => {
    const { config, themeService } = await buildHarness(`{ "workbench.colorTheme": "not-loaded-yet" }`);
    applyConfiguredTheme(config, themeService);
    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
  });
});

describe("wireThemeConfigSync (Req 7.5, config-file-driven live switching)", () => {
  test("a settings.json change to workbench.colorTheme live-switches the active theme", async () => {
    const { config, configFs, themeService } = await buildHarness(`{}`);
    const sub = wireThemeConfigSync({ config, themeService });

    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.colorTheme": "dark" }`);
    configFs.trigger(USER_SETTINGS_PATH);
    // ConfigService's reload is async (readFile -> parse -> rebuildMerged).
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(themeService.getActiveThemeId()).toBe("dark");
    sub.dispose();
  });

  test("a settings.json change to an unrelated key does not touch the active theme", async () => {
    const { config, configFs, themeService } = await buildHarness(`{}`);
    const sub = wireThemeConfigSync({ config, themeService });

    configFs.set(USER_SETTINGS_PATH, `{ "editor.tabSize": 8 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
    sub.dispose();
  });

  test("dispose() stops future config changes from affecting the theme", async () => {
    const { config, configFs, themeService } = await buildHarness(`{}`);
    const sub = wireThemeConfigSync({ config, themeService });
    sub.dispose();

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.colorTheme": "dark" }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
  });
});
