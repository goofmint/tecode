/**
 * Tests for {@link loadThemeFromJsonText}/{@link resolveCaptureStyle}/
 * {@link parseHexColor} (Req 7.1, 7.2, design.md §9).
 */

import { describe, expect, test } from "bun:test";
import { createBaseTheme } from "../api/stubs";
import { loadThemeFromJsonText, parseHexColor, resolveCaptureStyle } from "./themeLoader";

describe("parseHexColor", () => {
  test("parses #rrggbb", () => {
    expect(parseHexColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30 });
  });

  test("parses #rgb shorthand", () => {
    expect(parseHexColor("#0f0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  test("parses #rrggbbaa and drops the alpha channel", () => {
    expect(parseHexColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0 });
  });

  test("returns undefined for garbage", () => {
    expect(parseHexColor("not-a-color")).toBeUndefined();
    expect(parseHexColor("#12")).toBeUndefined();
  });
});

describe("loadThemeFromJsonText (Req 7.1, 7.2)", () => {
  test("a full theme's declared colors/tokens are used as-is", () => {
    const theme = loadThemeFromJsonText(
      JSON.stringify({
        colors: { "editor.background": "#000000", "editor.foreground": "#ffffff" },
        tokenColors: { keyword: { foreground: "#ff0000", fontStyle: "bold" } },
      }),
    );
    expect(theme.colors["editor.background"]).toEqual({ r: 0, g: 0, b: 0 });
    expect(theme.colors["editor.foreground"]).toEqual({ r: 255, g: 255, b: 255 });
    expect(theme.tokens["keyword"]).toEqual({ foreground: { r: 255, g: 0, b: 0 }, bold: true });
  });

  test("non-string tokenColors fields are ignored rather than throwing (regression)", () => {
    const theme = loadThemeFromJsonText(
      JSON.stringify({
        tokenColors: {
          // foreground/fontStyle as numbers must not reach parseHexColor's
          // .trim()/parseFontStyle's .split() — both would throw.
          keyword: { foreground: 123, fontStyle: 456, background: "#00ff00" },
        },
      }),
    );
    expect(theme.tokens["keyword"]).toEqual({ background: { r: 0, g: 255, b: 0 } });
  });

  test("a non-object tokenColors style entry is skipped rather than throwing (regression)", () => {
    const theme = loadThemeFromJsonText(
      JSON.stringify({ tokenColors: { keyword: 123, string: ["#ff0000"], comment: { foreground: "#ff0000" } } }),
    );
    expect(theme.tokens["keyword"]).toBeUndefined();
    expect(theme.tokens["string"]).toBeUndefined();
    expect(theme.tokens["comment"]).toEqual({ foreground: { r: 255, g: 0, b: 0 } });
  });

  test("a partial theme falls back per-key to the base palette (Req 7.2)", () => {
    const base = createBaseTheme();
    const theme = loadThemeFromJsonText(JSON.stringify({ colors: { "editor.background": "#010203" } }));
    expect(theme.colors["editor.background"]).toEqual({ r: 1, g: 2, b: 3 });
    // Every other key keeps the base palette's value untouched.
    expect(theme.colors["editor.foreground"]).toEqual(base.colors["editor.foreground"]);
    expect(theme.colors["statusBar.background"]).toEqual(base.colors["statusBar.background"]);
  });

  test("an unparseable color value falls back to the base palette for that key only", () => {
    const base = createBaseTheme();
    const messages: string[] = [];
    const theme = loadThemeFromJsonText(
      JSON.stringify({ colors: { "editor.background": "not-a-color" } }),
      { sink: { error: (e) => messages.push(e.message) } },
    );
    expect(theme.colors["editor.background"]).toEqual(base.colors["editor.background"]);
    expect(messages).toHaveLength(1);
  });

  test("an unrecognized color key is ignored, not an error", () => {
    const theme = loadThemeFromJsonText(JSON.stringify({ colors: { "totally.madeUp": "#123456" } }));
    expect(theme).toEqual(createBaseTheme());
  });

  test("a JSON parse failure falls back to the whole base palette and reports through the sink", () => {
    const messages: string[] = [];
    const theme = loadThemeFromJsonText("{ not json", {
      path: "/themes/broken.json",
      sink: { error: (e) => messages.push(e.message) },
    });
    expect(theme).toEqual(createBaseTheme());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("/themes/broken.json");
  });

  test("a non-object top level falls back to the base palette", () => {
    const theme = loadThemeFromJsonText("[1, 2, 3]");
    expect(theme).toEqual(createBaseTheme());
  });

  test("an empty object resolves to exactly the base palette with no tokens", () => {
    const theme = loadThemeFromJsonText("{}");
    expect(theme).toEqual(createBaseTheme());
  });
});

describe("resolveCaptureStyle (longest-prefix fallback, Req 7.2, design.md §9)", () => {
  test("returns the exact match when present", () => {
    const tokens = { "function.builtin": { bold: true }, function: { italic: true } };
    expect(resolveCaptureStyle(tokens, "function.builtin")).toEqual({ bold: true });
  });

  test("falls back to the base capture when a dotted refinement is undefined", () => {
    const tokens = { function: { italic: true } };
    expect(resolveCaptureStyle(tokens, "function.builtin")).toEqual({ italic: true });
  });

  test("walks multiple dotted segments before falling back", () => {
    const tokens = { string: { foreground: { r: 1, g: 2, b: 3 } } };
    expect(resolveCaptureStyle(tokens, "string.escape.special")).toEqual({
      foreground: { r: 1, g: 2, b: 3 },
    });
  });

  test("returns undefined when no prefix matches anything", () => {
    const tokens = { keyword: { bold: true } };
    expect(resolveCaptureStyle(tokens, "function.builtin")).toBeUndefined();
  });
});
