/**
 * The UI slot registry (Req 6.2, 6.3; design.md §8.2; Task 1.14): an ordered
 * map, per {@link SlotId}, of the views registered into it. Backs
 * `tecode.ui.registerView` (`api/create.ts` delegates its `registerView`
 * straight to {@link SlotRegistry.registerView}) and is what the Shell's
 * regions (`ActivityBar`, `Sidebar`, `Panel`, `StatusBar`) subscribe to via
 * {@link SlotRegistry.onDidChange} to know when to re-render.
 *
 * Built with {@link createSlotRegistry} rather than a class, per house
 * convention (matches `createCommandRegistry`, `createContextService`).
 *
 * **Lazy views from manifests** (design.md §4.1's "registerLazy pattern",
 * mirrored here from `commands/registry.ts`): a manifest's
 * `contributes.views` entries reach this module as
 * {@link PendingViewContribution}s (`host/registration.ts`) at construction
 * time, before the owning extension has run any code. Each becomes a lazy
 * entry — present in `getViews`, carrying the manifest's `title`/`icon` so
 * the Shell can render a placeholder immediately, but with no `component`
 * until the extension actually activates and calls
 * `tecode.ui.registerView(slot, id, Component)` itself, which overrides the
 * lazy entry in place (last-wins, exactly like a plain re-registration).
 * {@link SlotRegistry.requestActivation} is the hook the Shell calls when a
 * lazy view is first needed (selected in the sidebar, or a panel tab
 * brought to front) — it activates the owning extension and lets that
 * `registerView` call complete the entry.
 *
 * **`activityBar.item` ↔ `sidebar.view` pairing** (Req 6.2): a `"sidebar"`
 * manifest view registers into `sidebar.view` (lazy, per above) AND
 * synthesizes an `activityBar.item` entry from the same `id`/`title`/`icon`
 * — the activity bar icon can render immediately from static manifest data,
 * without waiting for activation, exactly like VS Code's activity bar.
 * {@link SlotRegistry.listSidebarPairs} is the enumeration helper the
 * `ActivityBar`/`Sidebar` components iterate together.
 *
 * **`statusBar.item` side/priority**: `tecode.ui.registerView`'s public,
 * frozen 3-argument signature (`@tecode/api`'s `UiNamespace.registerView`)
 * carries no side/priority — only `tecode.window.setStatusBarItem` does
 * (`api/stubs.ts`'s `WindowStub`). {@link SlotRegistry.registerView} accepts
 * an optional 4th `meta` argument (host-internal; extra optional trailing
 * parameters do not break its assignability to the narrower
 * `UiNamespace.registerView` type `create.ts` exposes to extensions) so
 * core-internal callers can attach `{ side, priority }` to a `statusBar.item`
 * entry; a plain extension call defaults to `{ side: "left", priority: 0 }`.
 * {@link SlotRegistry.listStatusBarItems} is the sorted-enumeration helper
 * (design.md §8.2: "Status bar items carry `{ side, priority }` and render
 * sorted").
 */

import type { ComponentType, Disposable, Event, Listener, SlotId } from "@tecode/api";
import type { PendingViewContribution } from "../host/registration";
import type { HostError, HostLog } from "../host/errors";

/** Which side of the status bar an entry renders on, and its sort priority
 * within that side (higher first) — mirrors `@tecode/api`'s
 * `StatusBarItem` shape (Req 6.2). */
export interface StatusBarPlacement {
  side: "left" | "right";
  priority: number;
}

/** Optional host-internal metadata a {@link SlotRegistry.registerView} call
 * can attach beyond the frozen `UiNamespace.registerView(slot, id,
 * component)` signature (see this module's TSDoc). */
export interface RegisterViewMeta {
  /** Display title — falls back to the pending manifest view's `title`, if
   * any, when a real registration does not supply one. */
  title?: string;
  /** Icon glyph — same fallback behavior as `title`. */
  icon?: string;
  /** Placement for a `statusBar.item` entry (ignored for every other
   * slot). Defaults to `{ side: "left", priority: 0 }`. */
  statusBar?: StatusBarPlacement;
}

