/**
 * Host-side error and logging primitives (design.md §4.1, §14). `HostError`
 * is the shared shape for both extension-loading failures (manifest
 * validation, API version mismatches) and command failures (Req 3.4, 3.5) —
 * anywhere the host needs to report a problem without throwing across a
 * public API boundary.
 */

/**
 * A structured error the host can attribute to an extension and/or a file
 * path (design.md §4.1). `extensionId`/`path` are omitted when not
 * applicable — e.g. a command-not-found error carries neither.
 */
export interface HostError {
  extensionId?: string;
  path?: string;
  message: string;
}

/** The severity of one {@link HostLog} entry. */
export type HostLogLevel = "error" | "warning";

/** One recorded entry in a {@link HostLog}. */
export interface HostLogEntry {
  level: HostLogLevel;
  error: HostError;
}

/**
 * A minimal structured log the host and its services append to (design.md
 * §14: "A core `HostLog` collects structured errors"). Kept intentionally
 * small for the MVP — just an append-only record with retrieval; a
 * `developer.showLog` command can later dump {@link HostLog.entries} into an
 * untitled document.
 */
export interface HostLog {
  /** Append an entry at the given severity. */
  append(level: HostLogLevel, error: HostError): void;
  /** All entries recorded so far, oldest first. */
  entries(): readonly HostLogEntry[];
}

/** Create an empty, in-memory {@link HostLog}. */
export function createHostLog(): HostLog {
  const records: HostLogEntry[] = [];
  return {
    append(level, error) {
      records.push({ level, error });
    },
    entries() {
      return records;
    },
  };
}

/**
 * Where the host sends user-facing error notifications — real UI wiring
 * (the status bar) lands in a later task; for now services depend only on
 * this narrow interface (design.md §5, §14).
 */
export interface StatusSink {
  error(err: HostError): void;
}

/** A {@link StatusSink} that discards everything — the default for tests
 * and for any composition root that hasn't wired real UI yet. */
export function createNoopStatusSink(): StatusSink {
  return {
    error() {
      // Intentionally discarded — see StatusSink's TSDoc.
    },
  };
}
