import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir as nodeReaddir,
  rm,
  rmdir,
  stat as nodeStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Manifest } from "@tecode/api";
import type { HostError, HostLogEntry } from "./errors";
import { createHostLog } from "./errors";
import { discover, type DiscoveryFs } from "./discovery";
import { getUserExtensionsDir } from "./paths";

/** Every temp dir created by a test, cleaned up afterward regardless of
 * pass/fail (matches `documentManager.test.ts`'s `dir`/`afterEach`
 * pattern, extended to a list since several tests need more than one
 * root). */
let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

/**
 * A {@link DiscoveryFs} backed by the real filesystem, EXCEPT the real
 * user extensions directory (`getUserExtensionsDir()`), which is always
 * reported as missing (ENOENT) unless remapped — so every test here is
 * hermetic regardless of what (if anything) actually lives under the host
 * machine's real `~/.config/tecode/extensions`, and independent of Bun's
 * `os.homedir()`, which — unlike Node's — does not honor a runtime
 * `$HOME` mutation (verified: `process.env.HOME = x; homedir()` still
 * returns the process's original home directory under Bun), so the
 * env-var-redirection trick `config/service.test.ts` uses for a similar
 * purpose does not actually work here.
 *
 * `remap` lets one test substitute a real temp directory in place of one
 * blocked/real path (e.g. standing in for the user extensions dir with a
 * fixture the test controls), while every other path still hits the real
 * filesystem untouched — needed because manifest loading always performs
 * a real dynamic `import()` against whatever path `resolveManifestPath`
 * computes, so a fully in-memory fake `fs` cannot exercise a successful
 * load.
 */
function createHermeticFs(remap: ReadonlyMap<string, string> = new Map()): DiscoveryFs {
  const blockedUserDir = getUserExtensionsDir();

  function resolve(path: string): string {
    for (const [from, to] of remap) {
      if (path === from) return to;
      if (path.startsWith(from + sep)) return to + path.slice(from.length);
    }
    return path;
  }

  return {
    async readdir(path) {
      if (path === blockedUserDir && !remap.has(blockedUserDir)) {
        throw Object.assign(new Error("ENOENT (blocked for test hermeticity)"), {
          code: "ENOENT",
        });
      }
      return nodeReaddir(resolve(path));
    },
    async stat(path) {
      const stats = await nodeStat(resolve(path));
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

/** Write a real `<extensionsDir>/<name>/<filename>` fixture. Real files
 * are required because manifest loading always goes through a real
 * dynamic `import()` (Req 2.2, design.md §4.1), never the injectable
 * `DiscoveryFs` seam (which only covers directory scanning). */
async function writeManifestFixture(
  extensionsDir: string,
  name: string,
  manifestSource: string,
  filename = "manifest.ts",
): Promise<string> {
  const extensionDir = join(extensionsDir, name);
  await mkdir(extensionDir, { recursive: true });
  const path = join(extensionDir, filename);
  await writeFile(path, manifestSource, "utf8");
  return extensionDir;
}

/** A manifest literal as TypeScript source (`as const` only parses when
 * Bun transpiles a `.ts` file — see {@link manifestLiteralJs} for the
 * `.js`-safe form). */
function manifestLiteral(id: string, overrides: Partial<Manifest> = {}): string {
  const manifest: Manifest = {
    id,
    version: "1.0.0",
    apiVersion: "1.0",
    activationEvents: ["onStartup"],
    contributes: {},
    ...overrides,
  };
  return `export default ${JSON.stringify(manifest)} as const;\n`;
}

/** A manifest literal as plain JS source (no `as const` — that is TS-only
 * syntax and a real `.js` file is parsed as plain JS, not transpiled). */
function manifestLiteralJs(id: string, overrides: Partial<Manifest> = {}): string {
  const manifest: Manifest = {
    id,
    version: "1.0.0",
    apiVersion: "1.0",
    activationEvents: ["onStartup"],
    contributes: {},
    ...overrides,
  };
  return `export default ${JSON.stringify(manifest)};\n`;
}

function warnings(entries: readonly HostLogEntry[]): HostError[] {
  return entries.filter((e) => e.level === "warning").map((e) => e.error);
}

function errorEntries(entries: readonly HostLogEntry[]): HostError[] {
  return entries.filter((e) => e.level === "error").map((e) => e.error);
}

describe("discover — no sources", () => {
  test("returns [] when there are no builtins, no user extensions, and no workspace", async () => {
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs() });

    expect(result).toEqual([]);
    expect(log.entries()).toEqual([]);
  });
});

describe("discover — scan order and path wiring (Req 2.1)", () => {
  test("scans builtin, then user, then workspace, using the documented directory helpers", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const calls: string[] = [];
    const fs: DiscoveryFs = {
      async readdir(path) {
        calls.push(path);
        return [];
      },
      async stat() {
        return { isDirectory: () => true };
      },
    };
    const log = createHostLog();

    await discover({ log, fs, workspaceRoot: workspace, builtins: [] });

    // Built-ins need no directory scan at all (they're passed in
    // directly), so the only two readdir calls are user then workspace,
    // in that order.
    expect(calls).toEqual([
      getUserExtensionsDir(),
      join(workspace, ".tecode", "extensions"),
    ]);
  });
});

