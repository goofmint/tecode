/**
 * Tests for {@link applyConfiguredPanelHeight}/
 * {@link wirePanelHeightConfigSync} (Issue #118) — exercised against the
 * REAL `ConfigService` so "config-file-driven live sync" is proven through
 * the actual `onDidChange`/`affectsConfiguration` wiring, not a fake
 * (mirrors `sidebarWidthConfigSync.test.ts`'s identical harness shape).
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";
import { createConfigService, type ConfigServiceFs } from "../config/service";
import { MIN_PANEL_HEIGHT } from "./panelHeight";
import { applyConfiguredPanelHeight, wirePanelHeightConfigSync } from "./panelHeightConfigSync";

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
  layoutState: { update(partial: { panelHeight?: number }): void };
  heights(): number[];
} {
  const heights: number[] = [];
  return {
    layoutState: {
      update(partial) {
        if (partial.panelHeight !== undefined) heights.push(partial.panelHeight);
      },
    },
    heights: () => heights,
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
  const { layoutState, heights } = createRecordingLayoutState();
  return { config, configFs, layoutState, heights };
}

describe("applyConfiguredPanelHeight (Issue #118)", () => {
  test("applies the configured height when it names a number", async () => {
    const { config, layoutState, heights } = await buildHarness(`{ "workbench.panelHeight": 20 }`);
    applyConfiguredPanelHeight(config, layoutState);
    expect(heights()).toEqual([20]);
  });

  test("is a no-op when the config value is not a number", async () => {
    const { config, layoutState, heights } = await buildHarness(`{}`);
    applyConfiguredPanelHeight(config, layoutState);
    expect(heights()).toEqual([]);
  });

  test("clamps a too-small configured height to MIN_PANEL_HEIGHT (no terminal height known here)", async () => {
    const { config, layoutState, heights } = await buildHarness(`{ "workbench.panelHeight": 0 }`);
    applyConfiguredPanelHeight(config, layoutState);
    expect(heights()).toEqual([MIN_PANEL_HEIGHT]);
  });
});

/**
 * Finding 3 (CodeRabbit PR #111 review, applied to `workbench.panelHeight`
 * for Issue #118 exactly as `sidebarWidthConfigSync.test.ts` applies it to
 * `workbench.sidebarWidth`): `ConfigService.get`'s merged view cannot
 * distinguish "the user set 10" from "nobody set anything and the schema
 * default happens to be 10" — these tests build a harness that ALSO
 * registers `workbench.panelHeight`'s real schema default (exactly like
 * `coreDefaults.ts`'s `registerCoreConfiguration` does in production,
 * unlike {@link buildHarness} above, which never registers a schema at all)
 * so a regression back to "apply whatever `get` returns" — the exact bug
 * this module's own TSDoc's "Only an EXPLICIT setting is ever applied"
 * section describes — is caught here, not just in a harness that happens
 * to never populate `defaultsLayer`.
 */
