/**
 * Extension discovery (Req 2.1, 2.2, design.md §4.1): scans, in order, the
 * embedded built-ins, the user extensions directory, and (when a workspace
 * is open) the workspace extensions directory, loading each discovered
 * extension's `manifest.ts`/`manifest.js` without ever executing its
 * `index.ts`.
 *
 * This module owns the ONE sanctioned dynamic-import call site in the
 * codebase — see {@link importManifestModule}'s TSDoc — required because an
 * extension's manifest path is only known once the filesystem has been
 * scanned at runtime.
 *
 * **Trust boundary**: importing a `manifest.ts`/`manifest.js` module
 * evaluates that file's top-level code in the host process — for the
 * `workspace` source that means code committed to whatever repository the
 * user opened, before any validation has run. The manifest convention
 * (pure declarative data, enforced by `validate.ts` only *after* the
 * import) constrains what a well-behaved manifest contains, not what a
 * malicious one can execute. A workspace-trust gate (prompting before the
 * workspace layer is scanned at all) is the intended mitigation and is
 * deliberately out of this task's scope — it belongs to the CLI assembly
 * layer, which decides whether to pass `workspaceRoot` to {@link discover}
 * at all: omitting it skips the workspace layer entirely, so callers that
 * cannot yet establish trust already have the lever to withhold it.
 */

import { readdir as nodeReaddir, stat as nodeStat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest } from "@tecode/api";
import type { HostError, HostLog } from "./errors";
import { getUserExtensionsDir, getWorkspaceExtensionsDir } from "./paths";

/** Where a discovered extension came from (Req 2.1, design.md §4.1):
 * built-ins are compiled into the binary; `user`/`workspace` are scanned
 * off disk. Duplicate IDs resolve later-wins in this same order —
 * `workspace` shadows `user` shadows `builtin`. */
export type ExtensionSource = "builtin" | "user" | "workspace";

/**
 * The narrow filesystem seam {@link discover} needs: enumerating a
 * directory's entries and telling directories from files. Exists as an
 * injectable seam (defaulting to `node:fs/promises`) so tests can simulate
 * scan failures deterministically, matching `DocumentManagerFs`/
 * `ConfigServiceFs`'s precedent. Not part of the public API surface.
 *
 * Note: this seam covers directory *scanning* only. Loading a manifest's
 * module contents goes through {@link DiscoveryDeps.importModule} (by
 * default the real dynamic `import()` — see {@link importManifestModule}).
 */
