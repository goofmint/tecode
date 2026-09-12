/**
 * Unit tests for {@link scanUserThemes} (Req 11.4, Issue #124;
 * `userThemes.ts`'s own TSDoc for the full "why"). Exercises the real
 * filesystem against temp directories — `themesDir`'s own injectable seam
 * (`ScanUserThemesDeps.themesDir`) makes this straightforward and more
 * reliable than a `HOME`/`APPDATA` override would be (`main.test.ts`'s
 * `createHermeticDiscoveryFs` TSDoc documents Bun's `os.homedir()`
 * ignoring a runtime `process.env.HOME` mutation on POSIX) — plus a
 * couple of `UserThemesFs` fakes for failure modes that are awkward to
 * reproduce with a real filesystem (an individual file that reads-fails
 * without the directory itself being unreadable).
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostLog } from "@tecode/core";
import {
  loadThemeFileOverride,
  scanUserThemes,
  USER_THEMES_EXTENSION_ID,
  type ThemeFileOverrideFs,
  type UserThemesFs,
} from "./userThemes";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tecode-user-themes-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("scanUserThemes (Req 11.4, Issue #124)", () => {
  test("a missing themes directory (ENOENT) returns an empty result, not an error", async () => {
    await withTempDir(async (dir) => {
      const log = createHostLog();
      const result = await scanUserThemes({ themesDir: join(dir, "no-such-dir"), log });
      expect(result).toEqual({ pending: [], extensionDirs: {} });
      // ENOENT is the expected, unremarkable case (this module's TSDoc) —
      // it must not itself produce a HostLog warning.
      expect(log.entries()).toEqual([]);
    });
  });

  test("an empty themes directory returns an empty result", async () => {
    await withTempDir(async (dir) => {
      const result = await scanUserThemes({ themesDir: dir });
      expect(result).toEqual({ pending: [], extensionDirs: {} });
    });
  });

  test("one *.json file becomes one PendingThemeContribution, id = filename stem, label = stem when the JSON has no name", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "my-theme.json"), JSON.stringify({ colors: {} }), "utf8");
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending).toEqual([
        {
          extensionId: USER_THEMES_EXTENSION_ID,
          theme: { id: "my-theme", label: "my-theme", path: "my-theme.json" },
        },
      ]);
      expect(result.extensionDirs).toEqual({ [USER_THEMES_EXTENSION_ID]: dir });
    });
  });

  test("the JSON's top-level \"name\" string is used as the label when present", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "light-modern.json"),
        JSON.stringify({ name: "Light Modern", colors: {} }),
        "utf8",
      );
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending).toEqual([
        {
          extensionId: USER_THEMES_EXTENSION_ID,
          theme: { id: "light-modern", label: "Light Modern", path: "light-modern.json" },
        },
      ]);
    });
  });

  test("a non-string \"name\" falls back to the filename stem", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "odd.json"), JSON.stringify({ name: 42, colors: {} }), "utf8");
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending[0]?.theme.label).toBe("odd");
    });
  });

  test("multiple *.json files each become their own contribution, all sharing one extensionDirs entry", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.json"), JSON.stringify({ colors: {} }), "utf8");
      await writeFile(join(dir, "b.json"), JSON.stringify({ name: "B Theme", colors: {} }), "utf8");
      const result = await scanUserThemes({ themesDir: dir });
      const ids = result.pending.map((p) => p.theme.id).sort();
      expect(ids).toEqual(["a", "b"]);
      expect(result.extensionDirs).toEqual({ [USER_THEMES_EXTENSION_ID]: dir });
    });
  });

  test("non-.json files in the directory are ignored", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "theme.json"), JSON.stringify({ colors: {} }), "utf8");
      await writeFile(join(dir, "README.md"), "not a theme", "utf8");
      await mkdir(join(dir, "subdir"));
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending.map((p) => p.theme.id)).toEqual(["theme"]);
    });
  });

  test("CodeRabbit PR #133: an uppercase .JSON extension is stripped from the id, matching the case-insensitive filter that accepted the file", async () => {
    await withTempDir(async (dir) => {
      // The directory filter accepts the extension case-insensitively, so
      // `ocean.JSON` IS collected; stripping it case-sensitively left the
      // extension on the id (`"ocean.JSON"`), which is what the user would
      // then have had to type into `workbench.colorTheme`.
      await writeFile(join(dir, "ocean.JSON"), JSON.stringify({ colors: {} }), "utf8");
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending.map((p) => p.theme.id)).toEqual(["ocean"]);
      expect(result.pending[0]!.theme.label).toBe("ocean");
    });
  });

  test("malformed JSON in a readable file still registers a pending contribution (falls back to the stem label; the real parse/degrade happens later in ThemeRegistry.loadContributions)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "broken.json"), "{ not valid json", "utf8");
      const result = await scanUserThemes({ themesDir: dir });
      expect(result.pending).toEqual([
        {
          extensionId: USER_THEMES_EXTENSION_ID,
          theme: { id: "broken", label: "broken", path: "broken.json" },
        },
      ]);
    });
  });

  test("a file that fails to read is skipped individually, with a HostLog warning, without failing the whole scan", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "good.json"), JSON.stringify({ name: "Good", colors: {} }), "utf8");
      const log = createHostLog();
      const fs: UserThemesFs = {
        readdir: (path) => Promise.resolve(["good.json", "bad.json"]).then((entries) => (path === dir ? entries : [])),
        readFile: (path) => {
          if (path.endsWith("bad.json")) {
            return Promise.reject(new Error("EACCES: permission denied"));
          }
          return Promise.resolve(JSON.stringify({ name: "Good", colors: {} }));
        },
      };
      const result = await scanUserThemes({ themesDir: dir, fs, log });
      expect(result.pending).toEqual([
        {
          extensionId: USER_THEMES_EXTENSION_ID,
          theme: { id: "good", label: "Good", path: "good.json" },
        },
      ]);
      expect(log.entries()).toHaveLength(1);
      expect(log.entries()[0]?.level).toBe("warning");
      expect(log.entries()[0]?.error.message).toContain("bad.json");
    });
  });

  test("a non-ENOENT readdir failure (e.g. permission denied on the directory itself) degrades to empty, with a HostLog warning", async () => {
    const log = createHostLog();
    const fs: UserThemesFs = {
      readdir: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })),
      readFile: () => Promise.reject(new Error("unreachable")),
    };
    const result = await scanUserThemes({ themesDir: "/some/dir", fs, log });
    expect(result).toEqual({ pending: [], extensionDirs: {} });
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]?.level).toBe("warning");
  });

  test("defaults themesDir to getUserThemesDir() when not overridden (production shape — just checked for no throw here)", async () => {
    // Not asserting a specific result: this exercises the real
    // `node:fs/promises` default seam against whatever `getUserThemesDir()`
    // resolves to on this machine — likely ENOENT, possibly a real
    // directory if the developer has one. Either way `scanUserThemes` must
    // never reject.
    await expect(scanUserThemes()).resolves.toBeDefined();
  });
});

describe("loadThemeFileOverride (Req 7.6, Issue #149)", () => {
  test("a real theme file becomes a PendingThemeContribution, id = filename stem, label = the JSON's own name", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "my-theme.json");
      await writeFile(path, JSON.stringify({ name: "My Theme", colors: {} }), "utf8");

      const contribution = await loadThemeFileOverride(path);
      expect(contribution).toEqual({
        extensionId: USER_THEMES_EXTENSION_ID,
        theme: { id: "my-theme", label: "My Theme", path },
      });
    });
  });

  test("label falls back to the filename stem when the JSON has no name", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "ocean.json");
      await writeFile(path, JSON.stringify({ colors: {} }), "utf8");

      const contribution = await loadThemeFileOverride(path);
      expect(contribution?.theme.label).toBe("ocean");
    });
  });

  test("an unreadable file returns undefined rather than throwing", async () => {
    const fs: ThemeFileOverrideFs = {
      readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    };
    const contribution = await loadThemeFileOverride("/does/not/exist.json", { fs });
    expect(contribution).toBeUndefined();
  });

  test("the returned path is used as-is (an absolute path, not joined against any directory)", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "sub", "nested-theme.json");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(path, JSON.stringify({ colors: {} }), "utf8");

      const contribution = await loadThemeFileOverride(path);
      expect(contribution?.theme.path).toBe(path);
      expect(contribution?.theme.id).toBe("nested-theme");
    });
  });
});
