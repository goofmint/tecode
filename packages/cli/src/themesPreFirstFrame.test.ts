/**
 * Pre-first-frame spy test (Task 2.7, Req 11.4, 12.1, 12.2; design.md §3):
 * proves the configured Dark Modern theme is genuinely active at the exact
 * moment `runTecode` would call `renderShell` — with ZERO extension
 * modules loaded (no `ExtensionHost` even built yet) — and that loading
 * only happens once {@link runDeferredPhase} runs.
 *
 * Follows `main.test.ts`'s own harness pattern (`buildAssemblyRoot` + a
 * temp `HOME`/workspace dir + a hermetic discovery `fs`) rather than
 * driving the real `runTecode` (which opens a real render seam and wires
 * real `SIGINT`/`SIGTERM` handlers) — this test instead reproduces
 * `runTecode`'s own documented sync-phase sequence step by step
 * (`config.ready` -> `themesReadyPromise` -> `applyConfiguredTheme`,
 * `main.ts`'s TSDoc), so the "before renderShell" moment is inspected
 * directly rather than through a render-callback spy.
 */

import { expect, test } from "bun:test";
import { mkdtemp, readdir as nodeReaddir, rm, stat as nodeStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfiguredTheme,
  DEFAULT_COLOR_THEME_ID,
  getUserExtensionsDir,
  type DiscoveryFs,
} from "@tecode/core";
import { DARK_MODERN_THEME_ID, LIGHT_MODERN_THEME_ID } from "@tecode/builtin";
import { buildAssemblyRoot, runDeferredPhase } from "./main";

/** Blocks the real user extensions dir, matches `main.test.ts`'s own
 * `createHermeticDiscoveryFs` — keeps this test from ever scanning the
 * real machine's `~/.config/tecode/extensions`. */
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

test("Dark Modern is active before renderShell would be called, with zero extension modules loaded — loading only starts in runDeferredPhase", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-themes-prefirstframe-"));
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  const savedColorTerm = process.env["COLORTERM"];
  const savedTerm = process.env["TERM"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  // Force truecolor detection (matches `main.test.ts`'s own color-depth
  // test) so the resolved RGB values asserted below are deterministic —
  // otherwise `detectTerminalCapabilities()` may quantize every color to
  // the nearest xterm-256 entry depending on the ambient test environment.
  process.env["COLORTERM"] = "truecolor";
  process.env["TERM"] = "xterm-256color";
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
    if (savedColorTerm === undefined) delete process.env["COLORTERM"];
    else process.env["COLORTERM"] = savedColorTerm;
    if (savedTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = savedTerm;
  }

  try {
    // `runTecode`'s exact sync-phase ordering (`main.ts`'s TSDoc): config
    // ready, then the built-in themes' pre-load, then apply the
    // configured theme — all strictly BEFORE renderShell is ever called.
    await root.config.ready;
    expect(root.config.get<string>("workbench.colorTheme")).toBe(DEFAULT_COLOR_THEME_ID);
    expect(DEFAULT_COLOR_THEME_ID).toBe(DARK_MODERN_THEME_ID);

    await root.themesReadyPromise;
    applyConfiguredTheme(root.config, root.themeService);

    // --- The "at render time" moment: this is exactly what
    // `renderShell({ theme: root.theme, themeService: root.themeService,
    // ... })` would see if called right now. ---

    expect(root.themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);
    const activeColors = root.themeService.get().colors;
    // Dark Modern's own values (`themes-default/themes/dark-modern.json`),
    // not the built-in base palette's — proves the REAL embedded theme
    // loaded, not just a registry that still reports BASE_THEME_ID's
    // colors under a different active id.
    expect(activeColors["editor.background"]).toEqual({ r: 31, g: 31, b: 31 });
    expect(activeColors["statusBar.background"]).toEqual({ r: 0, g: 120, b: 212 });

    // Zero extension modules loaded: the extension host does not exist
    // yet at all (it is only built inside runDeferredPhase, below) —
    // `loadModule()` for ANY extension (built-in or not) can only ever be
    // invoked through it (`host/activation.ts`'s TSDoc: "loadModule()
    // performs a real dynamic import()... injected via
    // ExtensionRecord.loadModule").
    expect(root.hostRef.current).toBeUndefined();

    // --- Now run the deferred phase (design.md §3's step 2) and prove
    // loading/activation only happens from here on. ---
    const { extensionHost, loadResult } = await runDeferredPhase(root, {
      fs: createHermeticDiscoveryFs(),
    });

    expect(root.hostRef.current).toBe(extensionHost);
    const loadedIds = loadResult.loaded.map((e) => e.extensionId).sort();
    expect(loadedIds).toEqual(["tecode.editor-core", "tecode.languages-basic", "tecode.themes-default"]);
    // The theme is still Dark Modern after the deferred phase re-applies
    // the configured theme (`runDeferredPhase`'s own `applyConfiguredTheme`
    // retry) — a safe no-op here since it was already correct.
    expect(root.themeService.getActiveThemeId()).toBe(DARK_MODERN_THEME_ID);

    // `runDeferredPhase` re-registers the SAME two built-in theme ids via
    // `loadContributions` (discovery found them again, this time with a
    // real `LoadedExtension`) — `themeRegistry.ts`'s per-id generation
    // guard means this is a harmless re-registration, not a duplicate
    // `list()` entry.
    const themeListIds = root.themeRegistry.list().map((t) => t.id);
    expect(themeListIds.filter((id) => id === DARK_MODERN_THEME_ID)).toHaveLength(1);
    expect(themeListIds.filter((id) => id === LIGHT_MODERN_THEME_ID)).toHaveLength(1);

    await extensionHost.disposeAll();
  } finally {
    root!.config.dispose();
    root!.chordMachine.dispose();
    root!.editorSession.dispose();
    root!.editorLangIdSync.dispose();
    root!.themeConfigSync.dispose();
    root!.themeSelectCommand.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
