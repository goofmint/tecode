/**
 * Visual rendering tests for Dark Modern (the one embedded built-in theme)
 * and a fixture user theme, Light Modern (Task 2.7, Req 7.3, 11.4, 13.4;
 * design.md §16; Issue #124): the Shell and a syntax-highlighted buffer,
 * rendered under both real themes through OpenTUI's headless test
 * renderer (`shell.snapshot.test.tsx`'s top-of-file TSDoc documents the
 * `testRender`/`captureCharFrame`/`captureSpans` API this follows — no
 * `toMatchSnapshot`, every assertion reads the real rendered cell grid/
 * spans).
 *
 * Lives in `packages/cli` (not `@tecode/core`) because it needs
 * `@tecode/builtin`'s real Dark Modern data plus the repository's
 * top-level `themes/light-modern.json`, and `core` may not import
 * `builtin` — same layering reason `themeSelectDefaultThemes.test.ts`
 * gives.
 *
 * **Only Dark Modern is embedded now** (Issue #124): loaded through the
 * exact production path (`createThemeRegistry` + `collectBuiltinPendingThemes`
 * + `createBuiltinThemeAssetsFs`'s embedded-asset overlay, `main.ts`'s own
 * sync-phase wiring). Light Modern is no longer a `themes-default`
 * contribution — this suite loads it exactly the way a real user theme
 * would be: a second `ThemeRegistry.loadContributions` call pointed at
 * the repository's own top-level `themes/` directory (the same file
 * README.md tells a user to copy to `~/.config/tecode/themes/`), through
 * `ThemeRegistry`'s ordinary real-`fs.readFile` path — no embedded asset
 * involved for it at all.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { CaptureName, ResolvedTheme } from "@tecode/api";
import {
  ContextFocusTracker,
  createCommandRegistry,
  createContextService,
  createHostLog,
  createLayoutStateService,
  createSlotRegistry,
  createThemeRegistry,
  resolveCaptureStyle,
  Shell,
  styleToTextColors,
  ThemeProvider,
  toColorInput,
  type LayoutStateFs,
} from "@tecode/core";
import { builtinManifests, builtinThemeAssets, DARK_MODERN_THEME_ID } from "@tecode/builtin";
import { collectBuiltinPendingThemes } from "./main";
import { createBuiltinThemeAssetsFs } from "./themeAssetsFs";

/** The fixture user theme's id, per `userThemes.ts`'s id-derivation rule
 * (the filename stem of `themes/light-modern.json`) — see
 * `themeSelectDefaultThemes.test.ts`'s identical fixture for the full
 * "why" (this module's own TSDoc). */
const LIGHT_MODERN_USER_THEME_ID = "light-modern";

/** Matches `editorView.snapshot.test.tsx`'s own `flatten` helper: one entry per
 * rendered text span, across every row of the captured frame. */
function flatten(frame: CapturedFrame): Array<{ row: number; text: string; fg: unknown; bg: unknown }> {
  const out: Array<{ row: number; text: string; fg: unknown; bg: unknown }> = [];
  frame.lines.forEach((line, row) => {
    for (const span of line.spans) {
      out.push({ row, text: span.text, fg: span.fg, bg: span.bg });
    }
  });
  return out;
}

/** An in-memory `LayoutStateFs` with no `state.json` on disk (matches
 * `shell.snapshot.test.tsx`'s `createEmptyLayoutFs`). */
function createEmptyLayoutFs(): LayoutStateFs {
  return {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
  };
}

function createRecordingSink() {
  return { error() {} };
}

function createShellHarness() {
  const log = createHostLog();
  const sink = createRecordingSink();
  const slotRegistry = createSlotRegistry({ log });
  const layoutState = createLayoutStateService({ log, sink, path: "/state.json", fs: createEmptyLayoutFs() });
  const context = createContextService();
  const commands = createCommandRegistry({ log, sink });
  return { slotRegistry, layoutState, context, commands };
}

/** Loads Dark Modern through the real production path, plus the fixture
 * Light Modern user theme through `ThemeRegistry`'s ordinary real-`fs`
 * path against the repository's top-level `themes/` directory (this
 * module's TSDoc), returning each theme's fully {@link ResolvedTheme} by
 * id. */
async function loadThemes(): Promise<Record<string, ResolvedTheme>> {
  const themeRegistry = createThemeRegistry({ fs: createBuiltinThemeAssetsFs(builtinThemeAssets) });
  const { pending, extensionDirs } = collectBuiltinPendingThemes(builtinManifests);
  await themeRegistry.loadContributions(pending, extensionDirs);

  await themeRegistry.loadContributions(
    [
      {
        extensionId: "fixture.user-themes",
        theme: { id: LIGHT_MODERN_USER_THEME_ID, label: "Light Modern", path: "light-modern.json" },
      },
    ],
    { "fixture.user-themes": `${import.meta.dir}/../../../themes` },
  );

  return {
    [DARK_MODERN_THEME_ID]: themeRegistry.get(DARK_MODERN_THEME_ID)!.theme,
    [LIGHT_MODERN_USER_THEME_ID]: themeRegistry.get(LIGHT_MODERN_USER_THEME_ID)!.theme,
  };
}

const THEME_IDS = [DARK_MODERN_THEME_ID, LIGHT_MODERN_USER_THEME_ID];

