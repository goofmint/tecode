import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest } from "@tecode/api";
import type { LoadedExtension } from "@tecode/core";
import { buildExtensionDirMap, buildExtensionRecord, buildExtensionRecords } from "./extensionRecords";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tecode-ext-records-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

function fixtureManifest(id: string): Manifest {
  return { id, version: "0.0.1", apiVersion: "1.0", activationEvents: ["onStartup"], contributes: {} };
}

test("a user/workspace extension's extensionUri/storagePath derive from its real directory", async () => {
  const extensionsDir = await makeTempDir();
  const extensionDir = join(extensionsDir, "demo");
  await mkdir(extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.ts");
  await writeFile(manifestPath, "export default {}\n", "utf8");

  const loaded: LoadedExtension = {
    extensionId: "demo",
    manifest: fixtureManifest("demo"),
    source: "user",
    sourcePath: manifestPath,
  };

  const record = buildExtensionRecord(loaded);
  expect(record.id).toBe("demo");
  expect(record.extensionUri).toBe(pathToFileURL(extensionDir).href);
  expect(record.storagePath.endsWith(join("extension-storage", "demo"))).toBe(true);
});

test("loadModule() dynamically imports index.ts when no index.js exists", async () => {
  const extensionsDir = await makeTempDir();
  const extensionDir = join(extensionsDir, "demo");
  await mkdir(extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.ts");
  await writeFile(manifestPath, "export default {}\n", "utf8");
  await writeFile(
    join(extensionDir, "index.ts"),
    'export const MARKER = "index-ts-loaded";\nexport function activate() {}\n',
    "utf8",
  );

  const loaded: LoadedExtension = {
    extensionId: "demo",
    manifest: fixtureManifest("demo"),
    source: "user",
    sourcePath: manifestPath,
  };

  const record = buildExtensionRecord(loaded);
  const mod = (await record.loadModule()) as { MARKER: string; activate: () => void };
  expect(mod.MARKER).toBe("index-ts-loaded");
  expect(typeof mod.activate).toBe("function");
});

test("loadModule() prefers a pre-bundled index.js over index.ts (design.md §4.4)", async () => {
  const extensionsDir = await makeTempDir();
  const extensionDir = join(extensionsDir, "demo");
  await mkdir(extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.ts");
  await writeFile(manifestPath, "export default {}\n", "utf8");
  await writeFile(join(extensionDir, "index.ts"), 'export const MARKER = "ts";\n', "utf8");
  await writeFile(join(extensionDir, "index.js"), 'export const MARKER = "js";\n', "utf8");

  const loaded: LoadedExtension = {
    extensionId: "demo",
    manifest: fixtureManifest("demo"),
    source: "workspace",
    sourcePath: manifestPath,
  };

  const record = buildExtensionRecord(loaded);
  const mod = (await record.loadModule()) as { MARKER: string };
  expect(mod.MARKER).toBe("js");
});

test("a builtin extension's loadModule() rejects with a clear, documented error", async () => {
  const loaded: LoadedExtension = {
    extensionId: "fake-builtin",
    manifest: fixtureManifest("fake-builtin"),
    source: "builtin",
    sourcePath: "<builtin>/fake-builtin",
  };

  const record = buildExtensionRecord(loaded);
  expect(record.extensionUri).toBe("<builtin>/fake-builtin");
  await expect(record.loadModule()).rejects.toThrow(/No static module wiring/);
});

test("buildExtensionRecords maps every LoadedExtension", async () => {
  const extensionsDir = await makeTempDir();
  const records = await Promise.all(
    ["a", "b"].map(async (id) => {
      const extensionDir = join(extensionsDir, id);
      await mkdir(extensionDir, { recursive: true });
      const manifestPath = join(extensionDir, "manifest.ts");
      await writeFile(manifestPath, "export default {}\n", "utf8");
      const loaded: LoadedExtension = {
        extensionId: id,
        manifest: fixtureManifest(id),
        source: "user",
        sourcePath: manifestPath,
      };
      return loaded;
    }),
  );

  const built = buildExtensionRecords(records);
  expect(built.map((r) => r.id)).toEqual(["a", "b"]);
});

test("buildExtensionDirMap resolves a user/workspace extension's real directory and a builtin's synthetic sourcePath", async () => {
  const extensionsDir = await makeTempDir();
  const extensionDir = join(extensionsDir, "demo");
  await mkdir(extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.ts");
  await writeFile(manifestPath, "export default {}\n", "utf8");

  const userExtension: LoadedExtension = {
    extensionId: "demo",
    manifest: fixtureManifest("demo"),
    source: "user",
    sourcePath: manifestPath,
  };
  const builtinExtension: LoadedExtension = {
    extensionId: "fake-builtin",
    manifest: fixtureManifest("fake-builtin"),
    source: "builtin",
    sourcePath: "<builtin>/fake-builtin",
  };

  const dirs = buildExtensionDirMap([userExtension, builtinExtension]);
  expect(dirs["demo"]).toBe(extensionDir);
  expect(dirs["fake-builtin"]).toBe("<builtin>/fake-builtin");
});
