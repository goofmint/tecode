/**
 * Tests for {@link registerCoreConfiguration} (Req 9.5, 11.1; design.md
 * §8.3): `editor.lineNumbers`/`editor.tabSize`/`editor.insertSpaces` become
 * readable defaults through the real `ConfigService`, exactly as an
 * extension's `contributes.configuration` would register them.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createConfigService, type ConfigServiceFs } from "./service";
import {
  CORE_CONFIGURATION,
  DEFAULT_COLOR_THEME_ID,
  DEFAULT_KEYBINDING_PRESET,
  registerCoreConfiguration,
} from "./coreDefaults";

/** A {@link ConfigServiceFs} with no files on disk, so every layer besides
 * the defaults layer stays empty (matches other suites' hermetic fs stubs). */
function createEmptyFs(): ConfigServiceFs {
  return {
    readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    watch: () => ({ close() {} }),
  };
}

function createRecordingSink() {
  return { error() {} };
}

describe("registerCoreConfiguration (Req 9.5)", () => {
  test("registers editor.lineNumbers (default true), editor.tabSize (default 4), and editor.insertSpaces (default true)", async () => {
    const config = createConfigService({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createEmptyFs(),
    });
    registerCoreConfiguration(config);
    await config.ready;

    expect(config.get<boolean>("editor.lineNumbers")).toBe(true);
    expect(config.get<number>("editor.tabSize")).toBe(4);
    expect(config.get<boolean>("editor.insertSpaces")).toBe(true);
    expect(config.get<string>("workbench.colorTheme")).toBe(DEFAULT_COLOR_THEME_ID);
    expect(config.get<string>("keybindings.preset")).toBe(DEFAULT_KEYBINDING_PRESET);
  });

  test("CORE_CONFIGURATION declares exactly the five documented keys", () => {
    expect(Object.keys(CORE_CONFIGURATION.properties).sort()).toEqual([
      "editor.insertSpaces",
      "editor.lineNumbers",
      "editor.tabSize",
      "keybindings.preset",
      "workbench.colorTheme",
    ]);
    expect(CORE_CONFIGURATION.properties["editor.lineNumbers"]).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(CORE_CONFIGURATION.properties["editor.tabSize"]).toMatchObject({
      type: "number",
      default: 4,
    });
    expect(CORE_CONFIGURATION.properties["editor.insertSpaces"]).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(CORE_CONFIGURATION.properties["workbench.colorTheme"]).toMatchObject({
      type: "string",
      default: DEFAULT_COLOR_THEME_ID,
    });
    expect(CORE_CONFIGURATION.properties["keybindings.preset"]).toMatchObject({
      type: "string",
      default: DEFAULT_KEYBINDING_PRESET,
    });
  });

  test("disposing the registration removes the defaults", async () => {
    const config = createConfigService({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createEmptyFs(),
    });
    const registration = registerCoreConfiguration(config);
    await config.ready;
    expect(config.get<boolean>("editor.lineNumbers")).toBe(true);

    registration.dispose();
    expect(config.get<boolean>("editor.lineNumbers")).toBeUndefined();
  });
});