/** One entry in a slot's ordered map (design.md §8.2). `component` is
 * `undefined` while the entry is `lazy` and its owning extension has not
 * yet activated (or has none — a `register()` call always has a
 * `component`, so this only ever happens for pending manifest views). */
export interface SlotViewEntry {
  slot: SlotId;
  id: string;
  component?: ComponentType;
  lazy: boolean;
  /** The extension that owns this entry, for lazy activation
   * (`requestActivation`). `undefined` for a plain runtime `registerView`
   * call with no manifest attribution. */
  extensionId?: string;
  title?: string;
  icon?: string;
  statusBar?: StatusBarPlacement;
}

/** One `{ id, activityItem?, sidebarView? }` pairing (Req 6.2) —
 * {@link SlotRegistry.listSidebarPairs}'s element type. Either side can be
 * absent: an `activityBar.item` registered with no matching `sidebar.view`
 * (or vice versa) still shows up, just with the other half `undefined`. */
export interface SidebarPair {
  id: string;
  activityItem?: SlotViewEntry;
  sidebarView?: SlotViewEntry;
}

/** Dependencies for {@link createSlotRegistry}. */
export interface SlotRegistryDeps {
  /** Manifest-declared views, attributed to their owning extension
   * (`host/registration.ts`'s `LoadExtensionsResult.pendingViews`),
   * consumed once at construction as lazy entries (see this module's
   * TSDoc). Defaults to `[]` — a slot registry built ahead of extension
   * discovery (e.g. `createTecodeApi`'s own internal default) simply starts
   * with no lazy entries. */
  pendingViews?: PendingViewContribution[];
  /** Activate the extension owning a lazy, not-yet-resolved view (Req 2.5,
   * this module's TSDoc). Supplied by `host/activation.ts`'s
   * `createExtensionHost(...).activateExtension` at the assembly layer —
   * see `commands/registry.ts`'s `CommandRegistryDeps.activateExtension`
   * for the same wiring pattern. Optional: omitted (as in every unit test
   * with no host in the picture), {@link SlotRegistry.requestActivation}
   * simply does nothing for a lazy entry. Documented to never throw/reject;
   * guarded anyway so a misbehaving implementation can't break this
   * module's never-throwing contract. */
  activateExtension?: (extensionId: string) => Promise<void>;
  /** Structured log for duplicate-registration warnings and activation
   * failures (design.md §14). Defaults to a discarding no-op log so tests
   * that do not care about logging need not supply one. */
  log?: HostLog;
}

/** The slot registry's public surface. */
export interface SlotRegistry {
  /**
   * Register `component` as the content for view `id` in `slot` (Req 6.3).
   * Last-wins on a duplicate `(slot, id)` — a warning is logged, mirroring
   * `commands/registry.ts`'s `storeEntry` — and completes a lazy entry seeded
   * from a pending manifest view in place, preserving its `title`/`icon`
   * unless `meta` overrides them. Returns a {@link Disposable} that removes
   * the entry; idempotent, and a no-op if a later registration has already
   * superseded it (identity-checked, same as `storeEntry`).
   */
  registerView(
    slot: SlotId,
    id: string,
    component: ComponentType,
    meta?: RegisterViewMeta,
  ): Disposable;
  /** Every entry currently registered in `slot`, in registration order. */
  getViews(slot: SlotId): readonly SlotViewEntry[];
  /** One entry by `(slot, id)`, or `undefined` if nothing is registered
   * there. */
  getView(slot: SlotId, id: string): SlotViewEntry | undefined;
  /**
   * Call when a lazy view is first needed (design.md §8.2: "activating the
   * owning extension lazily if needed") — e.g. the Sidebar switching to a
   * view, or a Panel tab being brought to front. A no-op, and never
   * throws, unless the entry exists, is still `lazy`, has no `component`
   * yet, and carries an `extensionId` with {@link SlotRegistryDeps.activateExtension}
   * wired in. Fire-and-forget: does not await the activation's completion
   * (the entry updates via the normal `registerView` → `onDidChange` path
   * once the extension's own `activate(ctx)` calls it).
   */
  requestActivation(slot: SlotId, id: string): void;
  /** Fires with the {@link SlotId} whose entries changed, on every
   * registration, disposal, or lazy-entry resolution. */
  onDidChange: Event<SlotId>;
  /** Enumerate every `activityBar.item` ↔ `sidebar.view` pairing by shared
   * `id` (Req 6.2) — the union of ids present in either slot. */
  listSidebarPairs(): readonly SidebarPair[];
  /** Every `statusBar.item` entry, sorted by side (`"left"` before
   * `"right"`) then by descending priority, ties broken by registration
   * order (design.md §8.2). */
  listStatusBarItems(): readonly SlotViewEntry[];
}

