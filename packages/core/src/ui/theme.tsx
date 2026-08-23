/**
 * `ThemeProvider`/`useTheme()` (Req 7.3, design.md §8.1, §9; Task 1.14):
 * supplies a {@link ResolvedTheme} to the component tree via React context.
 * Every OpenTUI/React component in `core/ui` reads colors through
 * {@link useTheme} rather than hard-coding literals (Req 7.3).
 *
 * **This task's scope**: a real theme loader (`ThemeRegistry`, quantization
 * for 256-color terminals, `theme.select` live preview) is design.md §9's
 * job for a later task (2.6) — `ThemeProvider` here defaults to the same
 * hardcoded base palette `api/stubs.ts`'s `createBaseTheme` already builds
 * for `tecode.themes.current` (Task 1.13), reused rather than duplicated so
 * the two never drift (tasks.md's Task 1.14: "`ThemeProvider` (hardcoded
 * base palette for now)").
 *
 * **Two different `useTheme`s, deliberately** (do not confuse them):
 * `tecode.ui.useTheme()` (`@tecode/api`'s `UiNamespace.useTheme`,
 * `api/create.ts`) is a plain synchronous getter — extension code calls it
 * from anywhere, including outside a React render (the contract test
 * suite's fixture extension calls it from a plain `async activate(ctx)`),
 * so it cannot be a real hook obeying the rules of hooks. This module's
 * {@link useTheme} *is* a real hook (`useContext` under the hood) meant for
 * `core`'s own OpenTUI/React components (`Shell`, `Sidebar`, ...) — it must
 * only ever be called during render. The two are wired to the same
 * underlying theme value at the assembly layer, not merged into one
 * function.
 */

import { createContext, useContext, type ReactNode } from "react";
import { RGBA } from "@opentui/core";
import type { ResolvedTheme, RGB, Style } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";

/** Convert a theme {@link RGB} (0-255 per channel, as `@tecode/api` models
 * it) to the `RGBA` OpenTUI's renderables accept for `backgroundColor`/
 * `borderColor`/`fg`/`bg` props. Fully opaque (`a = 255`) — the theme format
 * has no alpha channel (Req 7.2). */
export function toColorInput(rgb: RGB): RGBA {
  return RGBA.fromInts(rgb.r, rgb.g, rgb.b, 255);
}

/** Resolve a syntax capture {@link Style} to the `fg`/`bg` OpenTUI props for
 * a `<text>`/`<span>` node. `bold`/`italic`/`underline` are not yet mapped
 * (no consumer needs them until the real `EditorView` — a later task —
 * renders syntax-highlighted spans); documented here as the single spot
 * that will grow that mapping. */
export function styleToTextColors(style: Style | undefined): { fg?: RGBA; bg?: RGBA } {
  if (!style) return {};
  return {
    fg: style.foreground ? toColorInput(style.foreground) : undefined,
    bg: style.background ? toColorInput(style.background) : undefined,
  };
}

const ThemeContext = createContext<ResolvedTheme>(createBaseTheme());

/** Props for {@link ThemeProvider}. */
export interface ThemeProviderProps {
  /** Overrides the default hardcoded base palette (this module's TSDoc) —
   * a later task's real theme loader supplies the active `ResolvedTheme`
   * here. Defaults to {@link createBaseTheme}'s result. */
  theme?: ResolvedTheme;
  children?: ReactNode;
}

/** Supplies a {@link ResolvedTheme} to the tree beneath it via React
 * context (design.md §8.1's component tree: `<ThemeProvider>` wraps
 * everything else). */
export function ThemeProvider(props: ThemeProviderProps): ReactNode {
  const theme = props.theme ?? createBaseTheme();
  return <ThemeContext.Provider value={theme}>{props.children}</ThemeContext.Provider>;
}

/**
 * Read the active {@link ResolvedTheme} from context (Req 7.3). A real
 * React hook — only call this during render, inside a component beneath
 * {@link ThemeProvider} (or accept the default base-palette fallback
 * outside one, e.g. in isolated component tests). See this module's TSDoc
 * for why `tecode.ui.useTheme()` is a *different* function, not this one.
 */
export function useTheme(): ResolvedTheme {
  return useContext(ThemeContext);
}
