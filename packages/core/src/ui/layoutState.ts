/**
 * The layout-state service (Req 6.4, design.md §8.2): persists
 * `{ sidebarVisible, sidebarWidth, panelVisible, panelHeight, activeView }`
 * to `~/.config/tecode/state.json` on change (debounced) and on shutdown
 * (`flush()`).
 *
 * Built with {@link createLayoutStateService} rather than a class, per
 * house convention (matches `createConfigService`, `createContextService`).
 * Mirrors `config/service.ts`'s initialization design choice: construction
 * does no I/O before returning — the initial read starts in the
 * background, and `get()` is always safe to call immediately, returning
 * {@link DEFAULT_LAYOUT_STATE} until {@link LayoutStateService.ready}
 * settles (a caller that needs the persisted state before first render
 * awaits `ready`; the Shell does not have to).
 *
 * **Debounced, serialized writes**: {@link LayoutStateService.update} merges
 * its argument into the in-memory state immediately (so `get()` reflects it
 * right away) and (re)starts a debounce timer via the injectable
 * {@link LayoutStateTimer} seam; when the timer fires, the write is
 * appended to a serialized `saveChain` (`saveChain = saveChain.then(doSave,
 * doSave)`, matching `config/service.ts`'s per-file reload chains) so a
 * burst of `update()` calls whose debounce windows overlap never runs two
 * overlapping writes. {@link LayoutStateService.flush} cancels any pending
 * timer and appends an immediate save to the same chain, resolving once
 * every write chained so far (including one already in flight) has
 * settled — the shutdown path (design.md §8.2's "on exit").
 *
 * **Parse failure → last-good defaults**: exactly `config/service.ts`'s
 * policy — a missing file is `{}`-equivalent (this module's
 * {@link DEFAULT_LAYOUT_STATE}), and a corrupt/unreadable file keeps
 * whatever the in-memory state already holds (the compile-time default on
 * first load) rather than throwing or wiping user layout preferences.
 *
 * Never-throwing public API: every method is guarded so a broken injected
 * `fs`/`timer`/`log` cannot make a caller's `update()`/`flush()` throw.
 *
 * **`onDidChange` (Issue #101)**: {@link LayoutStateService.onDidChange}
 * fires synchronously from `update()`, right after the in-memory merge
 * above, so a caller other than `shell.tsx`'s `useLayoutState` — e.g.
 * `panelCommands.ts`'s `workbench.action.showPanel` handler, which holds
 * only this service and updates it directly — can change the persisted
 * layout and have every subscriber find out immediately, not just on the
 * next launch. See {@link LayoutStateService.onDidChange}'s own TSDoc for
 * why this had to be added and why it does not also fire from `load()`.
 */

import { readFile as nodeReadFile, writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Disposable, Event, Listener } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { getUserLayoutStatePath } from "../host/paths";

/** Persisted UI layout state (Req 6.4). */
export interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  panelVisible: boolean;
  panelHeight: number;
  /** The `id` of the currently active `sidebar.view`, or `undefined` if
   * none has been selected yet. */
  activeView: string | undefined;
}

/** The layout state a fresh install (or a corrupt/missing `state.json`)
 * starts from (Req 6.4). Not exported as a shared mutable reference —
 * {@link createLayoutStateService} copies it into its own state so no
 * caller can mutate the shared default. */
const DEFAULT_LAYOUT_STATE: Readonly<LayoutState> = Object.freeze({
  sidebarVisible: true,
  sidebarWidth: 30,
  panelVisible: false,
  panelHeight: 10,
  activeView: undefined,
});

/** The narrow filesystem seam {@link createLayoutStateService} needs —
 * exists as an injectable seam (defaulting to `node:fs/promises`) so tests
 * can simulate a corrupt file, a slow write, or a write failure without
 * touching the real filesystem (matches `config/service.ts`'s
 * `ConfigServiceFs`, `documentManager.ts`'s `DocumentManagerFs`). Not part
 * of the public API surface. */
export interface LayoutStateFs {
  readFile(path: string): Promise<string>;
  /** Create `path`'s parent directory if it does not exist (the user
   * config dir may not exist yet on a fresh install — matches the
   * `{ recursive: true }` idiom). */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

function createNodeLayoutFs(): LayoutStateFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    mkdir: (path) => nodeMkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, data) => nodeWriteFile(path, data, "utf8"),
  };
}

/** The debounce/scheduling seam {@link createLayoutStateService} needs for
 * `update()`'s debounce window — an injectable seam (defaulting to real
 * `setTimeout`/`clearTimeout`) so tests can control exactly when a
 * debounced save fires without a real (and therefore flaky) wait (matches
 * this codebase's other injectable-seam conventions). Not part of the
 * public API surface. */