const ALL_SLOTS: readonly SlotId[] = [
  "activityBar.item",
  "sidebar.view",
  "panel.tab",
  "statusBar.item",
  "editor.viewType",
];

const DEFAULT_STATUS_BAR_PLACEMENT: StatusBarPlacement = { side: "left", priority: 0 };

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `commands/registry.ts`'s `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** A discarding {@link HostLog} — the default when no log is injected
 * (matches this module's `SlotRegistryDeps.log` TSDoc). */
function createNoopLog(): HostLog {
  return {
    append() {
      // Intentionally discarded.
    },
    entries() {
      return [];
    },
  };
}

/** Build a slot registry (Req 6.2, 6.3, 10.1). */
export function createSlotRegistry(deps: SlotRegistryDeps = {}): SlotRegistry {
  const log = deps.log ?? createNoopLog();
  const activateExtension = deps.activateExtension;

  const slots = new Map<SlotId, Map<string, SlotViewEntry>>(
    ALL_SLOTS.map((slot) => [slot, new Map<string, SlotViewEntry>()]),
  );
  const listeners = new Set<Listener<SlotId>>();
  // Guards against re-requesting activation for the same still-lazy entry
  // on every render (the host's own activateExtension is idempotent, but
  // this avoids a redundant call — and its log noise — on every
  // `requestActivation` for an entry already in flight).
  const activationRequested = new Set<string>();

  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  function slotKey(slot: SlotId, id: string): string {
    return `${slot} ${id}`;
  }

  function fireChange(slot: SlotId): void {
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop (matches
    // keymap/context.ts's onDidChange pattern).
    for (const listener of Array.from(listeners)) {
      try {
        listener(slot);
      } catch {
        // Isolate listener failures — one throwing listener must not stop
        // the rest or propagate out of a registration call.
      }
    }
  }

  function storeEntry(slot: SlotId, id: string, entry: SlotViewEntry): Disposable {
    const map = slots.get(slot);
    // ALL_SLOTS seeds every SlotId up front, so this is unreachable for a
    // well-typed caller — guarded defensively rather than asserted, since
    // a Disposable must still be handed back either way.
    if (!map) {
      return {
        dispose() {
          // No-op: ALL_SLOTS seeds every SlotId at construction, so this
          // branch is unreachable for a well-typed caller — nothing was
          // ever stored to remove.
        },
      };
    }

    const existing = map.get(id);
    if (existing && !existing.lazy) {
      logSafely("warning", {
        extensionId: entry.extensionId,
        message: `View re-registered, replacing previous component: ${slot}/${id}`,
      });
    }
    map.set(id, entry);
    activationRequested.delete(slotKey(slot, id));
    fireChange(slot);

    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (map.get(id) === entry) {
          map.delete(id);
          fireChange(slot);
        }
      },
    };
  }

  function registerView(
    slot: SlotId,
    id: string,
    component: ComponentType,
    meta?: RegisterViewMeta,
  ): Disposable {
    const existing = slots.get(slot)?.get(id);
    const entry: SlotViewEntry = {
      slot,
      id,
      component,
      lazy: false,
      extensionId: existing?.extensionId,
      title: meta?.title ?? existing?.title,
      icon: meta?.icon ?? existing?.icon,
      statusBar:
        slot === "statusBar.item"
          ? (meta?.statusBar ?? existing?.statusBar ?? DEFAULT_STATUS_BAR_PLACEMENT)
          : undefined,
    };
    return storeEntry(slot, id, entry);
  }

  function getViews(slot: SlotId): readonly SlotViewEntry[] {
    return Array.from(slots.get(slot)?.values() ?? []);
  }

  function getView(slot: SlotId, id: string): SlotViewEntry | undefined {
    return slots.get(slot)?.get(id);
  }

  function requestActivation(slot: SlotId, id: string): void {
    const entry = slots.get(slot)?.get(id);
    if (!entry || !entry.lazy || entry.component || !entry.extensionId || !activateExtension) {
      return;
    }
    const key = slotKey(slot, id);
    if (activationRequested.has(key)) return;
    activationRequested.add(key);
    try {
      const result = activateExtension(entry.extensionId);
      // activateExtension is documented to never throw/reject; guard
      // anyway (matches commands/registry.ts's execute()) so a
      // misbehaving implementation can't break this never-throwing
      // contract, and so a rejected activation lets a later
      // requestActivation try again instead of being permanently stuck.
      Promise.resolve(result)
        .catch((cause: unknown) => {
          logSafely("error", {
            extensionId: entry.extensionId,
            message: `activateExtension("${entry.extensionId}") threw: ${describeError(cause)}`,
          });
        })
        .finally(() => {
          activationRequested.delete(key);
        });
    } catch (cause) {
      activationRequested.delete(key);
      logSafely("error", {
        extensionId: entry.extensionId,
        message: `activateExtension("${entry.extensionId}") threw: ${describeError(cause)}`,
      });
    }
  }

  function onDidChange(listener: Listener<SlotId>): Disposable {
    listeners.add(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      },
    };
  }

  function listSidebarPairs(): readonly SidebarPair[] {
    const activityItems = slots.get("activityBar.item") ?? new Map();
    const sidebarViews = slots.get("sidebar.view") ?? new Map();
    const ids = new Set<string>([...activityItems.keys(), ...sidebarViews.keys()]);
    return Array.from(ids).map((id) => ({
      id,
      activityItem: activityItems.get(id),
      sidebarView: sidebarViews.get(id),
    }));
  }

  function listStatusBarItems(): readonly SlotViewEntry[] {
    const entries = getViews("statusBar.item");
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const placementA = a.entry.statusBar ?? DEFAULT_STATUS_BAR_PLACEMENT;
        const placementB = b.entry.statusBar ?? DEFAULT_STATUS_BAR_PLACEMENT;
        if (placementA.side !== placementB.side) {
          return placementA.side === "left" ? -1 : 1;
        }
        if (placementA.priority !== placementB.priority) {
          return placementB.priority - placementA.priority;
        }
        return a.index - b.index;
      })
      .map(({ entry }) => entry);
  }

  // Seed lazy entries from manifest-declared views (this module's TSDoc).
  for (const pending of deps.pendingViews ?? []) {
    const targetSlot: SlotId = pending.view.slot === "sidebar" ? "sidebar.view" : "panel.tab";
    storeEntry(targetSlot, pending.view.id, {
      slot: targetSlot,
      id: pending.view.id,
      lazy: true,
      extensionId: pending.extensionId,
      title: pending.view.title,
      icon: pending.view.icon,
    });
    if (pending.view.slot === "sidebar") {
      storeEntry("activityBar.item", pending.view.id, {
        slot: "activityBar.item",
        id: pending.view.id,
        lazy: false,
        extensionId: pending.extensionId,
        title: pending.view.title,
        icon: pending.view.icon,
      });
    }
  }

  return {
    registerView,
    getViews,
    getView,
    requestActivation,
    onDidChange,
    listSidebarPairs,
    listStatusBarItems,
  };
}
