/**
 * `createHostErrorStatusSink` (Task 3.4, Req 11.6, design.md §13/§14): the
 * real `StatusSink` implementation the composition root wires in place of
 * `host/errors.ts`'s `createNoopStatusSink` — `main.ts`'s own TSDoc named
 * this exact gap: "nothing wires host/command errors into it yet — that is
 * the statusbar built-in's job... or a later notification-area task."
 *
 * Follows `windowMessageService.ts`'s `showMessage` mechanics exactly (the
 * plan's "reuse windowMessageService's auto-clear pattern"): each
 * `error(err)` call registers ONE well-known `statusBar.item` id — so a
 * second error REPLACES the first rather than stacking — with a high
 * `priority` (renders leftmost) and auto-clears itself after
 * {@link HostErrorStatusSinkDeps.timeoutMs} via an injectable timer (house
 * convention — matches `layoutState.ts`'s/`windowMessageService.ts`'s own
 * injectable-timer seams, so tests observe schedule/cancel calls directly
 * instead of racing a real `setTimeout`).
 *
 * **Priority, relative to `tecode.window.showMessage`**: `HOST_ERROR_
 * PRIORITY` is deliberately HIGHER than `windowMessageService.ts`'s
 * `WINDOW_MESSAGE_STATUS_BAR_ITEM_ID` registration (1,000,000) — a host/
 * command-level failure (an unknown command, a manifest that failed
 * validation, a readonly-document edit) is systemic host feedback, not an
 * ordinary extension notice, and should never be visually buried behind
 * one. The two use different ids, so they coexist (both visible at once)
 * rather than one replacing the other.
 *
 * **Deliberately does NOT also call `log.append`**: every existing caller
 * of `sink.error(...)` in this codebase (`commands/registry.ts`,
 * `documentManager.ts`, ...) already calls `log.append` itself, as a
 * SEPARATE notification path (`registry.ts`'s `logSafely`/`notifySafely`
 * calling both independently) — this sink only owns the status-bar
 * surface; duplicating the log write here would double-record every error.
 */

import type { Disposable } from "@tecode/api";
import type { HostError, StatusSink } from "../host/errors";
import type { SlotRegistry } from "./slotRegistry";

/** The well-known `statusBar.item` id every `error()` call reuses (this
 * module's TSDoc's "replace, don't stack") — namespaced like every other
 * core-owned id (`theme.select`, `tecode.window.message`). */
export const HOST_ERROR_STATUS_BAR_ITEM_ID = "tecode.host.error";

/** Renders leftmost, ahead of `tecode.window.message` (this module's
 * TSDoc). */
export const HOST_ERROR_STATUS_BAR_PRIORITY = 2_000_000;

/** How long a host error notice stays visible before auto-clearing, when
 * {@link HostErrorStatusSinkDeps.timeoutMs} is not given — longer than
 * `windowMessageService.ts`'s `DEFAULT_MESSAGE_TIMEOUT_MS` (5s): a host/
 * command-level failure is lower-frequency but typically more consequential
 * than an ordinary `showMessage` notice, so it deserves more time on
 * screen before disappearing. */
export const DEFAULT_HOST_ERROR_TIMEOUT_MS = 8000;

/** Dependencies for {@link createHostErrorStatusSink}. */
export interface HostErrorStatusSinkDeps {
  /** The live slot registry the rendered Shell's `StatusBar` reads from —
   * narrowed to `registerView`, the only method this sink calls. */
  slotRegistry: Pick<SlotRegistry, "registerView">;
  /** Injectable `setTimeout` (this module's TSDoc) — defaults to the real
   * global. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  /** Injectable `clearTimeout` counterpart — defaults to the real global. */
  clearTimeout?: (handle: unknown) => void;
  /** Overrides {@link DEFAULT_HOST_ERROR_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** {@link createHostErrorStatusSink}'s return shape. */
export interface HostErrorStatusSink extends StatusSink {
  /** Clears any pending error notice/timer immediately — called on
   * shutdown so a headless run's final registration doesn't linger
   * (matches `WindowMessageService.dispose`). Idempotent. */
  dispose(): void;
}

/** Render a `HostError` as the status bar item's text (Req 3.4, 3.5,
 * design.md §14): the message, prefixed with the offending extension id
 * when known (a manifest-validation or `activate()` failure attributed to
 * one extension), matching the shape `HostLogEntry` already carries. */
function formatHostError(err: HostError): string {
  const prefix = err.extensionId ? `[${err.extensionId}] ` : "";
  return `✖ ${prefix}${err.message}`;
}

/** Build a {@link HostErrorStatusSink} (Task 3.4, Req 11.6). */
export function createHostErrorStatusSink(deps: HostErrorStatusSinkDeps): HostErrorStatusSink {
  const { slotRegistry } = deps;
  const scheduleTimeout = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HOST_ERROR_TIMEOUT_MS;

  let pendingItem: Disposable | undefined;
  let pendingTimer: unknown;

  /** Cancel whatever error notice/timer is currently pending, if any —
   * shared by `error` (replacing the previous notice) and `dispose` (this
   * module's TSDoc). */
  function clearPending(): void {
    if (pendingTimer !== undefined) {
      try {
        cancelTimeout(pendingTimer);
      } catch {
        // Never let a broken timer implementation break error handling.
      }
      pendingTimer = undefined;
    }
    pendingItem?.dispose();
    pendingItem = undefined;
  }

  function error(err: HostError): void {
    clearPending();
    // `component` omitted deliberately, matching `windowMessageService.ts`'s
    // `setStatusBarItem` — `StatusBar` (`shell.tsx`) already renders
    // `item.title` as plain text whenever a `statusBar.item` entry has no
    // component.
    pendingItem = slotRegistry.registerView("statusBar.item", HOST_ERROR_STATUS_BAR_ITEM_ID, undefined, {
      title: formatHostError(err),
      statusBar: { side: "left", priority: HOST_ERROR_STATUS_BAR_PRIORITY },
    });
    pendingTimer = scheduleTimeout(() => {
      pendingTimer = undefined;
      pendingItem?.dispose();
      pendingItem = undefined;
    }, timeoutMs);
  }

  function dispose(): void {
    clearPending();
  }

  return { error, dispose };
}
