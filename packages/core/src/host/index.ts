// Extension host: discovery, manifest validation, registration, and
// activation (design.md §4.1, §4.2). This module exposes the shared
// error/log infrastructure (§4.1) that both host loading and the command
// registry (§5) depend on, plus discovery/validation/registration/
// activation themselves.
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

export {
  createExtensionHost,
  type ActivationState,
  type ExtensionHost,
  type ExtensionHostDeps,
  type ExtensionModule,
  type ExtensionRecord,
} from "./activation";

/** Kept for source compatibility with `core/index.test.ts`'s existing
 * placeholder assertion; discovery/validation/registration/activation above
 * are the real Task 1.11/1.12 surface. */
export const HOST_PLACEHOLDER = true;