export interface DiscoveryFs {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

function createNodeDiscoveryFs(): DiscoveryFs {
  return {
    readdir: (path) => nodeReaddir(path),
    stat: async (path) => {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

/** One extension found by {@link discover}, before manifest validation
 * (Phase 2, `validate.ts`) — `manifest` is the raw, untyped default (or
 * named `manifest`) export of its manifest module. */
export interface DiscoveredExtension {
  /** A best-effort ID used for shadowing/logging before validation: the
   * raw manifest's `id` field when it is a non-empty string, otherwise the
   * extension's directory name (or a synthetic `builtin-<n>` for a
   * built-in whose supplied `Manifest.id` is somehow not a string). The
   * authoritative `id` comes from `validate.ts` once the manifest is
   * confirmed well-formed. */
  extensionId: string;
  /** The manifest module's raw export — not yet validated. */
  manifest: unknown;
  /** Where this extension's manifest came from: the manifest file path for
   * `user`/`workspace` extensions, or a synthetic `<builtin>/<id>` label
   * for built-ins (which have no filesystem path — Req 2.1, design.md
   * §4.4). Used only for error messages/attribution. */
  sourcePath: string;
  source: ExtensionSource;
}

/** Dependencies for {@link discover}. */
export interface DiscoveryDeps {
  /** Built-in extensions' manifests, compiled into the binary as ordinary
   * imports (design.md §4.1, §4.4) rather than discovered off disk.
   * Defaults to `[]` — `packages/builtin/*` are placeholders with no
   * `manifest.ts` yet (deviation noted in this task's plan), so callers
   * pass whatever static registry exists once built-ins gain manifests. */
  builtins?: Manifest[];
  /** The open workspace's root directory. The workspace extensions layer
   * is only scanned when this is provided — a single-file session with no
   * workspace has no third source. */
  workspaceRoot?: string;
  /** Filesystem seam — see {@link DiscoveryFs}. Defaults to
   * `node:fs/promises`. */
  fs?: DiscoveryFs;
  /** Manifest-module loading seam. Defaults to the sanctioned real
   * dynamic `import()` ({@link importManifestModule}); tests inject a
   * loader so manifest loading can be exercised against fixture
   * directories without ever writing to the real user extensions dir
   * (`~/.config/tecode/extensions`). Production callers never pass this. */
  importModule?: (fileUrl: string) => Promise<unknown>;
  /** Structured log for scan failures, missing manifests, load failures,
   * and duplicate-ID shadowing (design.md §14). */
  log: HostLog;
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`) from a caught unknown
 * (matches `documentManager.ts`'s/`service.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `registry.ts`'s/`documentManager.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` — an injected log must not be able to break
 * discovery (matches `registry.ts`'s `logSafely`). */
function logSafely(log: HostLog, level: "error" | "warning", err: HostError): void {
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/**
 * Best-effort ID for a not-yet-validated manifest export — see
 * {@link DiscoveredExtension.extensionId}'s TSDoc.
 */
function extractTentativeId(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object" && "id" in raw) {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return fallback;
}

/**
 * Pull the manifest data out of a loaded manifest module. The documented
 * convention (manifest.ts's own TSDoc, design.md §4.1) is `export default
 * {...} satisfies Manifest`; a named `manifest` export is also accepted as
 * a fallback so authors who prefer that form are not blocked, but `export
 * default` remains the one true convention emitted by any future
 * scaffolding/docs.
 */
function extractManifestExport(mod: unknown): unknown | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const record = mod as Record<string, unknown>;
  if ("default" in record && record.default !== undefined) return record.default;
  if ("manifest" in record && record.manifest !== undefined) return record.manifest;
  return undefined;
}

async function pathExists(path: string, fs: DiscoveryFs): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `manifest.ts` (preferred) or `manifest.js` inside an extension
 * directory (design.md §4.1); `undefined` if neither exists. */
async function resolveManifestPath(
  extensionDir: string,
  fs: DiscoveryFs,
): Promise<string | undefined> {
  const tsPath = join(extensionDir, "manifest.ts");
  if (await pathExists(tsPath, fs)) return tsPath;
  const jsPath = join(extensionDir, "manifest.js");
  if (await pathExists(jsPath, fs)) return jsPath;
  return undefined;
}

/**
 * Dynamically import a discovered extension's manifest module.
 *
 * **This is the ONE sanctioned exception to the repository-wide ban on
 * dynamic `import()`** (Req 2.2, design.md §4.1). Loading `manifest.ts`/
 * `manifest.js` for a third-party extension requires it: the path is only
 * known after scanning the filesystem at runtime, so no static `import`
 * can name it ahead of time. This is narrowly confined to this single
 * function:
 *
 * - Nothing else in `discovery.ts` (or anywhere else in `core`) performs a
 *   dynamic import.
 * - The extension's `index.ts` (activation code) is never imported this
 *   way, or at all, by discovery/registration — only `manifest.ts`/`.js`,
 *   which is constrained by convention and validation (`validate.ts`) to
 *   be pure declarative data.
 * - `fileUrl` always comes from {@link resolveManifestPath} inside this
 *   module — a `file://` URL built from a real path found on disk during
 *   this same scan, never external/untrusted input passed straight
 *   through from a caller.
 */
async function importManifestModule(fileUrl: string): Promise<unknown> {
  // NOTE on the repo's dynamic-import ban: eslint.config.mjs's
  // `no-restricted-syntax` rule only matches a dynamic `import()` of the
  // literal "@tecode/core" specifier (crossing the extension/core
  // boundary) — `fileUrl` here is a runtime-computed `file://` URL to a
  // manifest on disk, which that selector does not (and must not) match,
  // so no `eslint-disable` is required or added. This call site remains
  // the sole sanctioned dynamic import in the codebase by convention and
  // code review, not by a lint rule carve-out: nowhere else in `core`
  // dynamically imports anything, and this function is never called with
  // an `index.ts` path (Req 2.2, design.md §4.1).
  return import(fileUrl);
}

/** Scan one extensions directory (`user` or `workspace`): each immediate
 * subdirectory is one candidate extension (Req 2.1). A missing directory
 * is not an error — an extensions dir that was never created yields no
 * extensions from that source. Every other failure (a bad manifest, an
 * unreadable subdirectory, a directory that fails to enumerate) is
 * reported to `log` and that one extension (or the whole source) is
 * skipped; `scanExtensionsDir` itself never throws. */
async function scanExtensionsDir(
  dir: string,
  source: Exclude<ExtensionSource, "builtin">,
  fs: DiscoveryFs,
  log: HostLog,
  importModule: (fileUrl: string) => Promise<unknown>,
): Promise<DiscoveredExtension[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return [];
    logSafely(log, "warning", {
      message: `Failed to scan ${source} extensions directory (${dir}): ${describeError(cause)}`,
      path: dir,
    });
    return [];
  }

  const results: DiscoveredExtension[] = [];
  for (const name of entries) {
    const extensionDir = join(dir, name);

    let stats: { isDirectory(): boolean };
    try {
      stats = await fs.stat(extensionDir);
    } catch (cause) {
      logSafely(log, "warning", {
        message: `Could not inspect ${extensionDir}: ${describeError(cause)}`,
        path: extensionDir,
      });
      continue;
    }
    if (!stats.isDirectory()) continue;

    const manifestPath = await resolveManifestPath(extensionDir, fs);
    if (!manifestPath) {
      logSafely(log, "warning", {
        message: `Extension directory ${extensionDir} has no manifest.ts or manifest.js — skipped`,
        path: extensionDir,
      });
      continue;
    }

    let mod: unknown;
    try {
      mod = await importModule(pathToFileURL(manifestPath).href);
    } catch (cause) {
      logSafely(log, "error", {
        message: `Failed to load manifest at ${manifestPath}: ${describeError(cause)}`,
        path: manifestPath,
      });
      continue;
    }

    const raw = extractManifestExport(mod);
    if (raw === undefined) {
      logSafely(log, "error", {
        message:
          `Manifest at ${manifestPath} has no usable export (expected ` +
          `"export default {...} satisfies Manifest")`,
        path: manifestPath,
      });
      continue;
    }

    results.push({
      extensionId: extractTentativeId(raw, name),
      manifest: raw,
      sourcePath: manifestPath,
      source,
    });
  }
  return results;
}

/**
 * Discover extensions from all three sources, in precedence order —
 * built-in, then user, then workspace (Req 2.1) — and resolve duplicate
 * IDs later-wins, logging a warning for each one shadowed (design.md
 * §4.1: "Duplicate extension IDs resolve by discovery order — later wins
 * ... the shadowed one is reported as a warning").
 *
 * Never throws: every failure along the way (an unreadable extensions
 * directory, a subdirectory with no manifest, a manifest module that
 * throws on import, a manifest with no usable export) is reported to
 * `deps.log` and that one extension is skipped, so one bad extension can
 * never block the rest of startup (Req 2.4).
 */
export async function discover(deps: DiscoveryDeps): Promise<DiscoveredExtension[]> {
  const { log } = deps;
  const fs = deps.fs ?? createNodeDiscoveryFs();
  const importModule = deps.importModule ?? importManifestModule;
  const byId = new Map<string, DiscoveredExtension>();

  function addAll(discovered: DiscoveredExtension[]): void {
    for (const extension of discovered) {
      const existing = byId.get(extension.extensionId);
      if (existing) {
        logSafely(log, "warning", {
          extensionId: extension.extensionId,
          message:
            `Extension "${extension.extensionId}" from ${extension.source} ` +
            `(${extension.sourcePath}) shadows the version from ${existing.source} ` +
            `(${existing.sourcePath})`,
        });
      }
      byId.set(extension.extensionId, extension);
    }
  }

  const builtins = deps.builtins ?? [];
  addAll(
    builtins.map((manifest, index) => {
      const extensionId = extractTentativeId(manifest, `builtin-${index}`);
      return {
        extensionId,
        manifest,
        sourcePath: `<builtin>/${extensionId}`,
        source: "builtin" as const,
      };
    }),
  );

  addAll(await scanExtensionsDir(getUserExtensionsDir(), "user", fs, log, importModule));

  if (deps.workspaceRoot) {
    // Trust boundary (see the module TSDoc): scanning the workspace layer
    // imports manifest modules committed to the opened repository. Callers
    // that cannot establish workspace trust must omit `workspaceRoot`.
    addAll(
      await scanExtensionsDir(
        getWorkspaceExtensionsDir(deps.workspaceRoot),
        "workspace",
        fs,
        log,
        importModule,
      ),
    );
  }

  return Array.from(byId.values());
}
