/**
 * Tests for {@link applyColorThemeSetting}/{@link createThemeSettingsWriter}
 * (Req 7.5).
 */

import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../config/jsonc";
import {
  applyColorThemeSetting,
  createThemeSettingsWriter,
  type ThemeSettingsWriterFs,
} from "./themeSettingsWriter";

describe("applyColorThemeSetting (Req 7.5, text-replace)", () => {
  test("replaces an existing key's value in place, byte-for-byte elsewhere", () => {
    const before = `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.colorTheme": "old-theme",\n  "editor.wordWrap": true\n}\n`;
    const after = applyColorThemeSetting(before, "new-theme");
    expect(after).toBe(
      `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.colorTheme": "new-theme",\n  "editor.wordWrap": true\n}\n`,
    );
  });

  test("appends the key when absent, into an object with existing keys", () => {
    const before = `{\n  "editor.tabSize": 2\n}\n`;
    const after = applyColorThemeSetting(before, "dark");
    expect(after).toBe(`{\n  "workbench.colorTheme": "dark",\n  "editor.tabSize": 2\n}\n`);
    // Still parses correctly (JSONC tolerates the trailing comma our own
    // parser strips — this module's TSDoc).
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe("dark");
  });

  test("appends the key into an otherwise-empty object", () => {
    const after = applyColorThemeSetting("{}\n", "dark");
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.colorTheme"]).toBe("dark");
      expect(Object.keys(parsed.value)).toEqual(["workbench.colorTheme"]);
    }
  });

  test("falls back to a fresh minimal file when there is no object to insert into", () => {
    const after = applyColorThemeSetting("", "dark");
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe("dark");
  });

  test("encodes the theme id as a JSON string (escaping included)", () => {
    const after = applyColorThemeSetting("{}\n", 'weird "id"');
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe('weird "id"');
  });

  test("replaces an existing null value in place rather than appending a duplicate key (regression)", () => {
    const before = `{\n  "editor.tabSize": 2,\n  "workbench.colorTheme": null,\n  "editor.wordWrap": true\n}\n`;
    const after = applyColorThemeSetting(before, "dark");
    expect(after).toBe(
      `{\n  "editor.tabSize": 2,\n  "workbench.colorTheme": "dark",\n  "editor.wordWrap": true\n}\n`,
    );
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.colorTheme"]).toBe("dark");
      // Exactly one occurrence of the key — no duplicate was appended.
      expect(after.match(/"workbench\.colorTheme"/g)).toHaveLength(1);
    }
  });

  test("replaces an existing numeric value in place rather than appending a duplicate key (regression)", () => {
    const before = `{\n  "workbench.colorTheme": 123,\n  "editor.tabSize": 2\n}\n`;
    const after = applyColorThemeSetting(before, "dark");
    expect(after).toBe(`{\n  "workbench.colorTheme": "dark",\n  "editor.tabSize": 2\n}\n`);
    expect(after.match(/"workbench\.colorTheme"/g)).toHaveLength(1);
  });

  test("inserts the key after the real opening brace, not one that appears inside a leading comment (regression)", () => {
    const before = `// tip: use { }\n{\n  "editor.tabSize": 2\n}\n`;
    const after = applyColorThemeSetting(before, "dark");
    // The comment itself must survive untouched, exactly as written.
    expect(after.startsWith("// tip: use { }\n")).toBe(true);
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.colorTheme"]).toBe("dark");
      expect(parsed.value["editor.tabSize"]).toBe(2);
    }
  });

  test("does not disturb a same-named key inside a comment or a different key sharing a suffix", () => {
    // "notWorkbench.colorTheme" must not accidentally match the regex used
    // for the real "workbench.colorTheme" key — this exercises that the
    // literal key match requires the exact leading quote.
    const before = `{\n  "notWorkbench.colorTheme": "untouched"\n}\n`;
    const after = applyColorThemeSetting(before, "dark");
    expect(after).toContain('"notWorkbench.colorTheme": "untouched"');
    expect(after).toContain('"workbench.colorTheme": "dark"');
  });
});

function createFakeFs(initial: Record<string, string>): { fs: ThemeSettingsWriterFs; files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    fs: {
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) {
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }
        return Promise.resolve(text);
      },
      mkdir: () => Promise.resolve(),
      writeFile: (path, data) => {
        files[path] = data;
        return Promise.resolve();
      },
    },
  };
}

describe("createThemeSettingsWriter (Req 7.5)", () => {
  test("writes a fresh file when settings.json does not exist yet", async () => {
    const { fs, files } = createFakeFs({});
    const writer = createThemeSettingsWriter({ path: "/settings.json", fs });
    await writer.write("dark");
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe("dark");
  });

  test("preserves the rest of an existing settings.json", async () => {
    const before = `{\n  "editor.tabSize": 8,\n  "workbench.colorTheme": "old"\n}\n`;
    const { fs, files } = createFakeFs({ "/settings.json": before });
    const writer = createThemeSettingsWriter({ path: "/settings.json", fs });
    await writer.write("dark");
    expect(files["/settings.json"]).toBe(
      `{\n  "editor.tabSize": 8,\n  "workbench.colorTheme": "dark"\n}\n`,
    );
  });

  test("serializes concurrent write() calls — the last one wins deterministically", async () => {
    const { fs, files } = createFakeFs({ "/settings.json": "{}\n" });
    const writer = createThemeSettingsWriter({ path: "/settings.json", fs });
    await Promise.all([writer.write("a"), writer.write("b"), writer.write("c")]);
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.colorTheme"]).toBe("c");
  });

  test("a read failure (not ENOENT) reports through log/sink and resolves without throwing", async () => {
    const fs: ThemeSettingsWriterFs = {
      readFile: () => Promise.reject(new Error("disk on fire")),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
    };
    const messages: string[] = [];
    const writer = createThemeSettingsWriter({
      path: "/settings.json",
      fs,
      sink: { error: (e) => messages.push(e.message) },
    });
    await expect(writer.write("dark")).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  test("a write failure reports through log/sink and resolves without throwing", async () => {
    const fs: ThemeSettingsWriterFs = {
      readFile: () => Promise.resolve("{}\n"),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.reject(new Error("disk full")),
    };
    const messages: string[] = [];
    const writer = createThemeSettingsWriter({
      path: "/settings.json",
      fs,
      sink: { error: (e) => messages.push(e.message) },
    });
    await expect(writer.write("dark")).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });
});
