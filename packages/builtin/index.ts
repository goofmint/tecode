/**
 * Aggregates every built-in extension's manifest into one array, for
 * `@tecode/core`'s `loadExtensions({ builtins, ... })` dependency (Req 2.1;
 * design.md §4.1, §4.4: "Built-ins are compiled into the binary as
 * ordinary imports [...] their manifest data in a static registry").
 *
 * `discovery.ts` never scans this package's directories off disk — a
 * built-in's manifest reaches the host as a plain compiled-in `import`,
 * not through the `user`/`workspace` filesystem-scanning path (which is
 * exactly why `discovery.ts`'s `DiscoveryDeps.builtins` exists as a
 * separate parameter rather than a third scanned directory).
 *
 * **`builtinModules`** (Task 2.3) is this same "compiled-in, not
 * filesystem-loaded" story for a built-in's actual `activate`/
 * `deactivate` implementation: `packages/cli/src/extensionRecords.ts`'s
 * `ExtensionRecord.loadModule` for a `source: "builtin"` extension has no
 * real directory to dynamically `import()` (`discovery.ts` gives built-ins
 * a synthetic `<builtin>/<id>` `sourcePath`) — it looks `extensionId` up in
 * this map instead, so adding a built-in here is "import its manifest AND
 * its module, push the manifest, add the module to the map" — one
 * composition point for both halves, not two separate wiring sites to keep
 * in sync.
 *
 * Every other `packages/builtin/*` package (`command-palette`, `explorer`,
 * `keybindings-editor`, `languages-basic`, `statusbar`, `themes-default`)
 * is still a placeholder with no `manifest.ts` — each is its own later
 * task (tasks.md's Phase 2/3 built-in tasks).
 */

import type { ExtensionContext, Manifest } from "@tecode/api";
import * as editorCoreModule from "./editor-core/index";
import editorCoreManifest from "./editor-core/manifest";

/**
 * The `activate(ctx)`/`deactivate()` shape a built-in's `index.ts` exports
 * (Req 2.6) — `@tecode/core`'s `host/activation.ts` `ExtensionModule`
 * structurally, duplicated locally since `@tecode/api` declares no such
 * type (an extension module's shape is a host/runtime concern, not part of
 * the public API surface extensions program against) and `editor-core`
 * cannot import `@tecode/core` (the ESLint layering rule).
 */
interface BuiltinExtensionModule {
  activate?(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Every built-in extension's manifest, compiled in as a static import
 * (this module's TSDoc). */
export const builtinManifests: Manifest[] = [editorCoreManifest];

/** Every built-in extension's real implementation module, keyed by
 * `manifest.id` (this module's TSDoc's `builtinModules`) — what
 * `extensionRecords.ts`'s `loadModule` resolves to for a built-in instead
 * of a dynamic `import()`. */
export const builtinModules: Record<string, BuiltinExtensionModule> = {
  [editorCoreManifest.id]: editorCoreModule,
};