describe("Shell renders under Dark Modern and a fixture user theme (Req 7.3, 11.4, design.md §16, Issue #124)", () => {
  for (const themeId of THEME_IDS) {
    test(`${themeId}: the StatusBar/SideBar/EditorArea regions paint this theme's own resolved colors`, async () => {
      const theme = (await loadThemes())[themeId]!;
      const { slotRegistry, layoutState, context } = createShellHarness();
      await layoutState.ready;

      const { renderOnce, captureCharFrame, captureSpans } = await testRender(
        <ThemeProvider theme={theme}>
          <ContextFocusTracker context={context}>
            <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
          </ContextFocusTracker>
        </ThemeProvider>,
        { width: 60, height: 20 },
      );
      await act(async () => {
        await renderOnce();
      });

      // A real, fully laid-out frame (same sanity check `shell.snapshot.test.tsx`'s
      // own empty-shell test makes).
      const frame = captureCharFrame();
      expect(frame).toContain("No editor open.");
      expect(frame.split("\n").length).toBeGreaterThanOrEqual(20);

      // This theme's OWN statusBar.background is actually painted
      // somewhere in the tree — proves `ThemeProvider`'s value really is
      // this resolved theme, not a stale/default one.
      const spans = flatten(captureSpans());
      const statusBarBg = toColorInput(theme.colors["statusBar.background"]);
      expect(spans.some((s) => JSON.stringify(s.bg) === JSON.stringify(statusBarBg))).toBe(true);
    });
  }

  test("Dark Modern and the fixture user theme paint visibly different statusBar.background for the same Shell tree", async () => {
    const themes = await loadThemes();
    const bgFor = async (theme: ResolvedTheme) => {
      const { slotRegistry, layoutState, context } = createShellHarness();
      await layoutState.ready;
      const { renderOnce, captureSpans } = await testRender(
        <ThemeProvider theme={theme}>
          <ContextFocusTracker context={context}>
            <Shell slotRegistry={slotRegistry} layoutState={layoutState} />
          </ContextFocusTracker>
        </ThemeProvider>,
        { width: 60, height: 20 },
      );
      await act(async () => {
        await renderOnce();
      });
      return flatten(captureSpans())
        .map((s) => JSON.stringify(s.bg))
        .filter((bg) => bg === JSON.stringify(toColorInput(theme.colors["statusBar.background"])));
    };

    const darkHits = await bgFor(themes[DARK_MODERN_THEME_ID]!);
    const lightHits = await bgFor(themes[LIGHT_MODERN_USER_THEME_ID]!);
    expect(darkHits.length).toBeGreaterThan(0);
    expect(lightHits.length).toBeGreaterThan(0);
    expect(darkHits[0]).not.toBe(
      JSON.stringify(toColorInput(themes[LIGHT_MODERN_USER_THEME_ID]!.colors["statusBar.background"])),
    );
  });
});

/** Every {@link BaseCaptureName} this MVP styles (Req 8.1, `@tecode/api`'s
 * `theme.ts`) — used below as a stand-in "highlighted buffer": one
 * `<text>` span per capture, styled exactly the way a real tree-sitter-
 * highlighted `EditorView` line would style it (`resolveCaptureStyle` +
 * `styleToTextColors`, `theme.tsx`'s own documented pairing) — the actual
 * per-token rendering pipeline (Task 2.8) has not landed yet, so this
 * proves the THEME half of that pipeline (every capture resolves to this
 * theme's own distinct style) rather than re-testing tree-sitter parsing.
 */
const BASE_CAPTURES: CaptureName[] = [
  "keyword",
  "string",
  "comment",
  "function",
  "type",
  "variable",
  "number",
  "operator",
  "punctuation",
];

function HighlightedBuffer({ theme }: { theme: ResolvedTheme }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {BASE_CAPTURES.map((name) => {
        const { fg, bg } = styleToTextColors(resolveCaptureStyle(theme.tokens, name));
        return (
          <text key={name} fg={fg} bg={bg}>
            {name}
          </text>
        );
      })}
    </box>
  );
}

describe("A highlighted buffer resolves every base capture through both themes (Req 8.1, 11.4, Issue #124)", () => {
  for (const themeId of THEME_IDS) {
    test(`${themeId}: every base capture name renders with this theme's own tokenColors foreground`, async () => {
      const theme = (await loadThemes())[themeId]!;

      const { renderOnce, captureSpans } = await testRender(<HighlightedBuffer theme={theme} />, {
        width: 40,
        height: BASE_CAPTURES.length + 2,
      });
      await act(async () => {
        await renderOnce();
      });

      const spans = flatten(captureSpans());
      for (const name of BASE_CAPTURES) {
        const style = resolveCaptureStyle(theme.tokens, name);
        expect(style, `theme ${themeId} has no style for capture "${name}"`).toBeDefined();
        const expectedFg = JSON.stringify(toColorInput(style!.foreground!));

        const matches = spans.filter((s) => s.text === name);
        expect(matches.length, `no rendered span for capture "${name}"`).toBeGreaterThan(0);
        for (const span of matches) {
          expect(JSON.stringify(span.fg)).toBe(expectedFg);
        }
      }
    });
  }

  test("keyword/string/comment render with visibly different foregrounds between Dark Modern and the fixture user theme", async () => {
    const themes = await loadThemes();
    for (const name of ["keyword", "string", "comment"] as CaptureName[]) {
      const darkFg = resolveCaptureStyle(themes[DARK_MODERN_THEME_ID]!.tokens, name)!.foreground;
      const lightFg = resolveCaptureStyle(themes[LIGHT_MODERN_USER_THEME_ID]!.tokens, name)!.foreground;
      expect(darkFg).toBeDefined();
      expect(lightFg).toBeDefined();
      expect(darkFg).not.toEqual(lightFg);
    }
  });
});
