/**
 * Tests for {@link applyConfiguredSidebarWidth}/
 * {@link wireSidebarWidthConfigSync} (Issue #105) — exercised against the
 * REAL `ConfigService` so "config-file-driven live sync" is proven through
 * the actual `onDidChange`/`affectsConfiguration` wiring, not a fake
 * (mirrors `themeConfigSync.test.ts`'s identical harness shape).
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";
import { createConfigService, type ConfigServiceFs } from "../config/service";
import { MIN_SIDEBAR_WIDTH } from "./sidebarWidth";
import { applyConfiguredSidebarWidth, wireSidebarWidthConfigSync } from "./sidebarWidthConfigSync";

function createConfigFs(
  initial: Record<string, string>,
): { fs: ConfigServiceFs; set(path: string, text: string): void; trigger(path: string): void } {
  const files = { ...initial };
  const onChangeHandlers: Record<string, () => void> = {};
  return {
    set(path, text) {
      files[path] = text;
    },
    trigger(path) {
      onChangeHandlers[path]?.();
    },
    fs: {
      readFile: (path) => {
        const text = files[path];
        return text === undefined
          ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          : Promise.resolve(text);
      },
      watch: (path, onChange) => {
        onChangeHandlers[path] = onChange;
        return { close: () => delete onChangeHandlers[path] };
      },
    },
  };
}

/** A minimal, recording fake of `LayoutStateService`'s `update` — this
 * module only ever calls that one method, matching its own
 * `Pick<LayoutStateService, "update">` narrowing. */
function createRecordingLayoutState(): {
  layoutState: { update(partial: { sidebarWidth?: number }): void };
  widths(): number[];
} {
  const widths: number[] = [];
  return {
    layoutState: {
      update(partial) {
        if (partial.sidebarWidth !== undefined) widths.push(partial.sidebarWidth);
      },
    },
    widths: () => widths,
  };
}

const USER_SETTINGS_PATH = getUserSettingsPath();

async function buildHarness(initialSettings: string) {
  const configFs = createConfigFs({ [USER_SETTINGS_PATH]: initialSettings });
  const config = createConfigService({
    log: createHostLog(),
    sink: { error() {} },
    fs: configFs.fs,
  });
  await config.ready;
  const { layoutState, widths } = createRecordingLayoutState();
  return { config, configFs, layoutState, widths };
}

describe("applyConfiguredSidebarWidth (Issue #105)", () => {
  test("applies the configured width when it names a number", async () => {
    const { config, layoutState, widths } = await buildHarness(`{ "workbench.sidebarWidth": 45 }`);
    applyConfiguredSidebarWidth(config, layoutState);
    expect(widths()).toEqual([45]);
  });

  test("is a no-op when the config value is not a number", async () => {
    const { config, layoutState, widths } = await buildHarness(`{}`);
    applyConfiguredSidebarWidth(config, layoutState);
    expect(widths()).toEqual([]);
  });

  test("clamps a too-small configured width to MIN_SIDEBAR_WIDTH (no terminal width known here)", async () => {
    const { config, layoutState, widths } = await buildHarness(`{ "workbench.sidebarWidth": 0 }`);
    applyConfiguredSidebarWidth(config, layoutState);
    expect(widths()).toEqual([MIN_SIDEBAR_WIDTH]);
  });
});

describe("wireSidebarWidthConfigSync (Issue #105, config-file-driven live sync)", () => {
  test("a settings.json change to workbench.sidebarWidth live-updates layout state", async () => {
    const { config, configFs, layoutState, widths } = await buildHarness(`{}`);
    const sub = wireSidebarWidthConfigSync({ config, layoutState });

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.sidebarWidth": 50 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(widths()).toEqual([50]);
    sub.dispose();
  });

  test("a settings.json change to an unrelated key does not touch the sidebar width", async () => {
    const { config, configFs, layoutState, widths } = await buildHarness(`{}`);
    const sub = wireSidebarWidthConfigSync({ config, layoutState });

    configFs.set(USER_SETTINGS_PATH, `{ "editor.tabSize": 8 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(widths()).toEqual([]);
    sub.dispose();
  });

  test("dispose() stops future config changes from affecting the sidebar width", async () => {
    const { config, configFs, layoutState, widths } = await buildHarness(`{}`);
    const sub = wireSidebarWidthConfigSync({ config, layoutState });
    sub.dispose();

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.sidebarWidth": 50 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(widths()).toEqual([]);
  });
});
