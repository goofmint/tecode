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
   *
   * `component` is optional here — wider than `@tecode/api`'s
   * `UiNamespace.registerView`, which always requires one (a function
   * assignable to a required-parameter type may itself accept `undefined`
   * too; `create.ts`'s `uiNamespace.registerView` stays exactly as strict as
   * extensions see). A core-internal caller with no component to render
   * (Task 3.1's `windowService.ts` backing `tecode.window.setStatusBarItem`
   * with a plain text item) omits it and gets `SlotViewEntry.component:
   * undefined` — `StatusBar` (`shell.tsx`) already falls back to rendering
   * `item.title` as plain text in exactly that case.
   */
  registerView(
    slot: SlotId,
    id: string,
    component?: ComponentType,
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
  /**
   * Seed additional manifest-declared views as lazy entries, exactly like
   * {@link SlotRegistryDeps.pendingViews} does at construction time (this
   * module's TSDoc's "Lazy views from manifests") — same
   * `activityBar.item`/`sidebar.view` pairing synthesis for a `"sidebar"`
   * view, same `lazy: true` placeholder rationale, same last-wins/
   * duplicate-warning semantics as {@link registerView}.
   *
   * **Why this exists, given `SlotRegistryDeps.pendingViews` already
   * covers construction time**: `packages/cli/src/main.ts`'s
   * `buildAssemblyRoot` (the synchronous startup phase, design.md §3's
   * step 1) builds the slot registry — and the Shell that renders from
   * it — before extension discovery has run at all; `host/registration.ts`'s
   * `loadExtensions` (and its `LoadExtensionsResult.pendingViews`) only
   * runs in the *deferred* phase (`runDeferredPhase`, design.md §3's step
   * 2), after the first frame. A registry built with `pendingViews`
   * supplied only at construction can never learn about a manifest's
   * `contributes.views` at all in this codebase's actual startup order —
   * every `sidebar.view`/`activityBar.item` a real extension declares
   * (e.g. `tecode.explorer`'s `sidebar` view, `explorer/manifest.ts`)
   * would sit unregistered until something else happened to call
   * {@link registerView} directly. `runDeferredPhase` calls this method
   * with `loadResult.pendingViews` right after `loadExtensions` returns,
   * the same place it feeds `loadResult.extensionKeybindings` into
   * `keymap.setExtensionEntries` and `loadResult.pendingThemes`/
   * `pendingLanguages` into `themeRegistry`/`languageRegistry`'s own
   * `loadContributions` calls.
   *
   * Idempotent-ish/last-wins in the same sense {@link registerView} is: a
   * `(slot, id)` already resolved to a real (non-lazy) registration is
   * NOT overwritten (a real registration always wins over a pending
   * placeholder — reseeding must not regress an already-completed entry
   * back to `lazy: true` with no `component`). Safe to call multiple
   * times (e.g. a future incremental-discovery caller re-scanning a
   * workspace) and safe to call with zero pending views.
   */
  seedPendingViews(pending: readonly PendingViewContribution[]): void;
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
    component?: ComponentType,
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
    const activityItems = slots.get("activityBar.item") ?? new Map<string, SlotViewEntry>();
    const sidebarViews = slots.get("sidebar.view") ?? new Map<string, SlotViewEntry>();
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

  /** Seed one manifest-declared view as a lazy entry — shared by the
   * construction-time loop below and the public
   * {@link SlotRegistry.seedPendingViews} method (that method's TSDoc), so
   * a manifest view goes through the exact same
   * `activityBar.item`/`sidebar.view` pairing synthesis regardless of
   * whether discovery supplied it before or after this registry was
   * built. Skips a target `(slot, id)` that already holds a REAL
   * (non-lazy) registration — reseeding must never regress an
   * already-completed entry back to a lazy placeholder with no
   * `component` ({@link SlotRegistry.seedPendingViews}'s TSDoc); a still-
   * lazy existing entry (or none at all) is safely re-stored, last-wins,
   * with no warning either way (`storeEntry`'s duplicate-registration
   * warning only fires against a non-lazy existing entry). */
  function seedPendingView(pending: PendingViewContribution): void {
    const targetSlot: SlotId = pending.view.slot === "sidebar" ? "sidebar.view" : "panel.tab";
    const existingTarget = slots.get(targetSlot)?.get(pending.view.id);
    if (!existingTarget || existingTarget.lazy) {
      storeEntry(targetSlot, pending.view.id, {
        slot: targetSlot,
        id: pending.view.id,
        lazy: true,
        extensionId: pending.extensionId,
        title: pending.view.title,
        icon: pending.view.icon,
      });
    }
    if (pending.view.slot === "sidebar") {
      // `lazy: true`, not `false`: this is a synthesized placeholder (Req
      // 6.2's activityBar.item/sidebar.view pairing, this module's TSDoc),
      // not a real registration. `storeEntry`'s duplicate-registration
      // warning only fires against a non-lazy existing entry, so marking
      // this one `lazy: false` would make the extension's later, real
      // `registerView("activityBar.item", id, ...)` call log a spurious
      // "View re-registered" warning for a view that was never actually
      // registered twice. `ActivityBar` (shell.tsx) renders on `component`
      // presence, not `lazy`, so this has no rendering effect.
      const existingActivityItem = slots.get("activityBar.item")?.get(pending.view.id);
      if (!existingActivityItem || existingActivityItem.lazy) {
        storeEntry("activityBar.item", pending.view.id, {
          slot: "activityBar.item",
          id: pending.view.id,
          lazy: true,
          extensionId: pending.extensionId,
          title: pending.view.title,
          icon: pending.view.icon,
        });
      }
    }
  }

  function seedPendingViews(pending: readonly PendingViewContribution[]): void {
    for (const one of pending) seedPendingView(one);
  }

  // Seed lazy entries from manifest-declared views supplied at construction
  // (this module's TSDoc) — the same {@link seedPendingView} the public
  // {@link SlotRegistry.seedPendingViews} method uses.
  for (const pending of deps.pendingViews ?? []) {
    seedPendingView(pending);
  }

  return {
    registerView,
    getViews,
    getView,
    requestActivation,
    onDidChange,
    listSidebarPairs,
    listStatusBarItems,
    seedPendingViews,
  };
}
