/**
 * `ThemeProvider`/`useTheme()` (Req 7.3, design.md §8.1, §9; Task 1.14,
 * extended by Task 2.6 for live theme switching): supplies a
 * {@link ResolvedTheme} to the component tree via React context. Every
 * OpenTUI/React component in `core/ui` reads colors through
 * {@link useTheme} rather than hard-coding literals (Req 7.3).
 *
 * **Live switching (Task 2.6, Req 7.3, 7.5)**: `ThemeProvider` now accepts
 * an optional `themeService` prop (`themeService.ts`'s `ThemeService`) —
 * when given, {@link useLiveTheme} subscribes to its `onDidChange` and the
 * context value tracks the service's active theme reactively, so a
 * `theme.select` preview/commit or a `workbench.colorTheme` config-file
 * live-switch (`main.ts`'s composition root) re-renders every `useTheme()`
 * consumer with the new palette. The static `theme` prop is KEPT for
 * backward compatibility — every existing caller/test that constructs
 * `<ThemeProvider theme={someResolvedTheme}>` with no service continues to
 * render that fixed theme unchanged (this module's TSDoc on
 * `ThemeProviderProps`). When BOTH are given, `themeService` wins from the
 * very first render onward: {@link useLiveTheme} reads `themeService.get()`
 * synchronously during render (the subscription itself is effect-deferred,
 * but the *value* is not), so `theme` only ever matters as the fallback for
 * a caller that supplies no `themeService` at all.
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

import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import { RGBA } from "@opentui/core";
import type { ResolvedTheme, RGB, Style } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";
import type { ThemeService } from "./themeService";

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
  /** A fixed `ResolvedTheme` — kept for backward compatibility (this
   * module's TSDoc). Defaults to {@link createBaseTheme}'s result when
   * neither this nor `themeService` is given. Always ignored, including the
   * initial render, whenever `themeService` is given — see this module's
   * TSDoc. */
  theme?: ResolvedTheme;
  /** The live theme service (Task 2.6, `themeService.ts`) — when given,
   * the provided theme tracks `themeService.get()` reactively via
   * {@link useLiveTheme} instead of staying fixed at `theme`. See this
   * module's TSDoc for how `theme`/`themeService` interact when both are
   * given. */
  themeService?: Pick<ThemeService, "get" | "onDidChange">;
  children?: ReactNode;
}

/** Re-renders the calling component whenever `themeService` reports a
 * change (Req 7.3, 7.5) and returns its current active theme — same
 * subscribe-then-force-render shape, including the post-subscribe
 * re-render that closes the render-before-subscribe race, as
 * `shell.tsx`'s `useSlotViews`/`useEditorSessionVersion` (that module's
 * TSDoc explains the race in full: a change landing in the gap between
 * this render and the subscribing effect running would otherwise be lost
 * until some later, unrelated re-render). Returns `undefined` when
 * `themeService` itself is `undefined` — {@link ThemeProvider} then falls
 * back to its static `theme` prop entirely, matching every other optional-
 * service fallback in this codebase (`shell.tsx`'s `editorSession`,
 * `findService`, ...). */
export function useLiveTheme(themeService: Pick<ThemeService, "get" | "onDidChange"> | undefined): ResolvedTheme | undefined {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!themeService) return undefined;
    const sub = themeService.onDidChange(() => forceRender());
    // Closes the subscribe-after-render race — see this function's TSDoc.
    forceRender();
    return () => sub.dispose();
  }, [themeService]);
  return themeService?.get();
}

/** Supplies a {@link ResolvedTheme} to the tree beneath it via React
 * context (design.md §8.1's component tree: `<ThemeProvider>` wraps
 * everything else). Tracks `themeService` reactively when given
 * ({@link useLiveTheme}); otherwise stays fixed at `theme` (this module's
 * TSDoc, `ThemeProviderProps`). */
export function ThemeProvider(props: ThemeProviderProps): ReactNode {
  const liveTheme = useLiveTheme(props.themeService);
  const theme = liveTheme ?? props.theme ?? createBaseTheme();
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
