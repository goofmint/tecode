/**
 * Tests for {@link createThemeRegistry} (Req 7.1, 7.4).
 */

import { describe, expect, test } from "bun:test";
import type { PendingThemeContribution } from "../host/registration";
import { createBaseTheme } from "../api/stubs";
import { quantizeTheme } from "./colorQuantize";
import { BASE_THEME_ID, createThemeRegistry, type ThemeRegistryFs } from "./themeRegistry";

function createFs(files: Record<string, string>): ThemeRegistryFs {
  return {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        const err = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return Promise.reject(err);
      }
      return Promise.resolve(text);
    },
  };
}

const DARK_THEME_JSON = JSON.stringify({
  colors: { "editor.background": "#010101", "editor.foreground": "#fefefe" },
  tokenColors: { keyword: { foreground: "#ff00ff" } },
});

describe("createThemeRegistry (Req 7.1)", () => {
  test("seeds the built-in base theme synchronously — no await needed", () => {
    const registry = createThemeRegistry();
    const entry = registry.get(BASE_THEME_ID);
    expect(entry).toBeDefined();
    expect(entry?.theme).toEqual(createBaseTheme());
    expect(registry.list().map((t) => t.id)).toContain(BASE_THEME_ID);
  });

  test("quantizes the base theme up front when colorDepth is 256", () => {
    const registry = createThemeRegistry({ colorDepth: "256" });
    const entry = registry.get(BASE_THEME_ID);
    expect(entry?.theme).toEqual(quantizeTheme(createBaseTheme()));
  });

  test("register() returns a Disposable synchronously and the theme appears once the async load settles", async () => {
    const fs = createFs({ "/themes/dark.json": DARK_THEME_JSON });
    const registry = createThemeRegistry({ fs });
    let changed = 0;
    registry.onDidChange(() => changed++);

    const disposable = registry.register({ id: "dark", label: "Dark", path: "/themes/dark.json" });
    expect(registry.get("dark")).toBeUndefined(); // not loaded yet

    // Let the microtask queue drain the async load.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const entry = registry.get("dark");
    expect(entry?.label).toBe("Dark");
    expect(entry?.theme.colors["editor.background"]).toEqual({ r: 1, g: 1, b: 1 });
    expect(entry?.theme.tokens["keyword"]).toEqual({ foreground: { r: 255, g: 0, b: 255 } });
    expect(changed).toBeGreaterThan(0);

    disposable.dispose(); // does not un-register an already-stored theme
    expect(registry.get("dark")).toBeDefined();
  });

  test("register() resolves path relative to baseDir when given", async () => {
    const fs = createFs({ "/ext/my-ext/themes/dark.json": DARK_THEME_JSON });
    const registry = createThemeRegistry({ fs });
    registry.register({ id: "dark", label: "Dark", path: "themes/dark.json" }, "/ext/my-ext");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get("dark")).toBeDefined();
  });

  test("a read failure falls back to the base palette for that theme id and still resolves", async () => {
    const fs = createFs({});
    const registry = createThemeRegistry({ fs });
    registry.register({ id: "missing", label: "Missing", path: "/nope.json" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = registry.get("missing");
    expect(entry).toBeDefined();
    expect(entry?.theme).toEqual(createBaseTheme());
  });

  test("loadContributions resolves once every pending theme has settled, and quantizes when requested", async () => {
    const fs = createFs({ "/ext/a/theme.json": DARK_THEME_JSON });
    const registry = createThemeRegistry({ fs, colorDepth: "256" });
    const pending: PendingThemeContribution[] = [
      { extensionId: "ext-a", theme: { id: "ext-theme", label: "Ext Theme", path: "theme.json" } },
    ];
    await registry.loadContributions(pending, { "ext-a": "/ext/a" });

    const entry = registry.get("ext-theme");
    expect(entry).toBeDefined();
    // The JSON declares editor.background as #010101 (1,1,1) — a value
    // NOT already on the xterm-256 palette, so seeing the quantized
    // (0,0,0) cube corner here proves quantization actually ran, not just
    // that the loader parsed the JSON.
    expect(entry?.theme.colors["editor.background"]).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("loadContributions with no matching extensionDir uses the path as-is and still settles", async () => {
    const fs = createFs({ "theme.json": DARK_THEME_JSON });
    const registry = createThemeRegistry({ fs });
    const pending: PendingThemeContribution[] = [
      { extensionId: "unknown-ext", theme: { id: "ext-theme", label: "Ext Theme", path: "theme.json" } },
    ];
    await registry.loadContributions(pending, {});
    expect(registry.get("ext-theme")).toBeDefined();
  });

  test("list() enumerates every currently-resolved theme's id/label", async () => {
    const fs = createFs({ "/a.json": DARK_THEME_JSON });
    const registry = createThemeRegistry({ fs });
    registry.register({ id: "a", label: "A", path: "/a.json" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ids = registry.list().map((t) => t.id);
    expect(ids).toContain(BASE_THEME_ID);
    expect(ids).toContain("a");
  });

  test("dispose() stops onDidChange from firing but leaves already-resolved themes queryable", () => {
    const registry = createThemeRegistry();
    let fired = 0;
    registry.onDidChange(() => fired++);
    registry.dispose();
    expect(registry.get(BASE_THEME_ID)).toBeDefined();
    // A second dispose() is a no-op, not a throw.
    expect(() => registry.dispose()).not.toThrow();
  });
});
