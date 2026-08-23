/**
 * `LanguageRegistry` (Req 8.1-8.3; design.md §10): maps file extensions to
 * `contributes.languages` declarations (a manifest entry, or a runtime
 * `tecode.languages.register` call — both normalize to `@tecode/api`'s
 * `LanguageContribution`) and resolves a `Uri`'s language id from its
 * trailing extension, falling back to `"plaintext"` when nothing matches
 * (Req 8.3) — the "no match -> plaintext, which bypasses the pipeline
 * entirely" rule design.md §10 states for the highlight service.
 *
 * Built with {@link createLanguageRegistry} rather than a class, per house
 * convention (matches `ui/themeRegistry.ts`'s `createThemeRegistry`).
 *
 * **Synchronous registration, unlike `ThemeRegistry`**: a language
 * contribution is just a declaration — `id`/`extensions`/`grammar`/
 * `highlights`/`comments`/`brackets` (`@tecode/api`'s `LanguageContribution`
 * TSDoc) — with no file to read at registration time (the grammar WASM and
 * `.scm` query are only ever read later, on first use, by the highlight
 * service, Task 2.8's `highlightService.ts`). {@link register} therefore
 * updates the extension map and fires {@link LanguageRegistry.onDidChange}
 * immediately and returns a plain, synchronous `Disposable` — there is no
 * `ThemeRegistry`-style "appears once the load settles" gap to document.
 *
 * **Path resolution deferred, not done here**: `contribution.grammar`/
 * `contribution.highlights` are relative paths that must be resolved
 * against the OWNING EXTENSION's directory — the same `extensionId ->
 * directory` map `ThemeRegistry.loadContributions` takes
 * (`themeRegistry.ts`'s TSDoc), built by the composition root the same way
 * `extensionRecords.ts`'s `buildExtensionRecord` derives `extensionDir`.
 * Rather than resolving those paths into absolute ones up front (there is
 * no I/O here to make that worthwhile), this registry just remembers each
 * contribution's `baseDir` alongside it ({@link getBaseDir}) so the
 * highlight service's asset resolver (`assetResolver.ts`) can join
 * `baseDir` with `contribution.grammar`/`contribution.highlights` itself,
 * lazily, on first use. A runtime `tecode.languages.register` call carries
 * no manifest/extension attribution (mirrors `ThemeRegistry.register`'s own
 * documented trade-off) — its `baseDir` is `undefined`, so
 * `assetResolver.ts` uses `contribution.grammar`/`contribution.highlights`
 * as-is (in practice, a runtime registration must pass absolute paths).
 */

import { extname } from "node:path";
import type { Disposable, Event, LanguageContribution, Listener, Uri } from "@tecode/api";
import type { PendingLanguageContribution } from "../host/registration";
import { uriToPath } from "../buffer/uri";

/** The language id the system treats every unmatched (or unregistered)
 * file extension as (Req 8.3) — bypasses the highlight pipeline entirely
 * (design.md §10). */
export const PLAINTEXT_LANGUAGE_ID = "plaintext";

/** One registered language, paired with the directory its `grammar`/
 * `highlights` paths resolve against — see this module's TSDoc on why path
 * resolution itself is deferred to the highlight service. */
export interface LanguageRegistryEntry {
  contribution: LanguageContribution;
  /** The owning extension's directory, or `undefined` for a runtime
   * `tecode.languages.register` call (this module's TSDoc). */
  baseDir?: string;
}

