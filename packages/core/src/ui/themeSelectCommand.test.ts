/**
 * Tests for {@link createThemeSelectHandler}/{@link registerThemeSelectCommand}
 * (Req 7.5) — exercised against the REAL `ThemeRegistry`/`ThemeService`
 * (plus a `ThemeSettingsWriter` wired as `ThemeService.onCommit`) so
 * "preview -> commit persists workbench.colorTheme" is proven end to end,
 * not just that the right methods were called.
 */

import { describe, expect, test } from "bun:test";
import type { QuickPickItem } from "@tecode/api";
import { parseJsonc } from "../config/jsonc";
import { BASE_THEME_ID, createThemeRegistry, type ThemeRegistryFs } from "./themeRegistry";
import { createThemeService } from "./themeService";
import { createThemeSettingsWriter, type ThemeSettingsWriterFs } from "./themeSettingsWriter";
import { createThemeSelectHandler, registerThemeSelectCommand } from "./themeSelectCommand";

function createFakeThemeFs(files: Record<string, string>): ThemeRegistryFs {
  return {
    readFile: (path) => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
        : Promise.resolve(text);
    },
  };
}

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

async function buildHarness() {
  const themeRegistry = createThemeRegistry({
    fs: createFakeThemeFs({ "/dark.json": JSON.stringify({ colors: { "editor.background": "#010101" } }) }),
  });
  themeRegistry.register({ id: "dark", label: "Dark", path: "/dark.json" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const settings = createFakeSettingsFs("{}\n");
  const settingsWriter = createThemeSettingsWriter({ path: "/settings.json", fs: settings.fs });

  const themeService = createThemeService({
    registry: themeRegistry,
    initialThemeId: BASE_THEME_ID,
    onCommit: (id) => {
      void settingsWriter.write(id);
    },
  });

  return { themeRegistry, themeService, settings };
}

describe("createThemeSelectHandler (Req 7.5)", () => {
  test("accepting a picked theme previews, commits, and persists workbench.colorTheme", async () => {
    const { themeRegistry, themeService, settings } = await buildHarness();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async (items) => items.find((i) => i.description === "dark"),
    });

    await handler();

    expect(themeService.getActiveThemeId()).toBe("dark");
    // Give the fire-and-forget settingsWriter.write() call a microtask to
    // land (onCommit's write() promise is intentionally not awaited by
    // ThemeService itself — see themeService.ts's TSDoc).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = parseJsonc<Record<string, unknown>>(settings.get());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe("dark");
  });

  test("canceling (showQuickPick resolves undefined) reverts and never commits", async () => {
    const { themeRegistry, themeService, settings } = await buildHarness();
    const before = settings.get();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async () => undefined,
    });

    await handler();

    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(settings.get()).toBe(before);
  });

  test("a throwing showQuickPick reverts instead of leaving a stuck preview", async () => {
    const { themeRegistry, themeService } = await buildHarness();
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async () => {
        throw new Error("picker exploded");
      },
    });

    await expect(handler()).resolves.toBeUndefined();
    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
  });

  test("an empty registry is a no-op (never calls showQuickPick)", async () => {
    const themeRegistry = { list: () => [] };
    const themeService = {
      previewTheme: () => {
        throw new Error("must not be called");
      },
      commitTheme: () => {
        throw new Error("must not be called");
      },
      revertTheme: () => {
        throw new Error("must not be called");
      },
    };
    let called = false;
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async () => {
        called = true;
        return undefined;
      },
    });
    await handler();
    expect(called).toBe(false);
  });

  test("a picked item with no matching theme id reverts", async () => {
    const { themeRegistry, themeService } = await buildHarness();
    const bogus: QuickPickItem = { label: "Ghost", description: "does-not-exist" };
    const handler = createThemeSelectHandler({
      themeRegistry,
      themeService,
      showQuickPick: async () => bogus,
    });
    await handler();
    expect(themeService.getActiveThemeId()).toBe(BASE_THEME_ID);
  });
});

describe("registerThemeSelectCommand (Req 7.5)", () => {
  test("registers \"theme.select\" directly on the given command registry", async () => {
    const { themeRegistry, themeService } = await buildHarness();
    const registered: Record<string, () => unknown> = {};
    const commands = {
      register(id: string, handler: () => unknown) {
        registered[id] = handler;
        return { dispose() {} };
      },
    };

    registerThemeSelectCommand(commands, {
      themeRegistry,
      themeService,
      showQuickPick: async (items) => items.find((i) => i.description === "dark"),
    });

    expect(registered["theme.select"]).toBeDefined();
    await registered["theme.select"]!();
    expect(themeService.getActiveThemeId()).toBe("dark");
  });
});
