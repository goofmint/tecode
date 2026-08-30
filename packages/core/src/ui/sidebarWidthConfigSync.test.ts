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

/**
 * Finding 3 (CodeRabbit PR #111 review): `ConfigService.get`'s merged view
 * cannot distinguish "the user set 30" from "nobody set anything and the
 * schema default happens to be 30" — these tests build a harness that
 * ALSO registers `workbench.sidebarWidth`'s real schema default (exactly
 * like `coreDefaults.ts`'s `registerCoreConfiguration` does in production,
 * unlike {@link buildHarness} above, which never registers a schema at
 * all) so a regression back to "apply whatever `get` returns" — the exact
 * bug this module's own TSDoc's "Only an EXPLICIT setting is ever applied"
 * section describes — is caught here, not just in a harness that happens
 * to never populate `defaultsLayer`.
 */
describe("applyConfiguredSidebarWidth applies ONLY an explicit setting (Issue #105 Finding 3)", () => {
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
        "workbench.sidebarWidth": { type: "number", default: 30 },
      },
    });
    await config.ready;
    const { layoutState, widths } = createRecordingLayoutState();
    return { config, configFs, layoutState, widths };
  }

  test("a settings.json with no key at all is a no-op, even though the schema default resolves to a real number", async () => {
    const { config, layoutState, widths } = await buildHarnessWithSchemaDefault(`{}`);
    applyConfiguredSidebarWidth(config, layoutState);
    // Regression: applying the merged `get()` value unconditionally here
    // would push the schema default (30) into `layoutState.update`, which
    // is exactly Finding 3 — a `state.json`-persisted width getting
    // clobbered by the default on every startup.
    expect(widths()).toEqual([]);
  });

  test("a user who explicitly configures the SAME value as the schema default (30) is still applied", async () => {
    const { config, layoutState, widths } = await buildHarnessWithSchemaDefault(
      `{ "workbench.sidebarWidth": 30 }`,
    );
    applyConfiguredSidebarWidth(config, layoutState);
    // Must not be indistinguishable from "nobody set anything" — a user
    // who genuinely sets 30 is a real, explicit setting.
    expect(widths()).toEqual([30]);
  });

  test("regression: a state.json-persisted non-default width survives startup when settings.json names no key", async () => {
    const { config } = await buildHarnessWithSchemaDefault(`{}`);
    // A stateful fake standing in for `LayoutStateService` — reflects
    // `state.json`'s own persisted width (77 here, deliberately NOT the
    // schema default) until `update()` actually changes it. This is the
    // shape a real restart takes: `state.json` already holds 77 before
    // `applyConfiguredSidebarWidth` ever runs.
    let persistedWidth = 77;
    const layoutState = {
      update(partial: { sidebarWidth?: number }) {
        if (partial.sidebarWidth !== undefined) persistedWidth = partial.sidebarWidth;
      },
    };
    applyConfiguredSidebarWidth(config, layoutState);
    expect(persistedWidth).toBe(77);
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

  test("Finding 3's deliberate choice: removing workbench.sidebarWidth from settings.json does NOT snap the width back to the schema default", async () => {
    // Same schema-default registration as the `applyConfiguredSidebarWidth`
    // describe block above — without it, `get()` would already read
    // `undefined` on removal and this test would pass for the wrong
    // reason (never exercising `isExplicitlySet` at all).
    const configFs = createConfigFs({ [USER_SETTINGS_PATH]: `{ "workbench.sidebarWidth": 50 }` });
    const config = createConfigService({
      log: createHostLog(),
      sink: { error() {} },
      fs: configFs.fs,
    });
    config.registerConfiguration({
      title: "test",
      properties: { "workbench.sidebarWidth": { type: "number", default: 30 } },
    });
    await config.ready;
    const { layoutState, widths } = createRecordingLayoutState();
    const sub = wireSidebarWidthConfigSync({ config, layoutState });

    // Remove the key entirely — the merged view now falls through to the
    // schema default (30), but this module's documented policy (this
    // file's own TSDoc) is to leave the width alone rather than treat a
    // removal as "reset to 30".
    configFs.set(USER_SETTINGS_PATH, `{}`);
    configFs.trigger(USER_SETTINGS_PATH);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(widths()).toEqual([]);
    sub.dispose();
  });
});
