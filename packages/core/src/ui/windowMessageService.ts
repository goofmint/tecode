/**
 * `WindowMessageService` (Task 3.1, Req 10.1's `tecode.window.showMessage`/
 * `setStatusBarItem`): the real backing for `WindowNamespace.
 * setStatusBarItem` — a plain, disposable `statusBar.item` registration
 * against the SAME live {@link SlotRegistry} the rendered `Shell`'s
 * `StatusBar` reads from (`shell.tsx`'s `useStatusBarItems`) — and
 * `showMessage`, built as a transient use of THAT SAME registration path
 * rather than a second, parallel one (this task's plan: "unify with
 * `window.setStatusBarItem`'s mechanism").
 *
 * **Why `setStatusBarItem` needed a real backing at all in this task**:
 * before Task 3.1, `create.ts` wired `tecode.window.setStatusBarItem`
 * straight to `stubs.ts`'s `createWindowStub()`, which registers into its
 * OWN internal `Set` — never the real `SlotRegistry` `StatusBar` (`shell.
 * tsx`) actually renders from (`stubs.ts`'s own TSDoc: "no renderer yet to
 * observe it through"). `showMessage`'s spec ("route to the status bar via
 * the EXISTING SlotRegistry statusBar.item path") only has an existing path
 * to reuse once `setStatusBarItem` itself is real — so this module gives
 * BOTH a genuine backing together, rather than routing `showMessage`
 * through a bespoke mechanism `setStatusBarItem` doesn't share.
 *
 * **`StatusBar`'s text-fallback rendering, reused as-is**: `shell.tsx`'s
 * `StatusBar.renderItem` already renders `item.title ?? item.id` as plain
 * `<text>` whenever a `statusBar.item` entry has no `component` (its own
 * TSDoc/body) — exactly the "no new rendering" the plan calls for.
 * `setStatusBarItem` therefore calls `slotRegistry.registerView(
 * "statusBar.item", item.id, undefined, { title: item.text, statusBar:
 * {...} })` (component omitted — `SlotRegistry.registerView`'s `component`
 * param is optional precisely for this caller, see its own TSDoc) rather
 * than wrapping `item.text` in a throwaway `ComponentType`.
 *
 * **`showMessage`'s transience** (Req 10.1; no notification-area/toast
 * mechanism exists yet, design.md §14's error-reporting story is still
 * "surface through the status bar" for the MVP): each call registers ONE
 * well-known `statusBar.item` id (so a second message REPLACES the first
 * rather than stacking) with a high `priority` (renders leftmost among
 * `"left"`-side items — `slotRegistry.ts`'s `listStatusBarItems` sort) and
 * a `kind`-dependent glyph prefix, then disposes it again after
 * {@link WindowMessageServiceDeps.messageTimeoutMs}. The timer is an
 * injectable seam (house convention — matches `layoutState.ts`'s/
 * `themeSettingsWriter.ts`'s own injectable-timer seams) so tests can
 * observe the schedule/cancel calls directly instead of racing a real
 * `setTimeout`.
 */

import type { Disposable, MessageKind, StatusBarItem } from "@tecode/api";
import type { SlotRegistry } from "./slotRegistry";

/** The well-known `statusBar.item` id every `showMessage` call reuses
 * (this module's TSDoc's "replace, don't stack"). Namespaced like every
 * other core-owned id in this codebase (`theme.select`, `modal.accept`). */
export const WINDOW_MESSAGE_STATUS_BAR_ITEM_ID = "tecode.window.message";

/** How long a `showMessage` notice stays visible before auto-clearing,
 * when {@link WindowMessageServiceDeps.messageTimeoutMs} is not given. */
export const DEFAULT_MESSAGE_TIMEOUT_MS = 5000;

/** Dependencies for {@link createWindowMessageService}. */
export interface WindowMessageServiceDeps {
  /** The live slot registry `Shell`'s `StatusBar` renders from — narrowed
   * to `registerView`, the only method this service calls. */
  slotRegistry: Pick<SlotRegistry, "registerView">;
  /** Injectable `setTimeout` (this module's TSDoc) — defaults to the real
   * global. Matches the return type of the real `setTimeout` loosely (`
   * unknown`) so a test's fake scheduler need not fabricate a real timer
   * handle. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  /** Injectable `clearTimeout` counterpart — defaults to the real global. */
  clearTimeout?: (handle: unknown) => void;
  /** Overrides {@link DEFAULT_MESSAGE_TIMEOUT_MS}. */
  messageTimeoutMs?: number;
}