export interface LayoutStateTimer {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

function createRealTimer(): LayoutStateTimer {
  return {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Dependencies for {@link createLayoutStateService}. */
export interface LayoutStateServiceDeps {
  /** Structured log for read/write/parse failures (design.md §14). */
  log: HostLog;
  /** Where user-facing persistence errors are surfaced (design.md §14). */
  sink: StatusSink;
  /** Overrides `state.json`'s path — tests use a temp file; production
   * defaults to {@link getUserLayoutStatePath}. */
  path?: string;
  /** Filesystem seam — see {@link LayoutStateFs}. Defaults to
   * `node:fs/promises`. */
  fs?: LayoutStateFs;
  /** Debounce/scheduling seam — see {@link LayoutStateTimer}. Defaults to
   * real timers. */
  timer?: LayoutStateTimer;
  /** Debounce window, in milliseconds, between the last `update()` call
   * and the write it schedules. Defaults to 250. */
  debounceMs?: number;
}

/** The layout-state service — the implementation behind the Shell's
 * persisted layout (Req 6.4). */
export interface LayoutStateService {
  /** The current in-memory state — always safe to call, never blocks.
   * Before {@link ready} settles this is {@link DEFAULT_LAYOUT_STATE}. */
  get(): LayoutState;
  /** Merge `partial` into the current state and schedule a debounced,
   * serialized write (this module's TSDoc). Never throws. */
  update(partial: Partial<LayoutState>): void;
  /** Resolves once the initial read of `state.json` has completed (or
   * failed, keeping defaults) — see this module's TSDoc for why this is a
   * promise rather than an `async` factory. */
  ready: Promise<void>;
  /** Cancel any pending debounce timer and write the current state now.
   * Resolves once that write (and anything already chained ahead of it)
   * has settled — the shutdown path (Req 6.4). Never rejects. */
  flush(): Promise<void>;
  /** Fires synchronously, with no payload, whenever `update()` merges a
   * change into the in-memory state (Issue #101) — a subscriber re-reads
   * {@link get} to see the new value, matching every other minimal
   * `onDidChange` in this codebase (`themeService.ts`, `modalService.ts`,
   * `config/service.ts`, `keymap/context.ts`).
   *
   * **Why this exists**: `shell.tsx`'s `useLayoutState` used to be the
   * layout service's *only* writer, keeping its own optimistic `useState`
   * copy in sync by construction — a caller anywhere else that called
   * `update()` directly (`panelCommands.ts`'s `workbench.action.showPanel`
   * handler, added by Issue #98, is exactly such a caller) wrote straight
   * to this service with no way to tell React a change had happened, so
   * the write only ever surfaced after a restart re-seeded `useState` from
   * `ready`. This event is what lets `useLayoutState` become a genuine
   * subscriber instead of assuming it is the only writer.
   *
   * Deliberately NOT fired from `load()` — the existing `ready` promise
   * already covers a subscriber picking up the initial persisted state;
   * firing here too would just be a redundant, no-op-carrying notification
   * for every subscriber that already awaits `ready` on mount. */
  onDidChange: Event<void>;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `config/service.ts`'s/`registry.ts`'s `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (matches `documentManager.ts`'s/
 * `config/service.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** True if any field `partial` sets differs (`!==`) from `prev`'s current
 * value for that field — the shallow check `update()` uses to skip firing
 * `onDidChange` for a no-op merge (this module's TSDoc on
 * `LayoutStateService.onDidChange`). Deliberately shallow: `LayoutState`'s
 * fields are all primitives (or `undefined`), so `!==` is exact, not an
 * approximation. */
function hasChanged(prev: LayoutState, partial: Partial<LayoutState>): boolean {
  for (const key of Object.keys(partial) as (keyof LayoutState)[]) {
    if (prev[key] !== partial[key]) return true;
  }
  return false;
}

/** Best-effort field-by-field validation of a parsed `state.json` (mirrors
 * `config/service.ts`'s `matchesSchemaType` policy): a field with the wrong
 * runtime shape falls back to `fallback`'s value for that field rather than
 * failing the whole load. */
function coerceLayoutState(value: unknown, fallback: LayoutState): LayoutState {
  if (typeof value !== "object" || value === null) return { ...fallback };
  const raw = value as Record<string, unknown>;
  return {
    sidebarVisible:
      typeof raw["sidebarVisible"] === "boolean" ? raw["sidebarVisible"] : fallback.sidebarVisible,
    sidebarWidth:
      typeof raw["sidebarWidth"] === "number" ? raw["sidebarWidth"] : fallback.sidebarWidth,
    panelVisible:
      typeof raw["panelVisible"] === "boolean" ? raw["panelVisible"] : fallback.panelVisible,
    panelHeight:
      typeof raw["panelHeight"] === "number" ? raw["panelHeight"] : fallback.panelHeight,
    activeView: typeof raw["activeView"] === "string" ? raw["activeView"] : fallback.activeView,
  };
}

/** Build the layout-state service (Req 6.4). `deps.log`/`deps.sink` are
 * required; everything else is optional (see
 * {@link LayoutStateServiceDeps}). */
export function createLayoutStateService(deps: LayoutStateServiceDeps): LayoutStateService {
  const { log, sink } = deps;
  const path = deps.path ?? getUserLayoutStatePath();
  const fs = deps.fs ?? createNodeLayoutFs();
  const timer = deps.timer ?? createRealTimer();
  const debounceMs = deps.debounceMs ?? 250;

  let state: LayoutState = { ...DEFAULT_LAYOUT_STATE };
  let pendingTimer: unknown;
  // Serialized write chain (this module's TSDoc) — every scheduled save
  // (debounced or flushed) is appended here so writes never overlap.
  let saveChain: Promise<void> = Promise.resolve();
  // True once `load()` has settled (successfully or not). While false, any
  // field an `update()` call touches is also recorded in `localOverrides`
  // below — guarding against the race where `update()` lands while `load()`
  // is still awaiting `fs.readFile`: without this, `load()`'s merge (which
  // must still apply the *persisted* value for every field the caller
  // hasn't locally touched) would blindly overwrite that field with
  // whatever `state.json` says, clobbering the just-arrived local update
  // even though it happened after the read started.
  let loaded = false;
  let localOverrides: Partial<LayoutState> = {};

  // `onDidChange` subscribers (this module's TSDoc on `LayoutStateService`).
  // Payload is `void` — matches the minimal `onDidChange` convention this
  // codebase already uses (`themeService.ts`, `modalService.ts`,
  // `config/service.ts`, `keymap/context.ts`).
  const listeners = new Set<Listener<void>>();

  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed — see logSafely.
    }
  }

  function fireChange(): void {
    // Snapshot before iterating, isolate each listener's failure — matches
    // every other `onDidChange` in this codebase (`themeService.ts`,
    // `modalService.ts`).
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch (cause) {
        logSafely("error", {
          message: `LayoutStateService onDidChange listener threw: ${describeError(cause)}`,
        });
      }
    }
  }

  async function doSave(): Promise<void> {
    // Snapshot at write time (not at schedule time): the freshest state as
    // of when the debounce/flush actually runs is what gets written, so a
    // rapid burst of update() calls only ever produces one write of the
    // latest values.
    const snapshot = state;
    try {
      await fs.mkdir(dirname(path));
      await fs.writeFile(path, JSON.stringify(snapshot, null, 2));
    } catch (cause) {
      const message = `Failed to write layout state (${path}): ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
    }
  }

  function scheduleSave(): void {
    saveChain = saveChain.then(doSave, doSave);
  }

  function get(): LayoutState {
    return { ...state };
  }

  function update(partial: Partial<LayoutState>): void {
    const prev = state;
    state = { ...state, ...partial };
    // Shallow, field-by-field comparison against `partial`'s own keys only
    // (not a deep-equal of the whole state) — enough to skip the no-op case
    // `panelCommands.ts`'s TSDoc calls out ("setting panelVisible: true when
    // it is already true is a harmless no-op merge") without giving this a
    // fancier equality check than the rest of this module bothers with.
    if (hasChanged(prev, partial)) fireChange();
    if (!loaded) {
      // Still mid-`load()` (or not yet started) — remember exactly which
      // fields this update touched so `load()`'s merge below can exclude
      // them from the persisted values, whether or not it awaits again
      // before returning.
      localOverrides = { ...localOverrides, ...partial };
    }
    if (pendingTimer !== undefined) {
      try {
        timer.cancel(pendingTimer);
      } catch {
        // Best-effort — a broken timer seam must not stop the new one
        // from being scheduled below.
      }
    }
    try {
      pendingTimer = timer.schedule(() => {
        pendingTimer = undefined;
        scheduleSave();
      }, debounceMs);
    } catch (cause) {
      // A timer seam that throws on schedule() must not lose the update
      // permanently — save it directly instead of debouncing.
      pendingTimer = undefined;
      logSafely("warning", {
        message: `Layout state debounce timer failed, saving immediately: ${describeError(cause)}`,
      });
      scheduleSave();
    }
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

  async function flush(): Promise<void> {
    if (pendingTimer !== undefined) {
      try {
        timer.cancel(pendingTimer);
      } catch {
        // Best-effort.
      }
      pendingTimer = undefined;
      scheduleSave();
    }
    await saveChain;
  }

  async function load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        const message = `Failed to read layout state (${path}): ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
      }
      loaded = true; // Keep DEFAULT_LAYOUT_STATE (last-good policy).
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      const message = `Failed to parse layout state (${path}): ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
      loaded = true; // Keep DEFAULT_LAYOUT_STATE (last-good policy).
      return;
    }

    // Coerce against `state` as the fallback (so any local override already
    // applied to a field the file doesn't set, or sets invalidly, survives
    // as before) and then re-apply `localOverrides` on top — those are
    // exactly the fields an in-flight `update()` touched while this read
    // was pending, which must win over the persisted value even when the
    // file does validly set that same field (this function's TSDoc / this
    // module's race-condition TSDoc above `localOverrides`'s declaration).
    state = { ...coerceLayoutState(parsed, state), ...localOverrides };
    loaded = true;
  }

  return {
    get,
    update,
    ready: load(),
    flush,
    onDidChange,
  };
}

export { DEFAULT_LAYOUT_STATE };
