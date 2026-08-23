/**
 * Tests for {@link createThemeService} (Req 7.3, 7.5).
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedTheme } from "@tecode/api";
import { BASE_THEME_ID, createThemeRegistry, type ThemeRegistry } from "./themeRegistry";
import { createThemeService } from "./themeService";

function makeTheme(marker: string): ResolvedTheme {
  return {
    colors: { foreground: { r: marker.length, g: 0, b: 0 } } as ResolvedTheme["colors"],
    tokens: {},
  };
}

/** A minimal in-memory registry fake — faster and more direct than
 * `createThemeRegistry`'s async loading for tests that only need `get()`. */
function createFakeRegistry(themes: Record<string, ResolvedTheme>): Pick<ThemeRegistry, "get"> {
  return {
    get(id: string) {
      const theme = themes[id];
      return theme ? { id, label: id, theme } : undefined;
    },
  };
}

describe("createThemeService (Req 7.3, 7.5)", () => {
  test("starts on initialThemeId when the registry has it", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const service = createThemeService({ registry, initialThemeId: "dark" });
    expect(service.getActiveThemeId()).toBe("dark");
    expect(service.get()).toEqual(makeTheme("dark"));
  });

  test("falls back to BASE_THEME_ID when initialThemeId is unknown", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base") });
    const service = createThemeService({ registry, initialThemeId: "does-not-exist" });
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
  });

  test("previewTheme switches the active theme immediately and fires onDidChange", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.previewTheme("dark");
    expect(service.getActiveThemeId()).toBe("dark");
    expect(service.get()).toEqual(makeTheme("dark"));
    expect(changes).toBe(1);
  });

  test("previewTheme on an unknown id is a no-op", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.previewTheme("nope");
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(changes).toBe(0);
  });

  test("preview -> revert restores the pre-preview theme", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });

    service.previewTheme("dark");
    expect(service.getActiveThemeId()).toBe("dark");

    service.revertTheme();
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(service.get()).toEqual(makeTheme("base"));
  });

  test("multiple previews in a row only stash the ORIGINAL pre-preview theme", () => {
    const registry = createFakeRegistry({
      [BASE_THEME_ID]: makeTheme("base"),
      a: makeTheme("aa"),
      b: makeTheme("bbb"),
    });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });

    service.previewTheme("a");
    service.previewTheme("b");
    expect(service.getActiveThemeId()).toBe("b");

    service.revertTheme();
    // Reverts all the way back to base, not to "a".
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
  });

  test("revertTheme with nothing stashed is a no-op", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.revertTheme();
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(changes).toBe(0);
  });

  test("preview -> commit calls onCommit with the committed id and clears the stash", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const committed: string[] = [];
    const service = createThemeService({
      registry,
      initialThemeId: BASE_THEME_ID,
      onCommit: (id) => committed.push(id),
    });

    service.previewTheme("dark");
    service.commitTheme();
    expect(committed).toEqual(["dark"]);
    expect(service.getActiveThemeId()).toBe("dark");

    // The stash is gone — reverting after a commit does nothing.
    service.revertTheme();
    expect(service.getActiveThemeId()).toBe("dark");
  });

  test("a throwing onCommit does not break commitTheme's never-throwing contract", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const service = createThemeService({
      registry,
      initialThemeId: BASE_THEME_ID,
      onCommit: () => {
        throw new Error("boom");
      },
    });
    service.previewTheme("dark");
    expect(() => service.commitTheme()).not.toThrow();
  });

  test("setTheme switches directly, clears any stash, and does not call onCommit", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const committed: string[] = [];
    const service = createThemeService({
      registry,
      initialThemeId: BASE_THEME_ID,
      onCommit: (id) => committed.push(id),
    });

    service.previewTheme("dark"); // stashes "base"
    service.setTheme("dark"); // config-driven switch to the same id it's already previewing

    expect(committed).toEqual([]);
    // The stash was cleared by setTheme — reverting now does nothing.
    service.revertTheme();
    expect(service.getActiveThemeId()).toBe("dark");
  });

  test("setTheme on an unknown id is a no-op", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.setTheme("nope");
    expect(service.getActiveThemeId()).toBe(BASE_THEME_ID);
    expect(changes).toBe(0);
  });

  test("setTheme to the already-active theme does not fire a redundant onDidChange", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.setTheme(BASE_THEME_ID);
    expect(changes).toBe(0);
  });

  test("dispose() clears listeners and is idempotent", () => {
    const registry = createFakeRegistry({ [BASE_THEME_ID]: makeTheme("base"), dark: makeTheme("dark") });
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    let changes = 0;
    service.onDidChange(() => changes++);

    service.dispose();
    service.previewTheme("dark");
    expect(changes).toBe(0);
    expect(() => service.dispose()).not.toThrow();
  });

  test("works against a real ThemeRegistry once its themes have loaded", async () => {
    const registry = createThemeRegistry();
    const service = createThemeService({ registry, initialThemeId: BASE_THEME_ID });
    expect(service.get()).toEqual(registry.get(BASE_THEME_ID)!.theme);
  });
});
