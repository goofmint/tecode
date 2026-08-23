/**
 * Tests for {@link ThemeProvider}/{@link useTheme}/{@link useLiveTheme}
 * (Req 7.3, 7.5). The live-switching test renders through the REAL
 * `ThemeService`/`ThemeRegistry` and asserts that a `setTheme` call
 * re-renders a `useTheme()` consumer with the new palette — the actual
 * "onDidChange re-renders `useTheme()` consumers with the new palette"
 * behavior this task's plan calls for, exercised end to end rather than by
 * inspecting the hook in isolation.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createBaseTheme } from "../api/stubs";
import { createThemeRegistry } from "./themeRegistry";
import { createThemeService } from "./themeService";
import { ThemeProvider, useTheme } from "./theme";

/** Renders the active theme's `editor.background` red channel as text — a
 * simple, unambiguous way to observe which theme is active through
 * `captureCharFrame` without needing pixel-color inspection. */
function BackgroundRedProbe() {
  const theme = useTheme();
  return <text>{`R=${theme.colors["editor.background"].r}`}</text>;
}

describe("ThemeProvider static `theme` prop (backward compatibility)", () => {
  test("renders the fixed theme with no themeService given", async () => {
    const theme = createBaseTheme();
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider theme={theme}>
        <BackgroundRedProbe />
      </ThemeProvider>,
      { width: 20, height: 3 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain(`R=${theme.colors["editor.background"].r}`);
  });

  test("defaults to createBaseTheme() when neither theme nor themeService is given", async () => {
    const base = createBaseTheme();
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <BackgroundRedProbe />
      </ThemeProvider>,
      { width: 20, height: 3 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain(`R=${base.colors["editor.background"].r}`);
  });
});

describe("ThemeProvider live theme switching (Req 7.3, 7.5)", () => {
  test("a themeService.setTheme() call re-renders useTheme() consumers with the new palette", async () => {
    const registry = createThemeRegistry({
      fs: {
        readFile: () =>
          Promise.resolve(JSON.stringify({ colors: { "editor.background": "#050505" } })),
      },
    });
    registry.register({ id: "dark", label: "Dark", path: "/dark.json" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const themeService = createThemeService({ registry });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider themeService={themeService}>
        <BackgroundRedProbe />
      </ThemeProvider>,
      { width: 20, height: 3 },
    );
    await renderOnce();
    const base = createBaseTheme();
    expect(captureCharFrame()).toContain(`R=${base.colors["editor.background"].r}`);

    await act(async () => {
      themeService.setTheme("dark");
    });
    await renderOnce();
    expect(captureCharFrame()).toContain("R=5");
    expect(captureCharFrame()).not.toContain(`R=${base.colors["editor.background"].r}`);
  });

  test("previewTheme -> revertTheme round-trips the rendered palette back", async () => {
    const registry = createThemeRegistry({
      fs: {
        readFile: () =>
          Promise.resolve(JSON.stringify({ colors: { "editor.background": "#0a0a0a" } })),
      },
    });
    registry.register({ id: "preview-me", label: "Preview Me", path: "/preview.json" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const themeService = createThemeService({ registry });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider themeService={themeService}>
        <BackgroundRedProbe />
      </ThemeProvider>,
      { width: 20, height: 3 },
    );
    await renderOnce();
    const base = createBaseTheme();

    await act(async () => {
      themeService.previewTheme("preview-me");
    });
    await renderOnce();
    expect(captureCharFrame()).toContain("R=10");

    await act(async () => {
      themeService.revertTheme();
    });
    await renderOnce();
    expect(captureCharFrame()).toContain(`R=${base.colors["editor.background"].r}`);
  });
});
