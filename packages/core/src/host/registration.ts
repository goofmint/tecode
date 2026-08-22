/**
 * Extension registration (Req 2.1-2.4, 2.7, design.md §4.1): walks one
 * validated manifest's `contributes` and pushes its declarations into the
 * command registry (as *lazy* commands), a keybindings accumulator, the
 * config schema registry, and per-extension collections of raw
 * views/languages/themes declarations for later tasks (1.14, 2.8, 2.6) to
 * consume — all without ever touching `index.ts`.
 *
 * {@link loadExtensions} is the orchestration entry point: discover
 * (`discovery.ts`) → validate + check API-version compatibility
 * (`validate.ts`) → register, for every source in one call. Like every
 * other service boundary in `core`, it never throws — a bad extension is
 * skipped and reported, startup continues (Req 2.4).
 */

import type {
  ConfigurationContribution,
  Disposable,
  KeybindingContribution,
  LanguageContribution,
  Manifest,
  ThemeContribution,
  ViewContribution,
} from "@tecode/api";
import type { CommandRegistry } from "../commands/registry";
import type { DiscoveredExtension, DiscoveryFs, ExtensionSource } from "./discovery";
import { discover } from "./discovery";
import type { HostError, HostLog, StatusSink } from "./errors";
import { checkApiVersionCompatibility, validateManifest } from "./validate";

/** The narrow slice of {@link ConfigService} registration needs — "the
 * config schema registry" from Task 1.10, satisfied by `ConfigService`
 * itself without registration.ts depending on the whole service. */
export interface ConfigRegistrar {
  registerConfiguration(contribution: ConfigurationContribution): Disposable;
}

/** A `contributes.views` entry, attributed to the extension that declared
 * it — collected here for the slot registry (Task 1.14) to consume. */
export interface PendingViewContribution {
  extensionId: string;
  view: ViewContribution;
}

/** A `contributes.languages` entry, attributed to the extension that
 * declared it — collected here for the language registry (Task 2.8). */
export interface PendingLanguageContribution {
  extensionId: string;
  language: LanguageContribution;
}

/** A `contributes.themes` entry, attributed to the extension that declared
 * it — collected here for the theme registry (Task 2.6). */
export interface PendingThemeContribution {
  extensionId: string;
  theme: ThemeContribution;
}

/** What registering one extension's `contributes` block produced. */
export interface RegisterExtensionResult {
  /** Disposables for every lazy command registered (commands) and every
   * configuration schema registered — the caller owns disposing these on
   * extension unload/reload (a later task). */
  disposables: Disposable[];
  /** This extension's `contributes.keybindings`, unchanged — the caller
   * accumulates these across extensions into `KeymapLayers.extension`
   * (`bindingTable.ts` has no incremental API, so building the full
   * 4-layer table is the caller's job, not registration.ts's). */
  keybindings: KeybindingContribution[];
  views: PendingViewContribution[];
  languages: PendingLanguageContribution[];
  themes: PendingThemeContribution[];
}

/** Dependencies {@link registerExtension} needs to push contributions into
 * the right places. */
export interface RegisterExtensionDeps {
  commands: CommandRegistry;
  /** The config schema registry (Task 1.10's `ConfigService`). Omitted
   * when no config service is wired yet — a manifest's
   * `contributes.configuration` is then simply not registered (and not
   * reported as an error; that's a caller wiring choice, not a manifest
   * problem). */
  configRegistrar?: ConfigRegistrar;
  log: HostLog;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `discovery.ts`'s/`registry.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` (matches `discovery.ts`'s/`registry.ts`'s
 * `logSafely`). */