describe("discover — builtins", () => {
  test("includes builtins passed in, with source 'builtin'", async () => {
    const log = createHostLog();
    const builtin: Manifest = {
      id: "builtin.demo",
      version: "0.1.0",
      apiVersion: "1.0",
      activationEvents: ["onStartup"],
      contributes: {},
    };

    const result = await discover({ log, fs: createHermeticFs(), builtins: [builtin] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ extensionId: "builtin.demo", source: "builtin" });
    expect(result[0]?.manifest).toEqual(builtin);
  });
});

describe("discover — workspace extensions", () => {
  test("finds a real manifest.ts under <workspaceRoot>/.tecode/extensions", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(extensionsDir, "demo", manifestLiteral("workspace.demo"));
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toHaveLength(1);
    const found = result[0];
    expect(found?.extensionId).toBe("workspace.demo");
    expect(found?.source).toBe("workspace");
    expect(found?.sourcePath).toBe(join(extensionsDir, "demo", "manifest.ts"));
    expect((found?.manifest as Manifest).version).toBe("1.0.0");
  });

  test("accepts a named 'manifest' export as a fallback to 'export default'", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    const manifest: Manifest = {
      id: "named.export",
      version: "1.0.0",
      apiVersion: "1.0",
      activationEvents: ["onStartup"],
      contributes: {},
    };
    await writeManifestFixture(
      extensionsDir,
      "demo",
      `export const manifest = ${JSON.stringify(manifest)} as const;\n`,
    );
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toHaveLength(1);
    expect(result[0]?.extensionId).toBe("named.export");
  });

  test("falls back to manifest.js when manifest.ts is absent", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(extensionsDir, "demo", manifestLiteralJs("js.demo"), "manifest.js");
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toHaveLength(1);
    expect(result[0]?.extensionId).toBe("js.demo");
    expect(result[0]?.sourcePath.endsWith("manifest.js")).toBe(true);
  });

  test("skips a non-directory entry in the extensions dir without crashing", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "README.md"), "not an extension", "utf8");
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toEqual([]);
  });

  test("skips (and logs) an extension directory with no manifest.ts or manifest.js", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions", "empty");
    await mkdir(extensionsDir, { recursive: true });
    const log = createHostLog();

    const result = await discover({
      log,
      fs: createHermeticFs(),
      workspaceRoot: join(workspace),
    });

    expect(result).toEqual([]);
    const warned = warnings(log.entries());
    expect(warned.some((e) => e.message.includes("no manifest.ts or manifest.js"))).toBe(true);
  });

  test("skips (and logs) a manifest module that throws on import, but keeps scanning", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(extensionsDir, "broken", 'throw new Error("boom");\n');
    await writeManifestFixture(extensionsDir, "fine", manifestLiteral("still.fine"));
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toHaveLength(1);
    expect(result[0]?.extensionId).toBe("still.fine");
    const errs = errorEntries(log.entries());
    expect(errs.some((e) => e.message.includes("boom") && e.path?.includes("broken"))).toBe(true);
  });

  test("skips (and logs) a manifest module with no default or named 'manifest' export", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    await writeManifestFixture(extensionsDir, "nothing", "export const somethingElse = 1;\n");
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toEqual([]);
    const errs = errorEntries(log.entries());
    expect(errs.some((e) => e.message.includes("no usable export"))).toBe(true);
  });

  test("never imports the extension's index.ts", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");
    const extensionsDir = join(workspace, ".tecode", "extensions");
    const extensionDir = await writeManifestFixture(
      extensionsDir,
      "demo",
      manifestLiteral("proof.demo"),
    );
    const markerPath = join(extensionDir, "MARKER");
    await writeFile(
      join(extensionDir, "index.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "imported");\n`,
      "utf8",
    );
    const log = createHostLog();

    const result = await discover({ log, fs: createHermeticFs(), workspaceRoot: workspace });

    expect(result).toHaveLength(1);
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });
});

