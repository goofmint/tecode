/**
 * Completeness tests for `themes-default`'s two theme JSON files (Req
 * 11.4, Task 2.7; design.md §3, §13): every {@link UiColorKey} and every
 * {@link BaseCaptureName} must be defined directly in BOTH
 * `themes/dark-modern.json` and `themes/light-modern.json` — this
 * extension may not rely on `@tecode/core`'s `ThemeLoader` base-palette
 * per-key fallback for any key (that fallback exists for THIRD-PARTY
 * partial themes, design.md §9; the two built-in themes this MVP ships as
 * "equivalent to VS Code's Dark Modern and Light Modern" are the one place
 * that fallback should never actually be exercised).
 *
 * **Compile-time exhaustiveness**: {@link UI_COLOR_KEYS}/
 * {@link BASE_CAPTURE_NAMES} are typed as `Record<UiColorKey, true>`/
 * `Record<BaseCaptureName, true>` — adding a new key to either union in
 * `@tecode/api`'s `theme.ts` without updating this file fails `bunx tsc
 * --noEmit` (a missing property on a `Record<K, V>` literal), not just
 * this test at runtime. Only TYPES are imported from `@tecode/api` (the
 * ESLint layering rule this package respects — `builtin` may import
 * `@tecode/api` only, never `@tecode/core`), so hex-color/`fontStyle`
 * validation below is a small local reimplementation rather than a call
 * into `@tecode/core`'s `themeLoader.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { BaseCaptureName, Manifest, UiColorKey } from "@tecode/api";
import darkModern from "./themes/dark-modern.json";
import lightModern from "./themes/light-modern.json";
import manifestDefault, { DARK_MODERN_THEME_ID, LIGHT_MODERN_THEME_ID } from "./manifest";

// `manifest.ts`'s `export default {...} satisfies Manifest` keeps the
// export's LITERAL type (only the fields actually present), so widen it
// back to the full `Manifest` interface here — this test asserts several
// `contributes.*` fields are `undefined`, which a literal type with no
// such property at all would reject at compile time even though the real
// `Manifest`/`Contributes` interfaces declare every one of them optional.
const manifest: Manifest = manifestDefault;

/** Every {@link UiColorKey}, as a compile-time-exhaustive map (this
 * module's TSDoc) — duplicated from `@tecode/api`'s `theme.ts` union by
 * necessity (a `Record` literal is the only way to get TypeScript to
 * enforce "every union member has an entry" without a runtime schema
 * library). */
const UI_COLOR_KEYS: Record<UiColorKey, true> = {
  focusBorder: true,
  foreground: true,
  "editor.background": true,
  "editor.foreground": true,
  "editor.lineHighlightBackground": true,
  "editor.selectionBackground": true,
  "editor.selectionForeground": true,
  "editor.inactiveSelectionBackground": true,
  "editor.findMatchBackground": true,
  "editor.findMatchHighlightBackground": true,
  "editorLineNumber.foreground": true,
  "editorLineNumber.activeForeground": true,
  "editorCursor.foreground": true,
  "editorIndentGuide.background": true,
  "editorIndentGuide.activeBackground": true,
  "editorWhitespace.foreground": true,
  "activityBar.background": true,
  "activityBar.foreground": true,
  "activityBar.inactiveForeground": true,
  "activityBar.border": true,
  "activityBarBadge.background": true,
  "activityBarBadge.foreground": true,
  "sideBar.background": true,
  "sideBar.foreground": true,
  "sideBar.border": true,
  "sideBarTitle.foreground": true,
  "sideBarSectionHeader.background": true,
  "statusBar.background": true,
  "statusBar.foreground": true,
  "statusBar.border": true,
  "statusBar.debuggingBackground": true,
  "statusBarItem.hoverBackground": true,
  "tab.activeBackground": true,
  "tab.activeForeground": true,
  "tab.inactiveBackground": true,
  "tab.inactiveForeground": true,
  "tab.border": true,
  "tab.activeBorder": true,
  "panel.background": true,
  "panel.border": true,
  "panelTitle.activeForeground": true,
  "panelTitle.inactiveForeground": true,
  "input.background": true,
  "input.foreground": true,
  "input.border": true,
  "input.placeholderForeground": true,
  "list.activeSelectionBackground": true,
  "list.activeSelectionForeground": true,
  "list.inactiveSelectionBackground": true,
  "list.hoverBackground": true,
  "list.focusBackground": true,
  "scrollbarSlider.background": true,
  "scrollbarSlider.hoverBackground": true,
  "badge.background": true,
  "badge.foreground": true,
  "button.background": true,
  "button.foreground": true,
};