describe("applyConfiguredPanelHeight applies ONLY an explicit setting (Issue #118 Finding 3)", () => {
  async function buildHarnessWithSchemaDefault(initialSettings: string) {
    const configFs = createConfigFs({ [USER_SETTINGS_PATH]: initialSettings });
    const config = createConfigService({
      log: createHostLog(),
      sink: { error() {} },
      fs: configFs.fs,
    });
    config.registerConfiguration({
      title: "test",
      properties: {
        "workbench.panelHeight": { type: "number", default: 10 },
      },
    });
    await config.ready;
    const { layoutState, heights } = createRecordingLayoutState();
    return { config, configFs, layoutState, heights };
  }

  test("a settings.json with no key at all is a no-op, even though the schema default resolves to a real number", async () => {
    const { config, layoutState, heights } = await buildHarnessWithSchemaDefault(`{}`);
    applyConfiguredPanelHeight(config, layoutState);
    // Regression: applying the merged `get()` value unconditionally here
    // would push the schema default (10) into `layoutState.update`, which
    // is exactly Finding 3 — a `state.json`-persisted height getting
    // clobbered by the default on every startup.
    expect(heights()).toEqual([]);
  });

  test("a user who explicitly configures the SAME value as the schema default (10) is still applied", async () => {
    const { config, layoutState, heights } = await buildHarnessWithSchemaDefault(
      `{ "workbench.panelHeight": 10 }`,
    );
    applyConfiguredPanelHeight(config, layoutState);
    // Must not be indistinguishable from "nobody set anything" — a user
    // who genuinely sets 10 is a real, explicit setting.
    expect(heights()).toEqual([10]);
  });

  test("regression: a state.json-persisted non-default height survives startup when settings.json names no key", async () => {
    const { config } = await buildHarnessWithSchemaDefault(`{}`);
    // A stateful fake standing in for `LayoutStateService` — reflects
    // `state.json`'s own persisted height (33 here, deliberately NOT the
    // schema default) until `update()` actually changes it. This is the
    // shape a real restart takes: `state.json` already holds 33 before
    // `applyConfiguredPanelHeight` ever runs.
    let persistedHeight = 33;
    const layoutState = {
      update(partial: { panelHeight?: number }) {
        if (partial.panelHeight !== undefined) persistedHeight = partial.panelHeight;
      },
    };
    applyConfiguredPanelHeight(config, layoutState);
    expect(persistedHeight).toBe(33);
  });
});

describe("wirePanelHeightConfigSync (Issue #118, config-file-driven live sync)", () => {
  test("a settings.json change to workbench.panelHeight live-updates layout state", async () => {
    const { config, configFs, layoutState, heights } = await buildHarness(`{}`);
    const sub = wirePanelHeightConfigSync({ config, layoutState });

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.panelHeight": 15 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(heights()).toEqual([15]);
    sub.dispose();
  });

  test("a settings.json change to an unrelated key does not touch the panel height", async () => {
    const { config, configFs, layoutState, heights } = await buildHarness(`{}`);
    const sub = wirePanelHeightConfigSync({ config, layoutState });

    configFs.set(USER_SETTINGS_PATH, `{ "editor.tabSize": 8 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(heights()).toEqual([]);
    sub.dispose();
  });

  test("dispose() stops future config changes from affecting the panel height", async () => {
    const { config, configFs, layoutState, heights } = await buildHarness(`{}`);
    const sub = wirePanelHeightConfigSync({ config, layoutState });
    sub.dispose();

    configFs.set(USER_SETTINGS_PATH, `{ "workbench.panelHeight": 15 }`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(heights()).toEqual([]);
  });

  test("Finding 3's deliberate choice: removing workbench.panelHeight from settings.json does NOT snap the height back to the schema default", async () => {
    // Same schema-default registration as the `applyConfiguredPanelHeight`
    // describe block above — without it, `get()` would already read
    // `undefined` on removal and this test would pass for the wrong
    // reason (never exercising `isExplicitlySet` at all).
    const configFs = createConfigFs({ [USER_SETTINGS_PATH]: `{ "workbench.panelHeight": 15 }` });
    const config = createConfigService({
      log: createHostLog(),
      sink: { error() {} },
      fs: configFs.fs,
    });
    config.registerConfiguration({
      title: "test",
      properties: { "workbench.panelHeight": { type: "number", default: 10 } },
    });
    await config.ready;
    const { layoutState, heights } = createRecordingLayoutState();
    const sub = wirePanelHeightConfigSync({ config, layoutState });

    // Remove the key entirely — the merged view now falls through to the
    // schema default (10), but this module's documented policy (this
    // file's own TSDoc) is to leave the height alone rather than treat a
    // removal as "reset to 10".
    configFs.set(USER_SETTINGS_PATH, `{}`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(heights()).toEqual([]);
    sub.dispose();
  });
});
