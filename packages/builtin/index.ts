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
 * **Today this is `[]`.** Every `packages/builtin/*` package
 * (`command-palette`, `editor-core`, `explorer`, `keybindings-editor`,
 * `languages-basic`, `statusbar`, `themes-default`) is still a placeholder
 * with no `manifest.ts` (each is its own later task — see tasks.md's Phase
 * 2/3 built-in tasks). This module is `packages/cli`'s one composition
 * point for the "compiled-in built-ins" list (Task 1.15) so wiring a real
 * built-in later is exactly "add its manifest import and push it into
 * `builtinManifests` below," not a new call site or a new dependency for
 * `cli` to pick up.
 */

import type { Manifest } from "@tecode/api";

/** Every built-in extension's manifest, compiled in as a static import
 * (this module's TSDoc). Empty until a `packages/builtin/*` package gains
 * a real `manifest.ts` and is added here. */
export const builtinManifests: Manifest[] = [];