/** {@link createWindowMessageService}'s return shape. */
export interface WindowMessageService {
  /**
   * Identity token: the exact `SlotRegistry` this service registers its
   * `statusBar.item` views against. `createTecodeApi` compares it against
   * its own `slotRegistry` dep and falls back to the window stub on a
   * mismatch — a service registered against registry B while the rendered
   * `Shell`'s `StatusBar` reads registry A would otherwise accept
   * `showMessage` calls that never render anywhere (the same
   * cross-instance guard as `FindService.session`).
   */
  readonly registry: WindowMessageServiceDeps["slotRegistry"];
  /** The real `WindowNamespace.setStatusBarItem` backing (this module's
   * TSDoc). */
  setStatusBarItem(item: StatusBarItem): Disposable;
  /** The real `WindowNamespace.showMessage` backing (this module's TSDoc). */
  showMessage(message: string, kind?: MessageKind): void;
  /** Clears any pending `showMessage` notice/timer immediately — called on
   * shutdown so a headless run's final `statusBar.item` registration
   * doesn't linger (matches every other startup-owned subscription's
   * disposal in `main.ts`'s `wireProcessExit`). Idempotent. */
  dispose(): void;
}

/** The glyph prefix for each `MessageKind` (Req 10.1) — undecorated for a
 * missing/unrecognized kind, matching `showMessage`'s own optional `kind`
 * parameter. */
function kindGlyph(kind: MessageKind | undefined): string {
  switch (kind) {
    case "warning":
      return "⚠ ";
    case "error":
      return "✖ ";
    case "info":
      return "ℹ ";
    default:
      return "";
  }
}

/** Build a {@link WindowMessageService} (Task 3.1, Req 10.1). */
export function createWindowMessageService(deps: WindowMessageServiceDeps): WindowMessageService {
  const { slotRegistry } = deps;
  const scheduleTimeout = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const messageTimeoutMs = deps.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;

  let pendingMessage: Disposable | undefined;
  let pendingTimer: unknown;

  function setStatusBarItem(item: StatusBarItem): Disposable {
    // `component` omitted deliberately (this module's TSDoc) — `StatusBar`
    // (`shell.tsx`) already renders `item.title` as plain text whenever a
    // `statusBar.item` entry has no component.
    return slotRegistry.registerView("statusBar.item", item.id, undefined, {
      title: item.text,
      statusBar: { side: item.side, priority: item.priority },
    });
  }

  /** Cancel whatever `showMessage` notice/timer is currently pending, if
   * any — shared by `showMessage` (replacing the previous notice) and
   * `dispose` (this module's TSDoc). */
  function clearPendingMessage(): void {
    if (pendingTimer !== undefined) {
      try {
        cancelTimeout(pendingTimer);
      } catch {
        // Never let a broken timer implementation break message handling.
      }
      pendingTimer = undefined;
    }
    pendingMessage?.dispose();
    pendingMessage = undefined;
  }

  function showMessage(message: string, kind?: MessageKind): void {
    clearPendingMessage();
    pendingMessage = setStatusBarItem({
      id: WINDOW_MESSAGE_STATUS_BAR_ITEM_ID,
      text: `${kindGlyph(kind)}${message}`,
      side: "left",
      // Highest realistic priority (design.md §8.2's "sorted... by
      // descending priority") — a transient user-facing notice should read
      // before any extension's own left-side status item.
      priority: 1_000_000,
    });
    pendingTimer = scheduleTimeout(() => {
      pendingTimer = undefined;
      pendingMessage?.dispose();
      pendingMessage = undefined;
    }, messageTimeoutMs);
  }

  function dispose(): void {
    clearPendingMessage();
  }

  return { registry: slotRegistry, setStatusBarItem, showMessage, dispose };
}