/** The language registry's public surface (Req 8.1-8.3). */
export interface LanguageRegistry {
  /**
   * Register one language (a manifest's `contributes.languages` entry, or
   * a runtime `tecode.languages.register` call — both normalize to
   * {@link LanguageContribution}). Updates the extension map and fires
   * {@link onDidChange} synchronously (this module's TSDoc — unlike
   * `ThemeRegistry.register`, there is no async load to wait on).
   * Registering the same `id` again replaces the previous entry entirely
   * (its extensions are removed from the map first, so a language that
   * changes which extensions it claims never leaves a stale mapping
   * behind).
   */
  register(contribution: LanguageContribution, baseDir?: string): Disposable;
  /**
   * Register every manifest-declared language discovered during the
   * deferred phase (`host/registration.ts`'s
   * `LoadExtensionsResult.pendingLanguages`) against an `extensionId ->
   * directory` map (this module's TSDoc) — the language-registry
   * equivalent of `ThemeRegistry.loadContributions`, kept `async` (even
   * though registration itself is synchronous, this module's TSDoc) so
   * `main.ts`'s deferred phase can `await` it alongside the theme
   * registry's own `loadContributions` call with the same shape.
   */
  loadContributions(
    pending: readonly PendingLanguageContribution[],
    extensionDirs: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** The registered {@link LanguageContribution} for `id`, or `undefined`
   * if no extension (or runtime call) has registered a language under
   * that id (Req 8.2). */
  getLanguage(id: string): LanguageContribution | undefined;
  /** The directory `id`'s `grammar`/`highlights` paths resolve against
   * (this module's TSDoc), or `undefined` for an unregistered id OR a
   * runtime registration that supplied none. Core-internal — not part of
   * `@tecode/api`'s `LanguagesNamespace`; consumed by the highlight
   * service's asset resolver only. */
  getBaseDir(id: string): string | undefined;
  /** Every currently-registered language, in registration order. */
  list(): readonly LanguageContribution[];
  /**
   * Resolve `uri`'s language id from its trailing dot-extension (Req 8.3):
   * the extension (including the leading dot, lowercased) is looked up in
   * the extension map — multi-extension languages (e.g. `[".ts", ".tsx"]`)
   * all map to the same id — and {@link PLAINTEXT_LANGUAGE_ID} is returned
   * when nothing matches (no extension at all, or an extension no
   * registered language claims).
   */
  resolveLanguageId(uri: Uri): string;
  /** Fires whenever a language is registered or disposed. Carries no
   * payload — same "just re-render/re-check, don't diff what changed"
   * shape as `ThemeRegistry.onDidChange`. */
  onDidChange: Event<void>;
  /** Clear every listener. Registered entries are left in place (matches
   * `ThemeRegistry.dispose`'s "no meaningful unload" reasoning — this only
   * stops `onDidChange` from firing further). */
  dispose(): void;
}

/** Build a language registry (Req 8.1-8.3). Starts empty — every `Uri`
 * resolves to {@link PLAINTEXT_LANGUAGE_ID} until at least one language is
 * registered (design.md §10's "no real grammars ship yet" MVP state: a
 * fresh registry with zero registrations is a fully valid, expected
 * starting point, not an error). */
export function createLanguageRegistry(): LanguageRegistry {
  const entries = new Map<string, LanguageRegistryEntry>();
  // Lowercased extension (with leading dot) -> language id. Rebuilt
  // incrementally on every register/dispose rather than derived on demand,
  // so `resolveLanguageId` (called on every document open, Req 8.3) is
  // always a single hash lookup.
  const extensionMap = new Map<string, string>();
  const listeners = new Set<Listener<void>>();
  let disposed = false;

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches every
    // other `onDidChange` in this codebase.
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures (matches `findService.ts`/
        // `themeRegistry.ts`'s own `fireChange`).
      }
    }
  }

  function removeFromExtensionMap(languageId: string): void {
    for (const [ext, id] of Array.from(extensionMap.entries())) {
      if (id === languageId) extensionMap.delete(ext);
    }
  }

  function addToExtensionMap(contribution: LanguageContribution): void {
    for (const ext of contribution.extensions) {
      extensionMap.set(ext.toLowerCase(), contribution.id);
    }
  }

  function register(contribution: LanguageContribution, baseDir?: string): Disposable {
    // A re-registration of the same id fully replaces the prior entry's
    // extension claims (this interface's TSDoc) — remove before adding so
    // an id that drops an extension in its new declaration doesn't leave
    // that extension pointing at it forever.
    removeFromExtensionMap(contribution.id);
    entries.set(contribution.id, { contribution, baseDir });
    addToExtensionMap(contribution);
    fireChange();

    let entryDisposed = false;
    return {
      dispose() {
        if (entryDisposed) return;
        entryDisposed = true;
        // A no-op if a later `register(sameId, ...)` has already
        // superseded this entry (`entries.get` no longer `===` what this
        // closure captured) — matches `themeRegistry.ts`'s per-id
        // "later registrations win" discipline.
        if (entries.get(contribution.id)?.contribution !== contribution) return;
        entries.delete(contribution.id);
        removeFromExtensionMap(contribution.id);
        fireChange();
      },
    };
  }

  async function loadContributions(
    pending: readonly PendingLanguageContribution[],
    extensionDirs: Readonly<Record<string, string>>,
  ): Promise<void> {
    // Synchronous under the hood (this module's TSDoc) — `async` only to
    // match `ThemeRegistry.loadContributions`'s awaitable shape at the
    // `main.ts` deferred-phase call site.
    for (const entry of pending) {
      register(entry.language, extensionDirs[entry.extensionId]);
    }
  }

  function getLanguage(id: string): LanguageContribution | undefined {
    return entries.get(id)?.contribution;
  }

  function getBaseDir(id: string): string | undefined {
    return entries.get(id)?.baseDir;
  }

  function list(): readonly LanguageContribution[] {
    return Array.from(entries.values(), (entry) => entry.contribution);
  }

  function resolveLanguageId(uri: Uri): string {
    // `uriToPath` mirrors `documentManager.ts`'s own uri handling, but
    // throws on a malformed uri (`uri.ts`'s TSDoc) — this is a guarded
    // boundary (house convention: never throw), so a uri it can't parse
    // simply resolves to plaintext rather than propagating. `extname`'s
    // result is explicitly lowercased so the map key/lookup match
    // case-insensitively (Req 8.3: matching the extension, not the whole
    // filename).
    let path: string;
    try {
      path = uriToPath(uri);
    } catch {
      return PLAINTEXT_LANGUAGE_ID;
    }
    const ext = extname(path).toLowerCase();
    if (!ext) return PLAINTEXT_LANGUAGE_ID;
    return extensionMap.get(ext) ?? PLAINTEXT_LANGUAGE_ID;
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        listeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    listeners.clear();
  }

  return {
    register,
    loadContributions,
    getLanguage,
    getBaseDir,
    list,
    resolveLanguageId,
    onDidChange,
    dispose,
  };
}
