/**
 * `createTerminalStore` (Issue #98 Phase 4): framework-independent
 * terminal-session state — spawns/respawns/disposes the one `PtySession`
 * this MVP terminal panel drives, and brokers the imperative "focus this
 * panel" request between `index.ts`'s commands and whichever
 * `TerminalView` instance is currently mounted (`Panel` fully unmounts its
 * hidden tab's component — `@tecode/core`'s `shell.tsx`'s `Panel` TSDoc —
 * so "currently mounted" is not a given at the moment a command runs).
 * Mirrors `explorer/store.ts`'s shape: an `onDidChange` emitter, no React
 * import, `@tecode/api` types only.
 */

import type { Disposable, Event, Listener, PtySession, PtySpawnOptions } from "@tecode/api";

/** Dependencies for {@link createTerminalStore}. */
export interface TerminalStoreDeps {
  /** `ctx.api.terminal.spawn` — narrowed to the one method this store
   * calls (matches `explorer/index.ts`'s own narrow closures over
   * `ctx.api.*`). */
  spawn: (options: PtySpawnOptions) => PtySession;
  /** Argv for the spawned process — `index.ts`'s own default (the user's
   * shell). Fixed for this store's whole lifetime; `respawn()` reuses it. */
  cmd: string[];
  cwd?: string;
  /** Initial pty size — used only for the very first `spawn()`/
   * `respawn()` call; `TerminalGridView`'s own resize effect
   * (`@tecode/core`'s `terminalGridView.tsx`) immediately corrects this
   * once the real panel dimensions are known, so an approximate default
   * (80x24, `index.ts`'s own choice) is fine here. */
  initialCols: number;
  initialRows: number;
}

/** {@link createTerminalStore}'s return type. */
export interface TerminalStore {
  /** The current live session, or `undefined` before the first {@link
   * ensureSession}/{@link respawn} call. */
  getSession(): PtySession | undefined;
  /** Returns the current session, spawning one via `deps.spawn` first if
   * none exists yet — idempotent: a second call with a still-live session
   * returns the SAME session, never spawning a redundant one. */
  ensureSession(): PtySession;
  /** Dispose the current session (if any) and spawn a fresh one — Issue
   * #98's MVP "new terminal" (this module's TSDoc: "new" means "restart",
   * not "open a second one"). */
  respawn(): PtySession;
  /** Dispose the current session, if any. Idempotent — matches every
   * `PtySession.dispose`'s own contract. Called from `index.ts`'s
   * `deactivate()`. */
  dispose(): void;
  /** Fires whenever {@link getSession}'s return value would change (a
   * fresh spawn, a respawn, or the session exiting/being disposed) — the
   * built-in's `TerminalView.tsx` subscribes to force a re-render with
   * the new session. */
  onDidChange: Event<void>;
  /**
   * Request that the terminal panel grab real OpenTUI focus (Issue #98
   * Phase 4). If a `TerminalView` instance is CURRENTLY mounted and has
   * already published its focus handle (`registerFocusHandle` below —
   * mirrors `@tecode/core`'s `shell.tsx`'s `EditorArea.
   * onEditorFocusHandleChange`), that handle is called immediately.
   * Otherwise (the panel was hidden — `Panel` fully unmounts its content
   * while hidden, so no handle exists yet) the request is remembered as
   * PENDING and consumed the next time {@link registerFocusHandle} runs
   * (the fresh mount that follows `workbench.action.showPanel` making the
   * panel visible again) — mirrors `@tecode/core`'s `shell.tsx`'s
   * `EditorArea`'s own `pendingFocusUriRef` "deferred, never discarded"
   * shape, simplified for this store's single boolean case.
   */
  requestFocus(): void;
  /** Called by the currently-mounted `TerminalView` (via `tecode.ui.
   * Terminal`'s own `onFocusHandleChange` prop) with a fresh imperative
   * focus handle, or `undefined` on unmount. Consumes a pending {@link
   * requestFocus} call immediately if one is outstanding. */
  registerFocusHandle(focus: (() => void) | undefined): void;
}

/** Build a {@link TerminalStore} (this module's TSDoc). */
export function createTerminalStore(deps: TerminalStoreDeps): TerminalStore {
  let session: PtySession | undefined;
  let focusHandle: (() => void) | undefined;
  let focusPending = false;
  const listeners = new Set<Listener<void>>();

  function fireChange(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures — matches `explorer/store.ts`'s own
        // guarded dispatch.
      }
    }
  }

  function spawnOptions(): PtySpawnOptions {
    return { cmd: deps.cmd, cwd: deps.cwd, cols: deps.initialCols, rows: deps.initialRows };
  }

  function attachExitHandling(newSession: PtySession): void {
    // A session that exits on its own (the shell was closed with `exit`,
    // the child crashed, ...) must stop being "the current session".
    // `PtySession.onExit`'s own TSDoc: it also fires when `dispose()`
    // itself caused the exit (killing the child makes it genuinely
    // exit) — so this same listener also sees the OLD session's exit
    // when `respawn()` below calls `session?.dispose()`. That is
    // harmless here: by the time a disposed session's exit lands (always
    // after `dispose()`'s own synchronous `proc.kill()` returns), `respawn`
    // has already reassigned `session` to the NEW session, so the `session
    // === newSession` guard below is false for the old one and this
    // becomes a no-op.
    newSession.onExit(() => {
      if (session === newSession) {
        session = undefined;
        fireChange();
      }
    });
  }

  function ensureSession(): PtySession {
    if (session) return session;
    // `deps.spawn` (`TerminalNamespace.spawn`) is documented
    // never-throwing (`@tecode/api`'s own TSDoc) — no guard needed here,
    // matching `explorer/store.ts`'s own trust of equally-documented
    // never-throwing collaborators.
    session = deps.spawn(spawnOptions());
    attachExitHandling(session);
    fireChange();
    return session;
  }

  function respawn(): PtySession {
    // `PtySession.dispose`/`TerminalNamespace.spawn` are both documented
    // never-throwing (`@tecode/api`) — trusted directly, matching
    // `ensureSession`'s own reasoning above.
    session?.dispose();
    session = deps.spawn(spawnOptions());
    attachExitHandling(session);
    fireChange();
    return session;
  }

  function dispose(): void {
    if (!session) return;
    session.dispose();
    session = undefined;
    // Fires for the same reason `ensureSession`/`respawn` do:
    // `getSession()`'s return value just changed (to `undefined`), and
    // {@link TerminalStore.onDidChange}'s own TSDoc promises an event for
    // exactly that. Without it a still-mounted `TerminalView` keeps
    // rendering the session it was last handed — one that is now disposed
    // — until some unrelated re-render happens to correct it. Safe to
    // fire here: the only subscriber (`TerminalView.tsx`) just calls
    // `forceRender()`, and nothing in that path re-enters this store.
    fireChange();
  }

  function requestFocus(): void {
    if (focusHandle) {
      focusHandle();
      return;
    }
    focusPending = true;
  }

  function registerFocusHandle(focus: (() => void) | undefined): void {
    focusHandle = focus;
    if (focusPending && focusHandle) {
      focusPending = false;
      focusHandle();
    }
  }

  function onDidChange(listener: Listener<void>): Disposable {
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

  return {
    getSession: () => session,
    ensureSession,
    respawn,
    dispose,
    onDidChange,
    requestFocus,
    registerFocusHandle,
  };
}