function logSafely(log: HostLog, level: "error" | "warning", err: HostError): void {
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/**
 * Register one already-validated manifest's `contributes` block
 * (design.md §4.1). Never throws: a single bad contribution (e.g. a
 * `configRegistrar` that throws) is logged and skipped, the rest of the
 * manifest's contributions still register.
 */
export function registerExtension(
  extensionId: string,
  manifest: Manifest,
  deps: RegisterExtensionDeps,
): RegisterExtensionResult {
  const { commands, configRegistrar, log } = deps;
  const disposables: Disposable[] = [];
  const contributes = manifest.contributes;

  for (const command of contributes.commands ?? []) {
    try {
      disposables.push(
        commands.registerLazy(command.id, {
          extensionId,
          meta: { title: command.title, category: command.category, when: command.when },
        }),
      );
    } catch (cause) {
      logSafely(log, "warning", {
        extensionId,
        message: `Failed to register command "${command.id}": ${describeError(cause)}`,
      });
    }
  }

  if (contributes.configuration && configRegistrar) {
    try {
      disposables.push(configRegistrar.registerConfiguration(contributes.configuration));
    } catch (cause) {
      logSafely(log, "warning", {
        extensionId,
        message: `Failed to register configuration: ${describeError(cause)}`,
      });
    }
  }

  const views: PendingViewContribution[] = (contributes.views ?? []).map((view) => ({
    extensionId,
    view,
  }));
  const languages: PendingLanguageContribution[] = (contributes.languages ?? []).map(
    (language) => ({ extensionId, language }),
  );
  const themes: PendingThemeContribution[] = (contributes.themes ?? []).map((theme) => ({
    extensionId,
    theme,
  }));

  return {
    disposables,
    keybindings: contributes.keybindings ?? [],
    views,
    languages,
    themes,
  };
}

/** One extension successfully discovered, validated, version-checked, and
 * registered. */
export interface LoadedExtension {
  extensionId: string;
  manifest: Manifest;
  source: ExtensionSource;
  sourcePath: string;
}

/** One extension that was discovered but not loaded, and why — manifest
 * validation failure or API-version incompatibility (Req 2.4, 2.7). */
export interface SkippedExtension {
  extensionId: string;
  sourcePath: string;
  source: ExtensionSource;
  reason: string;
}

/** Dependencies for {@link loadExtensions}. */
export interface LoadExtensionsDeps {
  log: HostLog;
  sink: StatusSink;
  commands: CommandRegistry;
  configRegistrar?: ConfigRegistrar;
  /** Built-in extensions' manifests, passed straight through to
   * `discover()` — see `discovery.ts`'s `DiscoveryDeps.builtins`. */
  builtins?: Manifest[];
  workspaceRoot?: string;
  fs?: DiscoveryFs;
}

/** What {@link loadExtensions} produced across every discovered
 * extension. */
export interface LoadExtensionsResult {
  loaded: LoadedExtension[];
  skipped: SkippedExtension[];
  /** Every loaded extension's `contributes.keybindings`, concatenated in
   * discovery order — feed this straight in as `KeymapLayers.extension`. */
  extensionKeybindings: KeybindingContribution[];
  pendingViews: PendingViewContribution[];
  pendingLanguages: PendingLanguageContribution[];
  pendingThemes: PendingThemeContribution[];
  /** Every command/configuration `Disposable` produced across every loaded
   * extension, for the caller to dispose on unload/reload. */
  disposables: Disposable[];
}

/** Guarded `sink.error` (matches `discovery.ts`'s/`registry.ts`'s
 * `notifySafely`). */
function notifySafely(sink: StatusSink, err: HostError): void {
  try {
    sink.error(err);
  } catch {
    // Swallowed — see logSafely.
  }
}

function reportSkip(
  deps: Pick<LoadExtensionsDeps, "log" | "sink">,
  extension: DiscoveredExtension,
  reason: string,
): SkippedExtension {
  const err: HostError = {
    extensionId: extension.extensionId,
    path: extension.sourcePath,
    message: `Extension "${extension.extensionId}" (${extension.sourcePath}) skipped: ${reason}`,
  };
  logSafely(deps.log, "error", err);
  notifySafely(deps.sink, err);
  return {
    extensionId: extension.extensionId,
    sourcePath: extension.sourcePath,
    source: extension.source,
    reason,
  };
}

/**
 * Discover, validate, version-check, and register every extension from
 * every source (Req 2.1-2.4, 2.7, design.md §4.1, §4.3). Never throws: any
 * failure at any stage for any one extension is reported through
 * `deps.log`/`deps.sink` and that extension is skipped — the rest of
 * startup, and every other extension, proceeds regardless.
 */
export async function loadExtensions(deps: LoadExtensionsDeps): Promise<LoadExtensionsResult> {
  const discovered = await discover({
    builtins: deps.builtins,
    workspaceRoot: deps.workspaceRoot,
    fs: deps.fs,
    log: deps.log,
  });

  const loaded: LoadedExtension[] = [];
  const skipped: SkippedExtension[] = [];
  const extensionKeybindings: KeybindingContribution[] = [];
  const pendingViews: PendingViewContribution[] = [];
  const pendingLanguages: PendingLanguageContribution[] = [];
  const pendingThemes: PendingThemeContribution[] = [];
  const disposables: Disposable[] = [];

  for (const extension of discovered) {
    let validation: ReturnType<typeof validateManifest>;
    try {
      validation = validateManifest(extension.manifest);
    } catch (cause) {
      skipped.push(reportSkip(deps, extension, `validator threw: ${describeError(cause)}`));
      continue;
    }
    if (!validation.valid) {
      skipped.push(reportSkip(deps, extension, validation.errors.join("; ")));
      continue;
    }

    const { manifest } = validation;
    const compatibility = checkApiVersionCompatibility(manifest.apiVersion);
    if (!compatibility.compatible) {
      skipped.push(
        reportSkip(deps, extension, compatibility.reason ?? "incompatible apiVersion"),
      );
      continue;
    }

    let result: RegisterExtensionResult;
    try {
      result = registerExtension(manifest.id, manifest, {
        commands: deps.commands,
        configRegistrar: deps.configRegistrar,
        log: deps.log,
      });
    } catch (cause) {
      skipped.push(reportSkip(deps, extension, `registration threw: ${describeError(cause)}`));
      continue;
    }

    disposables.push(...result.disposables);
    extensionKeybindings.push(...result.keybindings);
    pendingViews.push(...result.views);
    pendingLanguages.push(...result.languages);
    pendingThemes.push(...result.themes);
    loaded.push({
      extensionId: manifest.id,
      manifest,
      source: extension.source,
      sourcePath: extension.sourcePath,
    });
  }

  return {
    loaded,
    skipped,
    extensionKeybindings,
    pendingViews,
    pendingLanguages,
    pendingThemes,
    disposables,
  };
}
