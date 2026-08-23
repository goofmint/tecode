/**
 * Builds `@tecode/core`'s `ExtensionRecord[]` from `loadExtensions`'s
 * `LoadedExtension[]` (Req 2.5, 2.6; design.md §4.2, §4.4) — the one piece
 * `host/activation.ts`'s own TSDoc calls out as deliberately *not* its
 * job: "the *how* [of loading an extension's implementation module] ...
 * is injected via `ExtensionRecord.loadModule` rather than performed here
 * ... production wiring of that closure is the ... assembly task." PR #53
 * moved the UI shell in ahead of that TSDoc's original guess at which task
 * would land it; this module is `packages/cli`'s Task 1.15 fulfilling it.
 *
 * **`loadModule()` performs a real dynamic `import()` of the extension's
 * `index.ts`/`.js`.** This is the designed composition-layer load path
 * (design.md §4.2, §4.4) — extension code can only be named once discovery
 * has scanned the filesystem and registration has validated the manifest,
 * exactly the same shape of necessity `discovery.ts`'s
 * `importManifestModule` documents for `manifest.ts`. `packages/cli` is
 * the one package the root `eslint.config.mjs` layering rule exempts from
 * its `@tecode/core` import/dynamic-import ban (`ignores:
 * ["packages/cli/**"]`), and that rule's `no-restricted-syntax` selector
 * only ever matches a dynamic import of the literal `"@tecode/core"`
 * specifier — a `file://` URL built from a real path found on disk during
 * this same startup's discovery scan does not match it — so this call
 * site needs no `eslint-disable` (one would be flagged as unused besides).
 */

import { stat as nodeStat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinModules } from "@tecode/builtin";
import { getUserConfigDir, type ExtensionRecord, type LoadedExtension } from "@tecode/core";

async function pathExists(path: string): Promise<boolean> {
  try {
    await nodeStat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Composition-layer extension-module load site (mirrors `discovery.ts`'s
 * `importManifestModule` TSDoc convention). `extensionDir` always comes
 * from a `LoadedExtension.sourcePath` this same process's `discover()`
 * call found on disk — never external/untrusted input passed straight
 * through from argv or a network source. Prefers a pre-bundled
 * `index.js` over `index.ts` when both exist (design.md §4.4: "Extensions
 * with npm dependencies ship a pre-bundled `index.js`; the host prefers
 * `index.js` over `index.ts` when both exist").
 */
async function loadUserOrWorkspaceModule(extensionDir: string): Promise<unknown> {
  const jsPath = join(extensionDir, "index.js");
  const target = (await pathExists(jsPath)) ? jsPath : join(extensionDir, "index.ts");
  return import(pathToFileURL(target).href);
}

/**
 * Build one {@link ExtensionRecord} from a `registration.ts`
 * `LoadedExtension`.
 *
 * - `user`/`workspace` extensions: `extensionUri`/`storagePath` derive from
 *   the extension's real directory (`dirname` of its manifest path), and
 *   `loadModule` dynamically imports `index.js`/`index.ts` from that same
 *   directory (this module's TSDoc).
 * - `builtin` extensions: `discovery.ts` gives these a synthetic
 *   `<builtin>/<id>` `sourcePath` (no real directory — design.md §4.4
 *   compiles built-ins in as static imports instead). `loadModule` for a
 *   builtin therefore looks `extensionId` up in `@tecode/builtin`'s
 *   `builtinModules` (Task 2.3) — a map from manifest id to its compiled-in
 *   `activate`/`deactivate` module, the built-in-side counterpart to
 *   `builtinManifests` — rather than dynamically importing a path that was
 *   never a real file. A builtin id with no entry there (a manifest added
 *   to `builtinManifests` before its module is wired into `builtinModules`
 *   — should not happen, but this is host-boundary code, so it degrades
 *   the same way an external extension's genuinely-missing module would:
 *   a rejected `loadModule` that `host/activation.ts` reports and marks
 *   `"failed"`, not a startup crash) reports a clear error instead.
 */
/**
 * The extension's real directory (Req 7.1, this module's TSDoc) —
 * factored out of {@link buildExtensionRecord} so
 * {@link buildExtensionDirMap} (Task 2.6's `ThemeRegistry.loadContributions`
 * caller, `main.ts`) resolves a manifest theme's `path` against the exact
 * same directory `loadModule`'s dynamic `import()` uses, rather than
 * re-deriving it with slightly different logic.
 */
function resolveExtensionDir(extension: LoadedExtension): string {
  return extension.source === "builtin" ? extension.sourcePath : dirname(extension.sourcePath);
}

export function buildExtensionRecord(extension: LoadedExtension): ExtensionRecord {
  const isBuiltin = extension.source === "builtin";
  const extensionDir = resolveExtensionDir(extension);
  const extensionUri = isBuiltin ? extension.sourcePath : pathToFileURL(extensionDir).href;
  const storagePath = join(getUserConfigDir(), "extension-storage", extension.extensionId);

  return {
    id: extension.extensionId,
    manifest: extension.manifest,
    extensionUri,
    storagePath,
    loadModule: () => {
      if (!isBuiltin) return loadUserOrWorkspaceModule(extensionDir);
      const module = builtinModules[extension.extensionId];
      return module
        ? Promise.resolve(module)
        : Promise.reject(
            new Error(
              `No static module wiring for built-in extension "${extension.extensionId}" ` +
                `(missing from @tecode/builtin's builtinModules — see extensionRecords.ts's TSDoc).`,
            ),
          );
    },
  };
}

/** Build every {@link ExtensionRecord} for {@link createExtensionHost}
 * (`@tecode/core`) from `loadExtensions`'s `LoadedExtension[]`. */
export function buildExtensionRecords(loaded: readonly LoadedExtension[]): ExtensionRecord[] {
  return loaded.map(buildExtensionRecord);
}

/**
 * Build the `extensionId -> directory` map `@tecode/core`'s
 * `ThemeRegistry.loadContributions` needs to resolve each manifest theme's
 * `path` (Task 2.6, Req 7.1) — the same {@link resolveExtensionDir} this
 * module already uses for `loadModule`'s dynamic `import()`, keyed by
 * `extensionId` instead of consumed inline per-record.
 */
export function buildExtensionDirMap(loaded: readonly LoadedExtension[]): Record<string, string> {
  const dirs: Record<string, string> = {};
  for (const extension of loaded) {
    dirs[extension.extensionId] = resolveExtensionDir(extension);
  }
  return dirs;
}
