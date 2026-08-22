// Extension host (discovery, manifest validation, registration) — activation
// (design.md §4.2) lands in Task 1.12. This module exposes the shared
// error/log infrastructure (§4.1) that both host loading and the command
// registry (§5) depend on, plus discovery/validation/registration
// themselves.
export {
  createHostLog,
  createNoopStatusSink,
  type HostError,
  type HostLog,
  type HostLogEntry,
  type HostLogLevel,
  type StatusSink,
} from "./errors";

export {
  getUserConfigDir,
  getUserExtensionsDir,
  getUserKeybindingsPath,
  getUserSettingsPath,
  getWorkspaceExtensionsDir,
  getWorkspaceSettingsPath,
} from "./paths";

export {
  discover,
  type DiscoveredExtension,
  type DiscoveryDeps,
  type DiscoveryFs,
  type ExtensionSource,
} from "./discovery";

export {
  checkApiVersionCompatibility,
  validateManifest,
  type ApiVersionCompatibility,
  type ManifestValidationResult,
} from "./validate";

export {
  loadExtensions,
  registerExtension,
  type ConfigRegistrar,
  type LoadedExtension,
  type LoadExtensionsDeps,
  type LoadExtensionsResult,
  type PendingLanguageContribution,
  type PendingThemeContribution,
  type PendingViewContribution,
  type RegisterExtensionDeps,
  type RegisterExtensionResult,
  type SkippedExtension,
} from "./registration";

/** Kept for source compatibility with `core/index.test.ts`'s existing
 * placeholder assertion; discovery/validation/registration above are the
 * real Task 1.11 surface. Activation (design.md §4.2) is still Task
 * 1.12 — remove this once that task's own exports make it redundant. */
export const HOST_PLACEHOLDER = true;
