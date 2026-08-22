/**
 * The configuration service (Req 9, design.md §11): layers defaults (from
 * `contributes.configuration` schemas) under the user's `settings.json`
 * under a workspace's `.tecode/settings.json` (later wins), backs
 * `tecode.config.get`/`onDidChange`, and watches all three files (plus the
 * user's `keybindings.json`) for live reload.
 *
 * Built with {@link createConfigService} rather than a class (house
 * convention — matches `createCommandRegistry`, `createDocumentManager`,
 * `createContextService`).
 *
 * **Initialization design choice**: `createConfigService` returns
 * synchronously (it does no I/O before returning), then kicks off the
 * initial file reads and watcher setup in the background. Callers that need
 * to know the initial load has settled — e.g. the host, before it opens the
 * initial file/directory (design.md §17's startup order: "load
 * configuration" first) — `await` the returned `ready` promise; `get()`
 * itself never blocks and is always safe to call, returning whatever the
 * merged view currently holds (just schema defaults, before `ready`
 * settles). This mirrors the rest of core: no `createX` factory is `async`,
 * so a caller composing several services together never needs to sequence
 * `await`s just to wire them up.
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import { watch as nodeWatch } from "node:fs";
import type {
  ConfigChangeEvent,
  ConfigurationContribution,
  ConfigurationPropertySchema,
  Disposable,
  Event,
  Listener,
} from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import {
  getUserKeybindingsPath,
  getUserSettingsPath,
  getWorkspaceSettingsPath,
} from "../host/paths";
import { parseJsonc } from "./jsonc";

/**
 * The narrow filesystem seam {@link createConfigService} needs: reading a
 * file's text and watching it for changes. Exists as an injectable seam
 * (defaulting to `node:fs/promises` + `node:fs`'s `watch`) so tests can
 * simulate reads/changes deterministically, without touching the real
 * filesystem or real watch latency (matches `documentManager.ts`'s
 * `DocumentManagerFs` seam). Not part of the public API surface.
 */
export interface ConfigServiceFs {
  readFile(path: string): Promise<string>;
  /** Start watching `path`; `onChange` is called (with no arguments) on
   * every change the underlying watcher reports. Returns a handle whose
   * `close()` stops watching. */
  watch(path: string, onChange: () => void): { close(): void };
}

function createNodeConfigFs(): ConfigServiceFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    watch: (path, onChange) => {
      const watcher = nodeWatch(path, () => onChange());
      return {
        close() {
          watcher.close();
        },
      };
    },
  };
}

/** Dependencies for {@link createConfigService}. */
export interface ConfigServiceDeps {
  /** Structured log for parse errors and type-mismatch warnings (design.md
   * §14). */
  log: HostLog;
  /** Where user-facing config errors are surfaced (Req 9, design.md §14). */
  sink: StatusSink;
  /** The open workspace's root directory. The workspace settings layer
   * (`<workspaceRoot>/.tecode/settings.json`, Req 9.2) is only active when
   * this is provided — a single-file session with no workspace has no
   * third layer. */
  workspaceRoot?: string;
  /** Filesystem seam — see {@link ConfigServiceFs}. Defaults to
   * `node:fs/promises` + `node:fs.watch`. */
  fs?: ConfigServiceFs;
  /** Called (guarded) after the user keybindings file is first loaded and
   * again after every successful reload, with the raw parsed entries. The
   * real keymap-layer wiring lands in a later task (design.md §11); this is
   * just the hook it will attach to. */
  onKeybindingsChange?: (entries: readonly unknown[]) => void;
}

/** The config service — the implementation behind `tecode.config`, plus the
 * schema registry and raw keybindings access that only core-internal
 * callers (the extension host, the keymap service) need. */
