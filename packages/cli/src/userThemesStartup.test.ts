/**
 * End-to-end startup coverage for user themes (Req 11.4, Issue #124):
 * proves `runDeferredPhase`'s `scanUserThemes` + `themeRegistry.
 * loadContributions` + `applyConfiguredTheme` re-apply wiring
 * (`main.ts`'s own TSDoc on that block) genuinely lands a
 * `~/.config/tecode/themes/*.json` file in `ThemeRegistry.list()` and, when
 * `workbench.colorTheme` names it, makes it the ACTIVE theme with its own
 * real resolved colors — not just registered-but-inert. Also proves the
 * `themeLoader.ts` degrade contract (design.md §9) still holds end to end
 * when the user themes directory is missing or contains a broken file:
 * startup never throws, and Dark Modern (the embedded default) stays
 * active unless a working theme is explicitly configured.
 *
 * Uses `buildAssemblyRoot`'s `configDir` (Req 9.6) to control
 * `workbench.colorTheme` deterministically, and `runDeferredPhase`'s
 * `userThemesDir` seam (added by this same task) to point `scanUserThemes`
 * at a temp fixture directory — NOT a `HOME`/`APPDATA` override, which
 * `main.test.ts`'s `createHermeticDiscoveryFs` TSDoc documents as
 * unreliable in-process on POSIX (Bun's `os.homedir()` ignores a runtime
 * `process.env.HOME` mutation).
 */

import { expect, test } from "bun:test";
import { mkdtemp, readdir as nodeReaddir, rm, stat as nodeStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfiguredTheme,
  BASE_THEME_ID,
  createBaseTheme,
  DEFAULT_COLOR_THEME_ID,
  getUserExtensionsDir,
  type DiscoveryFs,
} from "@tecode/core";
import { DARK_MODERN_THEME_ID } from "@tecode/builtin";
import { buildAssemblyRoot, runDeferredPhase } from "./main";

/** Blocks the real user extensions dir — matches `main.test.ts`'s own
 * `createHermeticDiscoveryFs` (duplicated locally per this codebase's
 * existing per-file convention for this exact helper). */
function createHermeticDiscoveryFs(): DiscoveryFs {
  const blockedUserDir = getUserExtensionsDir();
  return {
    async readdir(path) {
      if (path === blockedUserDir) {
        throw Object.assign(new Error("ENOENT (blocked for test hermeticity)"), { code: "ENOENT" });
      }
      return nodeReaddir(path);
    },
    async stat(path) {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

test("a user theme file is listed, selectable via workbench.colorTheme, and applies its own real colors", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-cfg-"));
  const userThemesDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-dir-"));

  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({ "workbench.colorTheme": "my-purple" }),
    "utf8",
  );
  await writeFile(
    join(userThemesDir, "my-purple.json"),
    JSON.stringify({
      name: "My Purple",
      colors: { "editor.background": "#330066", "statusBar.background": "#220044" },
    }),
    "utf8",
  );

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir, { configDir });
    await root.config.ready;
    await root.themesReadyPromise;
    applyConfiguredTheme(root.config, root.themeService);

    // Before the deferred phase: the user theme has not been scanned yet,
    // so `workbench.colorTheme`'s configured "my-purple" cannot resolve —
    // `applyConfiguredTheme`'s own documented unknown-id no-op leaves
    // `themeService` on its `BASE_THEME_ID` starting point (NOT Dark
    // Modern — this fixture's `settings.json` names "my-purple", not the
    // default, so nothing here ever asks for Dark Modern at all).
    expect(root.themeService.getActiveThemeId()).toBe(BASE_THEME_ID);

    const { extensionHost } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
      userThemesDir,
    });

    // Now listed...
    const listed = root.themeRegistry.list();
    expect(listed.some((t) => t.id === "my-purple" && t.label === "My Purple")).toBe(true);

    // ...and genuinely ACTIVE, with its own real resolved colors — not
    // just present in the list while Dark Modern stays active underneath.
    expect(root.themeService.getActiveThemeId()).toBe("my-purple");
    expect(root.themeService.get().colors["editor.background"]).toEqual({ r: 0x33, g: 0x00, b: 0x66 });
    expect(root.themeService.get().colors["statusBar.background"]).toEqual({ r: 0x22, g: 0x00, b: 0x44 });

    await extensionHost.disposeAll();
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    root!.openFileCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(userThemesDir, { recursive: true, force: true });
  }
}, 15_000);

test("a missing user themes directory boots fine and stays on the default Dark Modern theme (degrade contract, design.md §9)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-ws-"));
  const userThemesDir = join(workspaceDir, "no-such-themes-dir");

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir);
    await root.config.ready;
    await root.themesReadyPromise;
    applyConfiguredTheme(root.config, root.themeService);
    expect(root.config.get<string>("workbench.colorTheme")).toBe(DEFAULT_COLOR_THEME_ID);

    const { extensionHost } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
      userThemesDir,
    });

    expect(root.themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);
    await extensionHost.disposeAll();
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    root!.openFileCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}, 15_000);

test("a broken (unparseable) user theme file does not crash startup — it registers, degrades to the base palette when selected, and Dark Modern stays the default otherwise (design.md §9's whole-file degrade)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-ws-"));
  const userThemesDir = await mkdtemp(join(tmpdir(), "tecode-user-themes-broken-"));
  await writeFile(join(userThemesDir, "broken.json"), "{ this is not valid json", "utf8");

  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(workspaceDir);
    await root.config.ready;
    await root.themesReadyPromise;
    applyConfiguredTheme(root.config, root.themeService);

    const { extensionHost } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
      userThemesDir,
    });

    // No configured theme names "broken", so it stays inert — Dark Modern
    // (the default) is still active, proving one broken user theme file
    // cannot knock startup off its default.
    expect(root.themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);

    // It DID register (the scanner does not skip a merely-unparseable
    // file, only an unreadable one — `userThemes.ts`'s TSDoc) — and,
    // queried directly, resolves to the whole base palette exactly like
    // any other theme whose JSON fails to parse at all
    // (`themeLoader.ts`'s `loadThemeFromJsonText` TSDoc: "a theme that
    // doesn't parse at all falls back to the WHOLE base palette").
    const entry = root.themeRegistry.get("broken");
    expect(entry).toBeDefined();
    expect(entry?.theme.colors).toEqual(createBaseTheme().colors);

    await extensionHost.disposeAll();
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    root!.openFileCommand.dispose();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(userThemesDir, { recursive: true, force: true });
  }
}, 15_000);
