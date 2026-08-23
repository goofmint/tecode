/**
 * Theme JSON loading (Req 7.1, 7.2; design.md §9): parses one theme's
 * VS-Code-color-theme-subset JSON text into a fully resolved
 * {@link ResolvedTheme} — every {@link UiColorKey} filled in (from the
 * file, falling back per-key to {@link createBaseTheme}'s base palette so a
 * partial theme degrades gracefully) and every declared syntax capture
 * mapped into `tokens`.
 *
 * **JSON shape** (a deliberately small subset — design.md §18 leaves a
 * fuller VS Code/TextMate mapping out of scope for the MVP):
 *
 * ```jsonc
 * {
 *   // UiColorKey -> "#rrggbb" (or "#rgb"; an optional trailing alpha pair,
 *   // "#rrggbbaa", is accepted and simply dropped — ResolvedTheme's RGB
 *   // has no alpha channel, theme.ts's TSDoc).
 *   "colors": { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" },
 *   // CaptureName -> a style — flat, unlike VS Code's array-of-scope-
 *   // objects `tokenColors`, because tecode themes key directly by
 *   // tree-sitter capture name rather than a TextMate scope (Req 7.2's
 *   // decision #3; design.md §18).
 *   "tokenColors": {
 *     "keyword": { "foreground": "#c586c0", "fontStyle": "bold" },
 *     "string": { "foreground": "#ce9178" }
 *   }
 * }
 * ```
 *
 * **Never throws, never hard-fails**: a theme file that fails to parse (or
 * whose top-level shape is wrong) reports through the injected
 * {@link StatusSink}/{@link HostLog} and this module hands back
 * {@link createBaseTheme}'s palette outright (design.md §14's "Theme JSON
 * missing keys -> fall back to base palette per key" extended to "a theme
 * that doesn't parse at all falls back to the WHOLE base palette" — the
 * same policy, just every key missing at once). A theme that parses but
 * omits some keys/captures gets exactly those keys filled from the base
 * palette, and everything it *does* declare kept.
 */

import type { CaptureName, ResolvedTheme, RGB, Style, UiColorKey } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { createBaseTheme } from "../api/stubs";
import { parseJsonc } from "../config/jsonc";

/** One capture's style, as it appears in a theme JSON's `tokenColors`
 * (this module's TSDoc). All fields optional — a style with neither
 * `foreground` nor `background` set (just `fontStyle`) is valid. */
export interface ThemeTokenStyleJson {
  foreground?: string;
  background?: string;
  /** Space-separated combination of `"bold"`, `"italic"`, `"underline"`
   * (VS Code's own `fontStyle` convention) — any other word is ignored. */
  fontStyle?: string;
}

/** The theme JSON shape this loader accepts (this module's TSDoc). Both
 * top-level keys are optional — an empty `{}` is a valid (if useless)
 * theme file that resolves to the base palette with no token styles. */