/** Every {@link BaseCaptureName} (this module's TSDoc). */
const BASE_CAPTURE_NAMES: Record<BaseCaptureName, true> = {
  keyword: true,
  string: true,
  comment: true,
  function: true,
  type: true,
  variable: true,
  number: true,
  operator: true,
  punctuation: true,
};

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_STYLE_WORDS = new Set(["bold", "italic", "underline"]);

interface RawThemeJson {
  colors?: Record<string, unknown>;
  tokenColors?: Record<string, { foreground?: unknown; background?: unknown; fontStyle?: unknown }>;
}

const THEMES: Array<{ label: string; json: RawThemeJson }> = [
  { label: "Dark Modern", json: darkModern as RawThemeJson },
  { label: "Light Modern", json: lightModern as RawThemeJson },
];

describe("themes-default JSON completeness (Req 11.4)", () => {
  for (const { label, json } of THEMES) {
    describe(label, () => {
      test("defines every UiColorKey with a valid #rrggbb(aa)/#rgb hex color", () => {
        for (const key of Object.keys(UI_COLOR_KEYS) as UiColorKey[]) {
          const value = json.colors?.[key];
          expect(value, `missing colors["${key}"]`).toBeString();
          expect(HEX_COLOR_RE.test(value as string), `invalid hex for colors["${key}"]: ${String(value)}`).toBe(
            true,
          );
        }
      });

      test("declares no colors outside the known UiColorKey set (no silent typos)", () => {
        for (const key of Object.keys(json.colors ?? {})) {
          expect(Object.prototype.hasOwnProperty.call(UI_COLOR_KEYS, key), `unknown UiColorKey "${key}"`).toBe(
            true,
          );
        }
      });

      test("defines every BaseCaptureName with a valid style shape", () => {
        for (const capture of Object.keys(BASE_CAPTURE_NAMES) as BaseCaptureName[]) {
          const style = json.tokenColors?.[capture];
          expect(style, `missing tokenColors["${capture}"]`).toBeDefined();
          expect(typeof style, `tokenColors["${capture}"] must be an object`).toBe("object");

          expect(style?.foreground, `missing tokenColors["${capture}"].foreground`).toBeString();
          expect(
            HEX_COLOR_RE.test(style?.foreground as string),
            `invalid hex for tokenColors["${capture}"].foreground: ${String(style?.foreground)}`,
          ).toBe(true);

          if (style?.background !== undefined) {
            expect(typeof style.background).toBe("string");
            expect(HEX_COLOR_RE.test(style.background as string)).toBe(true);
          }

          if (style?.fontStyle !== undefined) {
            expect(typeof style.fontStyle).toBe("string");
            const words = (style.fontStyle as string).split(/\s+/).filter(Boolean);
            for (const word of words) {
              expect(FONT_STYLE_WORDS.has(word), `unknown fontStyle word "${word}"`).toBe(true);
            }
          }
        }
      });
    });
  }

  test("Dark Modern and Light Modern resolve visibly different colors (not a copy-paste palette)", () => {
    expect(darkModern.colors["editor.background"]).not.toBe(lightModern.colors["editor.background"]);
    expect(darkModern.colors["editor.foreground"]).not.toBe(lightModern.colors["editor.foreground"]);
  });
});

describe("themes-default manifest (Req 11.4)", () => {
  test("is a pure-contribution manifest: no activationEvents, contributes only its two themes", () => {
    expect(manifest.activationEvents).toEqual([]);
    expect(manifest.contributes.commands).toBeUndefined();
    expect(manifest.contributes.keybindings).toBeUndefined();
    expect(manifest.contributes.views).toBeUndefined();
    expect(manifest.contributes.configuration).toBeUndefined();
  });

  test("declares Dark Modern and Light Modern, pointing at this package's theme JSON files", () => {
    expect(manifest.contributes.themes).toEqual([
      { id: DARK_MODERN_THEME_ID, label: "Dark Modern", path: "themes/dark-modern.json" },
      { id: LIGHT_MODERN_THEME_ID, label: "Light Modern", path: "themes/light-modern.json" },
    ]);
  });
});