describe("discover — duplicate IDs across sources", () => {
  test("workspace shadows user shadows builtin (later wins), and every shadow logs a warning", async () => {
    const workspace = await makeTempDir("tecode-discover-ws-");

    // This one test needs a genuine "user" source manifest loaded via a
    // genuine dynamic import (Req 2.2), which — unlike every other test in
    // this file — cannot go through `createHermeticFs`'s remap: manifest
    // loading always dynamic-imports the *unresolved* path
    // `resolveManifestPath` computed (by design — see discovery.ts's
    // module TSDoc: only directory scanning goes through the injectable
    // `DiscoveryFs` seam), so a remapped `fs.stat`/`fs.readdir` cannot
    // redirect where the import itself reads from. The only way to
    // exercise a real "user" load is to place a real fixture at the real
    // `getUserExtensionsDir()` and clean it up afterward — this repo's
    // hermetic sandbox has no `~/.config/tecode/extensions` of its own
    // (verified before writing this test), and this test creates only its
    // own uniquely-named `dup` subdirectory there and removes exactly that
    // subdirectory again, win or lose.
    const realUserExtensionsDir = getUserExtensionsDir();
    const realUserDupDir = join(realUserExtensionsDir, "dup");
    await writeManifestFixture(
      realUserExtensionsDir,
      "dup",
      manifestLiteral("dup.ext", { version: "user-1.0.0" }),
    );

    try {
      const workspaceExtensionsDir = join(workspace, ".tecode", "extensions");
      await writeManifestFixture(
        workspaceExtensionsDir,
        "dup",
        manifestLiteral("dup.ext", { version: "workspace-1.0.0" }),
      );

      const builtin: Manifest = {
        id: "dup.ext",
        version: "builtin-1.0.0",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      };
      const log = createHostLog();

      // No `fs` override here: this test deliberately exercises the real
      // default filesystem seam end to end (real user dir included).
      const result = await discover({ log, builtins: [builtin], workspaceRoot: workspace });

      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("workspace");
      expect((result[0]?.manifest as Manifest).version).toBe("workspace-1.0.0");

      const warned = warnings(log.entries());
      const dupWarnings = warned.filter((e) => e.message.includes("dup.ext"));
      expect(dupWarnings).toHaveLength(2);
      expect(warned.some((e) => e.message.includes("shadows the version from builtin"))).toBe(
        true,
      );
      expect(warned.some((e) => e.message.includes("shadows the version from user"))).toBe(true);
    } finally {
      await rm(realUserDupDir, { recursive: true, force: true });
      // Best-effort: also remove the (now-empty, since this test created
      // them) parent directories, so a run leaves no trace at all when the
      // real user extensions dir didn't already exist. rmdir fails (and is
      // ignored) if the directory still has other content — unrelated to
      // this test, or pre-existing.
      await rmdir(realUserExtensionsDir).catch(() => {});
      await rmdir(join(realUserExtensionsDir, "..")).catch(() => {});
    }
  });
});

describe("discover — DiscoveryFs error handling (fake seam, no real dynamic import)", () => {
  function fakeFs(overrides: Partial<DiscoveryFs>): DiscoveryFs {
    return {
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => true }),
      ...overrides,
    };
  }

  test("a readdir failure that isn't ENOENT is logged as a warning and yields no extensions from that source", async () => {
    const log = createHostLog();
    const fs = fakeFs({
      readdir: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    const result = await discover({ log, fs, workspaceRoot: "/does/not/matter" });

    expect(result).toEqual([]);
    const warned = warnings(log.entries());
    expect(warned.some((e) => e.message.includes("Failed to scan"))).toBe(true);
  });

  test("an ENOENT readdir failure is treated as an empty source, with no log entry", async () => {
    const log = createHostLog();
    const fs = fakeFs({
      readdir: async () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });

    const result = await discover({ log, fs, workspaceRoot: "/does/not/matter" });

    expect(result).toEqual([]);
    expect(log.entries()).toEqual([]);
  });

  test("a stat failure on one entry is logged and that entry is skipped, without crashing", async () => {
    const log = createHostLog();
    const fs = fakeFs({
      readdir: async () => ["broken-entry"],
      stat: async () => {
        throw new Error("stat exploded");
      },
    });

    const result = await discover({ log, fs, workspaceRoot: "/does/not/matter" });

    expect(result).toEqual([]);
    const warned = warnings(log.entries());
    expect(warned.some((e) => e.message.includes("Could not inspect"))).toBe(true);
  });
});