export interface ConfigService {
  /** Read a key from the merged (defaults ← user ← workspace) view (Req
   * 9.3). Keys are flat, dot-separated strings (e.g. `"editor.tabSize"`) —
   * settings files are flat objects keyed this way; a JSON object *value*
   * (e.g. for a `"type": "object"` schema) is stored as-is under its one
   * key, not split into further path segments (design.md §11). */
  get<T = unknown>(key: string): T | undefined;
  /** Fires whenever a live reload changes the merged view (Req 9.4). Never
   * fires for a reload that reproduces identical values. */
  onDidChange: Event<ConfigChangeEvent>;
  /**
   * Register a schema (Req 9.3): each property's `default` (when present)
   * populates the defaults layer, and its `type` is remembered for
   * best-effort validation (MVP policy — see {@link ConfigService.get}'s
   * TSDoc: a user/workspace value whose `typeof` mismatches the declared
   * type is logged as a warning but still served, never rejected).
   * Returns a {@link Disposable} that removes this contribution's defaults
   * and schemas again.
   */
  registerConfiguration(contribution: ConfigurationContribution): Disposable;
  /** The raw entries currently parsed from the user's `keybindings.json`
   * (an array of whatever shape the file holds — this service does not
   * interpret keybinding entries, only loads/watches the file). Empty
   * when the file is absent or fails to parse. */
  getKeybindingEntries(): readonly unknown[];
  /** Resolves once the initial read of all three settings files (and
   * `keybindings.json`) has completed and watchers are armed — see this
   * module's top-of-file TSDoc for why this is a promise rather than an
   * `async` factory. */
  ready: Promise<void>;
  /** Close every file watcher. Idempotent. */
  dispose(): void;
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`) from a caught unknown
 * (matches `documentManager.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `registry.ts`'s/`documentManager.ts`'s `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Structural equality over JSON-shaped values (objects/arrays/primitives)
 * — needed because re-parsing an unchanged file produces new object/array
 * references even when nothing actually changed, and a reload must only
 * fire `onDidChange` for keys whose *value* changed (Req 9.4). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Whether `value`'s runtime shape matches a schema's declared `type`. */
function matchesSchemaType(
  value: unknown,
  type: ConfigurationPropertySchema["type"],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** Whether `key` (a changed config key) affects `section` (a queried key):
 * equal, `key` is a dot-descendant of `section`, or `section` is a
 * dot-descendant of `key` — but never a bare-prefix match with no dot
 * boundary (design.md §11: `"editor.tabSize"` affects `"editor"` and
 * `"editor.tabSize"` but not `"editorX"`). */
function keyAffectsSection(key: string, section: string): boolean {
  return (
    key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)
  );
}

/**
 * Build a config service (Req 9). `deps.log`/`deps.sink` are required;
 * everything else is optional (see {@link ConfigServiceDeps}).
 */
export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  const { log, sink, workspaceRoot } = deps;
  const fs = deps.fs ?? createNodeConfigFs();

  const userSettingsPath = getUserSettingsPath();
  const workspaceSettingsPath = workspaceRoot
    ? getWorkspaceSettingsPath(workspaceRoot)
    : undefined;
  const keybindingsPath = getUserKeybindingsPath();

  const schemas = new Map<string, ConfigurationPropertySchema>();
  const defaultsLayer: Record<string, unknown> = {};
  let userLayer: Record<string, unknown> = {};
  let workspaceLayer: Record<string, unknown> = {};
  let merged: Record<string, unknown> = {};
  let keybindingEntries: unknown[] = [];

  const changeListeners = new Set<Listener<ConfigChangeEvent>>();
  const watcherHandles: { close(): void }[] = [];
  let disposed = false;

  /** Guarded `log.append` (matches `registry.ts`'s `logSafely`). */
  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  /** Guarded `sink.error` (matches `registry.ts`'s `notifySafely`). */
  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed — see logSafely.
    }
  }

  function computeMerged(): Record<string, unknown> {
    return { ...defaultsLayer, ...userLayer, ...workspaceLayer };
  }

  function diffChangedKeys(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed: string[] = [];
    for (const key of keys) {
      if (!deepEqual(before[key], after[key])) changed.push(key);
    }
    return changed;
  }

  function fireChange(changedKeys: string[]): void {
    const event: ConfigChangeEvent = {
      affectsConfiguration(section: string) {
        return changedKeys.some((key) => keyAffectsSection(key, section));
      },
    };
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop (matches
    // keymap/context.ts's onDidChange pattern).
    for (const listener of Array.from(changeListeners)) {
      try {
        listener(event);
      } catch (cause) {
        logSafely("error", {
          message: `ConfigService onDidChange listener threw: ${describeError(cause)}`,
        });
      }
    }
  }

  /** Recompute the merged view and, when any key's value actually changed,
   * fire `onDidChange` (Req 9.4). Called after every layer update
   * (defaults registration, or a successful reload). */
  function rebuildMerged(): void {
    const next = computeMerged();
    const changed = diffChangedKeys(merged, next);
    merged = next;
    if (changed.length > 0) fireChange(changed);
  }

  /** Best-effort schema-type validation for one freshly loaded layer (Req
   * 9.3 MVP policy): a mismatch is logged as a warning and the value is
   * still served — never rejected, never blocks the layer from loading. */
  function validateLayerTypes(layer: Record<string, unknown>, layerLabel: string): void {
    for (const [key, value] of Object.entries(layer)) {
      const schema = schemas.get(key);
      if (!schema) continue;
      if (!matchesSchemaType(value, schema.type)) {
        logSafely("warning", {
          message:
            `Config value for "${key}" in ${layerLabel} does not match its declared ` +
            `type "${schema.type}"; serving it anyway (MVP policy, design.md §11).`,
        });
      }
    }
  }

  /** Read + parse one settings file into a flat layer object. Returns the
   * new layer (possibly `{}` for a missing file) on success, or `undefined`
   * on any failure — the caller keeps whatever layer it already had (Req
   * 9's "keep last-good configuration" policy). Every failure path reports
   * through `log`/`sink`. */
  async function loadSettingsLayer(
    path: string,
    label: string,
  ): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return {};
      const message = `Failed to read ${label} (${path}): ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }

    const parsed = parseJsonc<unknown>(text);
    if (!parsed.ok) {
      const message = `${label} (${path}) line ${parsed.line}, column ${parsed.column}: ${parsed.message}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
      const message = `${label} (${path}) must be a JSON object at the top level`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }

    const layer = parsed.value as Record<string, unknown>;
    validateLayerTypes(layer, label);
    return layer;
  }

  /** Read + parse `keybindings.json` into a raw entry array. Same
   * keep-last-good-on-failure contract as {@link loadSettingsLayer}. */
  async function loadKeybindingsLayer(path: string): Promise<unknown[] | undefined> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return [];
      const message = `Failed to read user keybindings (${path}): ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }

    const parsed = parseJsonc<unknown>(text);
    if (!parsed.ok) {
      const message = `user keybindings (${path}) line ${parsed.line}, column ${parsed.column}: ${parsed.message}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }
    if (!Array.isArray(parsed.value)) {
      const message = `user keybindings (${path}) must be a JSON array at the top level`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      return undefined;
    }
    return parsed.value;
  }

  function invokeKeybindingsHook(): void {
    if (!deps.onKeybindingsChange) return;
    try {
      deps.onKeybindingsChange(keybindingEntries.slice());
    } catch (cause) {
      logSafely("error", {
        message: `onKeybindingsChange callback threw: ${describeError(cause)}`,
      });
    }
  }

  async function reloadUserSettings(): Promise<void> {
    if (disposed) return;
    const next = await loadSettingsLayer(userSettingsPath, "user settings");
    if (next !== undefined) {
      userLayer = next;
      rebuildMerged();
    }
  }

  async function reloadWorkspaceSettings(): Promise<void> {
    if (disposed || !workspaceSettingsPath) return;
    const next = await loadSettingsLayer(workspaceSettingsPath, "workspace settings");
    if (next !== undefined) {
      workspaceLayer = next;
      rebuildMerged();
    }
  }

  async function reloadKeybindings(): Promise<void> {
    if (disposed) return;
    const next = await loadKeybindingsLayer(keybindingsPath);
    if (next !== undefined) {
      keybindingEntries = next;
      invokeKeybindingsHook();
    }
  }

  // Per-file reload chains: two watch events for the same file firing in
  // quick succession must not run overlapping reads, or a slower-to-finish
  // older read could land after — and clobber — a newer one's result.
  let userReloadChain: Promise<void> = Promise.resolve();
  let workspaceReloadChain: Promise<void> = Promise.resolve();
  let keybindingsReloadChain: Promise<void> = Promise.resolve();

  function scheduleUserReload(): void {
    userReloadChain = userReloadChain.then(reloadUserSettings, reloadUserSettings);
  }
  function scheduleWorkspaceReload(): void {
    workspaceReloadChain = workspaceReloadChain.then(
      reloadWorkspaceSettings,
      reloadWorkspaceSettings,
    );
  }
  function scheduleKeybindingsReload(): void {
    keybindingsReloadChain = keybindingsReloadChain.then(
      reloadKeybindings,
      reloadKeybindings,
    );
  }

  /** Start watching one file, guarding against `fs.watch` throwing when the
   * path does not (yet) exist. Documented MVP limitation: a file that
   * appears later is not picked up automatically — the watch attempt is
   * only made once, here, at startup — needing a reload/restart instead
   * (design.md §11 does not require inotify-on-parent-directory tracking
   * for the MVP). */
  function watchFile(path: string, onChange: () => void, label: string): void {
    try {
      const handle = fs.watch(path, onChange);
      if (disposed) {
        // A dispose() landed while this synchronous call was in flight
        // (impossible in practice given JS's single-threaded execution,
        // but cheap to guard) — do not leak the handle.
        try {
          handle.close();
        } catch {
          // Best-effort.
        }
        return;
      }
      watcherHandles.push(handle);
    } catch (cause) {
      logSafely("warning", {
        message:
          `Could not watch ${label} (${path}) for changes: ${describeError(cause)}. ` +
          `If this file is created later, reload/restart tecode to pick it up (MVP limitation).`,
        path,
      });
    }
  }

  function startWatchers(): void {
    if (disposed) return;
    watchFile(userSettingsPath, scheduleUserReload, "user settings");
    if (workspaceSettingsPath) {
      watchFile(workspaceSettingsPath, scheduleWorkspaceReload, "workspace settings");
    }
    watchFile(keybindingsPath, scheduleKeybindingsReload, "user keybindings");
  }

  async function initialLoad(): Promise<void> {
    const [userResult, workspaceResult, keybindingsResult] = await Promise.all([
      loadSettingsLayer(userSettingsPath, "user settings"),
      workspaceSettingsPath
        ? loadSettingsLayer(workspaceSettingsPath, "workspace settings")
        : Promise.resolve<Record<string, unknown>>({}),
      loadKeybindingsLayer(keybindingsPath),
    ]);
    if (disposed) return;
    userLayer = userResult ?? {};
    workspaceLayer = workspaceResult ?? {};
    keybindingEntries = keybindingsResult ?? [];
    // Initial build: set directly rather than going through rebuildMerged
    // — there is no meaningful "previous" state to diff against yet, and
    // no listener could have subscribed before this promise was even
    // returned to the caller, so no onDidChange fires for startup.
    merged = computeMerged();
    invokeKeybindingsHook();
    startWatchers();
  }

  function get<T = unknown>(key: string): T | undefined {
    return merged[key] as T | undefined;
  }

  function onDidChange(listener: Listener<ConfigChangeEvent>): Disposable {
    changeListeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        changeListeners.delete(listener);
      },
    };
  }

  function registerConfiguration(contribution: ConfigurationContribution): Disposable {
    const keys: string[] = [];
    for (const [key, schema] of Object.entries(contribution.properties)) {
      schemas.set(key, schema);
      keys.push(key);
      if ("default" in schema) {
        defaultsLayer[key] = schema.default;
      }
    }
    rebuildMerged();

    let regDisposed = false;
    return {
      dispose() {
        if (regDisposed) return;
        regDisposed = true;
        for (const key of keys) {
          schemas.delete(key);
          delete defaultsLayer[key];
        }
        rebuildMerged();
      },
    };
  }

  function getKeybindingEntries(): readonly unknown[] {
    return keybindingEntries.slice();
  }

  function dispose(): void {
    disposed = true;
    for (const handle of watcherHandles.splice(0)) {
      try {
        handle.close();
      } catch {
        // Best-effort: a watcher that fails to close cleanly is not worth
        // surfacing — dispose() has nowhere to report it either.
      }
    }
  }

  return {
    get,
    onDidChange,
    registerConfiguration,
    getKeybindingEntries,
    ready: initialLoad(),
    dispose,
  };
}
