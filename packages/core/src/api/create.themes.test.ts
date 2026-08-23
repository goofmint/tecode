/**
 * Tests for `createTecodeApi`'s real `tecode.themes` wiring (Task 2.6, Req
 * 7.1, 7.3): `register`/`current` delegate to an injected `ThemeRegistry`/
 * `ThemeService` pair when BOTH are supplied, and fall back to
 * `stubs.ts`'s `createThemesStub` exactly as before otherwise
 * (`CreateTecodeApiDeps.themeRegistry`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, ResolvedTheme, ThemeContribution } from "@tecode/api";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import type { ConfigServiceFs } from "../config/service";
import { createConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog } from "../host/errors";
import { createTecodeApi } from "./create";
import { createBaseTheme } from "./stubs";

function createEmptyConfigFs(): ConfigServiceFs {
  return {
    readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    watch: () => ({ close() {} }),
  };
}

async function buildBaseDeps() {
  const log = createHostLog();
  const sink = { error() {} };
  const commands = createCommandRegistry({ log, sink });
  const documents = createDocumentManager({ log, sink });
  const fs = createFileSystem({ log });
  const config = createConfigService({ log, sink, fs: createEmptyConfigFs() });
  await config.ready;
  const context = createContextService();
  return { commands, documents, fs, config, context, sink };
}

/** A minimal `Pick<ThemeService, "get" | "getActiveThemeId" | "onDidChange">`
 * fake (Task 3.4) — every test that only cares about `current` supplies a
 * fixed `activeId`/`onDidChange` it never exercises. */
function fakeThemeService(get: () => ResolvedTheme, activeId = "t1") {
  return { get, getActiveThemeId: () => activeId, onDidChange: () => ({ dispose() {} }) };
}

describe("createTecodeApi's tecode.themes (Task 2.6)", () => {
  test("falls back to the stub when neither themeRegistry nor themeService is supplied", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);
    expect(api.themes.current).toEqual(createBaseTheme());
    // Task 3.4: the stub's hardcoded label/inert event, register/dispose
    // symmetric like every other stub `onDidChange`.
    expect(api.themes.currentLabel).toBe("Base (Built-in)");
    const sub = api.themes.onDidChange(() => {});
    expect(() => sub.dispose()).not.toThrow();
  });

  test("uses the injected ThemeService for `current` and ThemeRegistry for `register` when both are given", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: { foreground: { r: 9, g: 9, b: 9 } } as ResolvedTheme["colors"], tokens: {} };
    const registered: ThemeContribution[] = [];
    const disposable: Disposable = { dispose() {} };

    const api = createTecodeApi({
      ...deps,
      themeService: fakeThemeService(() => activeTheme),
      themeRegistry: {
        register: (contribution: ThemeContribution) => {
          registered.push(contribution);
          return disposable;
        },
        get: (id) => (id === "t1" ? { id, label: "T1 Display Name", theme: activeTheme } : undefined),
      },
    });

    expect(api.themes.current).toBe(activeTheme);

    const contribution: ThemeContribution = { id: "t1", label: "T1", path: "t1.json" };
    const result = api.themes.register(contribution);
    expect(registered).toEqual([contribution]);
    expect(result).toBe(disposable);
  });

  test("falls back to the stub when only one of themeRegistry/themeService is given", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: { foreground: { r: 1, g: 2, b: 3 } } as ResolvedTheme["colors"], tokens: {} };

    const api = createTecodeApi({ ...deps, themeService: fakeThemeService(() => activeTheme) });
    // themeRegistry was omitted — the pairing gate keeps `current` on the
    // stub too, not a half-real mix.
    expect(api.themes.current).toEqual(createBaseTheme());
    expect(api.themes.currentLabel).toBe("Base (Built-in)");
  });

  test("tecode.ui.useTheme() still delegates to tecode.themes.current with real wiring", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: { foreground: { r: 4, g: 5, b: 6 } } as ResolvedTheme["colors"], tokens: {} };
    const api = createTecodeApi({
      ...deps,
      themeService: fakeThemeService(() => activeTheme),
      themeRegistry: { register: () => ({ dispose() {} }), get: () => undefined },
    });
    expect(api.ui.useTheme()).toBe(activeTheme);
  });

  test("currentLabel (Task 3.4, Req 11.6) resolves the active id's label via the registry, and onDidChange delegates to the ThemeService", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: {} as ResolvedTheme["colors"], tokens: {} };
    const listeners: Array<() => void> = [];

    const api = createTecodeApi({
      ...deps,
      themeService: {
        get: () => activeTheme,
        getActiveThemeId: () => "dark",
        onDidChange: (listener) => {
          listeners.push(listener);
          return { dispose() {} };
        },
      },
      themeRegistry: {
        register: () => ({ dispose() {} }),
        get: (id) => (id === "dark" ? { id, label: "Dark Modern", theme: activeTheme } : undefined),
      },
    });

    expect(api.themes.currentLabel).toBe("Dark Modern");

    let fired = 0;
    api.themes.onDidChange(() => {
      fired += 1;
    });
    for (const listener of listeners) listener();
    expect(fired).toBe(1);
  });

  test("currentLabel falls back to the stub's label if the active id is somehow unknown to the registry", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: {} as ResolvedTheme["colors"], tokens: {} };
    const api = createTecodeApi({
      ...deps,
      themeService: fakeThemeService(() => activeTheme, "unknown-id"),
      themeRegistry: { register: () => ({ dispose() {} }), get: () => undefined },
    });
    expect(api.themes.currentLabel).toBe("Base (Built-in)");
  });
});
