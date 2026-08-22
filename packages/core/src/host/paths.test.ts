import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getUserConfigDir,
  getUserExtensionsDir,
  getUserKeybindingsPath,
  getUserSettingsPath,
  getWorkspaceExtensionsDir,
  getWorkspaceSettingsPath,
} from "./paths";

const originalPlatform = process.platform;
const originalAppData = process.env["APPDATA"];

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalAppData === undefined) delete process.env["APPDATA"];
  else process.env["APPDATA"] = originalAppData;
});

describe("getUserConfigDir — POSIX", () => {
  beforeEach(() => setPlatform("linux"));

  test("resolves to ~/.config/tecode", () => {
    expect(getUserConfigDir()).toBe(join(homedir(), ".config", "tecode"));
  });

  test("darwin also uses ~/.config/tecode (no macOS-specific branch)", () => {
    setPlatform("darwin");
    expect(getUserConfigDir()).toBe(join(homedir(), ".config", "tecode"));
  });
});

describe("getUserConfigDir — Windows", () => {
  beforeEach(() => setPlatform("win32"));

  test("resolves to %APPDATA%\\tecode when APPDATA is set", () => {
    process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
    expect(getUserConfigDir()).toBe(
      join("C:\\Users\\test\\AppData\\Roaming", "tecode"),
    );
  });

  test("falls back to ~/AppData/Roaming/tecode when APPDATA is unset", () => {
    delete process.env["APPDATA"];
    expect(getUserConfigDir()).toBe(
      join(homedir(), "AppData", "Roaming", "tecode"),
    );
  });
});

describe("derived file paths", () => {
  beforeEach(() => setPlatform("linux"));

  test("getUserSettingsPath appends settings.json to the config dir", () => {
    expect(getUserSettingsPath()).toBe(join(getUserConfigDir(), "settings.json"));
  });

  test("getUserKeybindingsPath appends keybindings.json to the config dir", () => {
    expect(getUserKeybindingsPath()).toBe(
      join(getUserConfigDir(), "keybindings.json"),
    );
  });

  test("getWorkspaceSettingsPath appends .tecode/settings.json to the workspace root", () => {
    expect(getWorkspaceSettingsPath("/home/user/project")).toBe(
      join("/home/user/project", ".tecode", "settings.json"),
    );
  });

  test("getUserExtensionsDir appends extensions to the config dir", () => {
    expect(getUserExtensionsDir()).toBe(join(getUserConfigDir(), "extensions"));
  });

  test("getWorkspaceExtensionsDir appends .tecode/extensions to the workspace root", () => {
    expect(getWorkspaceExtensionsDir("/home/user/project")).toBe(
      join("/home/user/project", ".tecode", "extensions"),
    );
  });
});
