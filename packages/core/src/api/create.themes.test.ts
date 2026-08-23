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

describe("createTecodeApi's tecode.themes (Task 2.6)", () => {
  test("falls back to the stub when neither themeRegistry nor themeService is supplied", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);
    expect(api.themes.current).toEqual(createBaseTheme());
  });

  test("uses the injected ThemeService for `current` and ThemeRegistry for `register` when both are given", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: { foreground: { r: 9, g: 9, b: 9 } } as ResolvedTheme["colors"], tokens: {} };
    const registered: ThemeContribution[] = [];
    const disposable: Disposable = { dispose() {} };

    const api = createTecodeApi({
      ...deps,
      themeService: { get: () => activeTheme },
      themeRegistry: {
        register: (contribution: ThemeContribution) => {
          registered.push(contribution);
          return disposable;
        },
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

    const api = createTecodeApi({ ...deps, themeService: { get: () => activeTheme } });
    // themeRegistry was omitted — the pairing gate keeps `current` on the
    // stub too, not a half-real mix.
    expect(api.themes.current).toEqual(createBaseTheme());
  });

  test("tecode.ui.useTheme() still delegates to tecode.themes.current with real wiring", async () => {
    const deps = await buildBaseDeps();
    const activeTheme: ResolvedTheme = { colors: { foreground: { r: 4, g: 5, b: 6 } } as ResolvedTheme["colors"], tokens: {} };
    const api = createTecodeApi({
      ...deps,
      themeService: { get: () => activeTheme },
      themeRegistry: { register: () => ({ dispose() {} }) },
    });
    expect(api.ui.useTheme()).toBe(activeTheme);
  });
});
