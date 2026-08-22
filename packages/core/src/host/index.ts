// Extension host (discovery, manifest validation, activation) — the rest of
// design.md §4 lands in later tasks. For now this module exposes the shared
// error/log infrastructure (§4.1) that both host loading and the command
// registry (§5) depend on.
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
  getUserKeybindingsPath,
  getUserSettingsPath,
  getWorkspaceSettingsPath,
} from "./paths";

/** Placeholder for the remaining extension-host behavior (discovery,
 * manifest validation, activation) — see design.md §4. */
export const HOST_PLACEHOLDER = true;