export interface ThemeJson {
  colors?: Partial<Record<string, string>>;
  tokenColors?: Partial<Record<string, ThemeTokenStyleJson>>;
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Parse a `"#rgb"`/`"#rrggbb"`/`"#rrggbbaa"` hex color string into an
 * {@link RGB} (alpha, if present, is dropped — see this module's TSDoc).
 * Returns `undefined` for anything else, rather than throwing — a bad
 * color value is one key's problem, not the whole theme's (this module's
 * per-key-fallback policy). */
export function parseHexColor(value: string): RGB | undefined {
  const match = HEX_COLOR_RE.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1]!;
  if (hex.length === 3) {
    const r = parseInt(hex[0]! + hex[0], 16);
    const g = parseInt(hex[1]! + hex[1], 16);
    const b = parseInt(hex[2]! + hex[2], 16);
    return { r, g, b };
  }
  // 6 or 8 hex digits: the first 6 are always r/g/b; an 8th pair (alpha)
  // is simply not read.
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

const FONT_STYLE_WORDS = new Set(["bold", "italic", "underline"]);

/** Parse a `fontStyle` string (`"bold italic"`) into `Style`'s boolean
 * flags. Unknown words are ignored rather than rejected — matches this
 * module's "one bad piece never fails the whole theme" policy. */
function parseFontStyle(fontStyle: string | undefined): Pick<Style, "bold" | "italic" | "underline"> {
  const words = new Set((fontStyle ?? "").split(/\s+/).filter((w) => FONT_STYLE_WORDS.has(w)));
  return {
    bold: words.has("bold") || undefined,
    italic: words.has("italic") || undefined,
    underline: words.has("underline") || undefined,
  };
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `config/jsonc.ts`'s/`config/service.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` (matches every other module's `logSafely`). */
function logSafely(log: HostLog | undefined, level: "error" | "warning", err: HostError): void {
  if (!log) return;
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Guarded `sink.error` (matches every other module's `notifySafely`). */
function notifySafely(sink: StatusSink | undefined, err: HostError): void {
  if (!sink) return;
  try {
    sink.error(err);
  } catch {
    // Swallowed — see logSafely.
  }
}

/** Resolve one theme JSON's `colors` against the base palette (Req 7.2's
 * "a theme that omits a key falls back to the built-in base palette for
 * it"): every {@link UiColorKey} the JSON supplies a valid hex color for is
 * used; every other key (missing, or an unparseable value) falls back to
 * `base.colors[key]`. An unparseable value is reported through
 * `log`/`sink` as a warning, not an error — it degrades to the same
 * per-key fallback a simply-missing key gets, it just also says why. */
function resolveColors(
  json: ThemeJson["colors"],
  base: ResolvedTheme,
  deps: { log?: HostLog; sink?: StatusSink; path?: string },
): Record<UiColorKey, RGB> {
  const colors = { ...base.colors };
  if (!json) return colors;
  for (const [key, raw] of Object.entries(json)) {
    if (!(key in colors)) {
      // Not a recognized UiColorKey (a typo, or a VS Code key outside this
      // MVP's ~40/57-key subset) — silently ignored rather than erroring;
      // an unknown key breaks nothing for a theme that mostly does target
      // this subset.
      continue;
    }
    if (typeof raw !== "string") continue;
    const rgb = parseHexColor(raw);
    if (!rgb) {
      logSafely(deps.log, "warning", {
        path: deps.path,
        message: `Theme color "${key}" ("${raw}") is not a valid hex color; falling back to the base palette for this key.`,
      });
      notifySafely(deps.sink, {
        path: deps.path,
        message: `Theme color "${key}" ("${raw}") is not a valid hex color; using the base palette's value instead.`,
      });
      continue;
    }
    (colors as Record<string, RGB>)[key] = rgb;
  }
  return colors;
}

/** Resolve one theme JSON's `tokenColors` into `tokens` — every capture the
 * JSON declares a style for, converted to a `Style`; captures the JSON does
 * not mention are simply absent (longest-prefix fallback, `resolveCapture
 * Style` below, is a *lookup-time* concern, not something baked into the
 * stored map — an unset `"function.builtin"` should fall back to whatever
 * `"function"` resolves to *at lookup time*, including a base theme with no
 * `tokens` at all). */
function resolveTokens(json: ThemeJson["tokenColors"]): Partial<Record<CaptureName, Style>> {
  const tokens: Partial<Record<CaptureName, Style>> = {};
  if (!json) return tokens;
  for (const [capture, styleJson] of Object.entries(json)) {
    if (!styleJson) continue;
    const style: Style = {
      foreground: styleJson.foreground ? parseHexColor(styleJson.foreground) : undefined,
      background: styleJson.background ? parseHexColor(styleJson.background) : undefined,
      ...parseFontStyle(styleJson.fontStyle),
    };
    tokens[capture as CaptureName] = style;
  }
  return tokens;
}

/**
 * Resolve a longest-prefix capture style lookup (Req 7.2, design.md §9,
 * §10): an exact match in `tokens` wins; otherwise the capture name is
 * shortened one dotted segment at a time (`"function.builtin.foo"` ->
 * `"function.builtin"` -> `"function"`) until a match is found or the name
 * is exhausted. Returns `undefined` if nothing in `tokens` matches any
 * prefix — the caller (a renderer) then has no style opinion for this
 * capture at all, which is a legitimate outcome (design.md §10's
 * "resolves captures to styles through the active theme" does not require
 * every possible capture to have one).
 */
export function resolveCaptureStyle(
  tokens: Partial<Record<CaptureName, Style>>,
  captureName: CaptureName,
): Style | undefined {
  let candidate: string = captureName;
  for (;;) {
    const style = tokens[candidate as CaptureName];
    if (style) return style;
    const lastDot = candidate.lastIndexOf(".");
    if (lastDot === -1) return undefined;
    candidate = candidate.slice(0, lastDot);
  }
}

/** Options for {@link loadThemeFromJsonText}. */
export interface LoadThemeOptions {
  /** For error/warning messages — typically the theme JSON file's path. */
  path?: string;
  log?: HostLog;
  sink?: StatusSink;
}

/**
 * Parse+resolve one theme's raw JSON text into a {@link ResolvedTheme}
 * (this module's TSDoc). Never throws: a JSONC parse failure or a
 * non-object top level reports through `options.log`/`options.sink` (with
 * line/column when available, matching `config/service.ts`'s settings-file
 * error reporting) and returns {@link createBaseTheme}'s palette outright.
 */
export function loadThemeFromJsonText(text: string, options: LoadThemeOptions = {}): ResolvedTheme {
  const base = createBaseTheme();
  const parsed = parseJsonc<unknown>(text);
  if (!parsed.ok) {
    const location = options.path ? `${options.path} ` : "";
    const message = `Theme JSON ${location}line ${parsed.line}, column ${parsed.column}: ${parsed.message}. Falling back to the base palette.`;
    logSafely(options.log, "error", { path: options.path, message });
    notifySafely(options.sink, { path: options.path, message });
    return base;
  }
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    const message = `Theme JSON ${options.path ? `(${options.path}) ` : ""}must be a JSON object at the top level. Falling back to the base palette.`;
    logSafely(options.log, "error", { path: options.path, message });
    notifySafely(options.sink, { path: options.path, message });
    return base;
  }

  const json = parsed.value as ThemeJson;
  return {
    colors: resolveColors(json.colors, base, { log: options.log, sink: options.sink, path: options.path }),
    tokens: resolveTokens(json.tokenColors),
  };
}

/** Guarded, describable wrapper for use by callers reading the file
 * themselves ({@link loadThemeFromJsonText} above already never throws —
 * this exists only so a caller reading a file that itself throws, e.g. an
 * ENOENT, gets the same "fall back to base, report once" treatment rather
 * than needing its own try/catch). */
export function loadThemeFallbackForReadError(
  cause: unknown,
  options: LoadThemeOptions = {},
): ResolvedTheme {
  const location = options.path ? ` (${options.path})` : "";
  const message = `Failed to read theme JSON${location}: ${describeError(cause)}. Falling back to the base palette.`;
  logSafely(options.log, "error", { path: options.path, message });
  notifySafely(options.sink, { path: options.path, message });
  return createBaseTheme();
}
