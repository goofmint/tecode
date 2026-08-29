/**
 * `createTerminalSessionTracker` (Issue #98 Phase 3/5): wraps a real
 * `TerminalNamespace` (`@tecode/core`'s `createTerminalService`, Issue #98
 * Phases 1-2, unmodified) to additionally track the most-recently-spawned
 * still-live `PtySession` — the "active session" `keyRouting.ts`'s
 * terminal-forwarding branch writes every terminal-focused keystroke into.
 *
 * **Why this exists in `packages/cli`, not `@tecode/core`'s
 * `terminal/ptyService.ts`**: "which session is the active one" is a pure
 * MVP UI-level policy (Issue #98's own scope note: "Out of scope for this
 * issue: ... multiple concurrent terminals" — one terminal at a time is
 * the whole reason "the most recent spawn" is an unambiguous answer at
 * all), not something the pty SERVICE itself has any business knowing
 * about — `ptyService.ts` is deliberately untouched by this issue's second
 * half (verified working end to end already). Composing this wrapper here
 * instead keeps that module's own scope exactly what it was.
 *
 * **Why `keyRouting.ts` doesn't just reach into the terminal built-in's
 * own store directly**: `packages/builtin` extensions are opaque to
 * `packages/cli`'s composition root by design (Req 2.1's extension
 * boundary) — `main.ts` discovers and activates them generically through
 * `loadExtensions`/`ExtensionHost`, with no typed handle back into any
 * specific extension's internals. The wrapped `spawn` below is the one
 * place `main.ts` legitimately sees EVERY `PtySession` a `tecode.terminal`
 * consumer (any extension, not just the built-in one) ever creates,
 * because `createTecodeApi`'s `deps.terminal` is exactly this wrapper —
 * every `ctx.api.terminal.spawn(...)` call an extension makes already
 * passes through it on its way to the real service.
 */

import type { PtySession, PtySpawnOptions, TerminalNamespace } from "@tecode/api";

/** {@link createTerminalSessionTracker}'s return type — the full
 * `TerminalNamespace` (so it drops straight into `CreateTecodeApiDeps.
 * terminal`, `@tecode/core`'s `create.ts`) plus the two extra reads
 * `keyRouting.ts`'s terminal-forwarding branch needs. */
export interface TerminalSessionTracker extends TerminalNamespace {
  /** Write `data` to the most-recently-spawned still-live session — a
   * silent no-op (never throws, matches every `PtySession` method's own
   * never-throwing contract) when no session has ever spawned, or the
   * last one spawned has since exited/been disposed. */
  writeToActiveSession(data: string): void;
  /** Whether a live active session currently exists — mostly for tests;
   * `keyRouting.ts` itself never needs to check this separately (writing
   * to no session is already a harmless no-op). */
  hasActiveSession(): boolean;
}

/**
 * Build a {@link TerminalSessionTracker} wrapping `inner` (this module's
 * TSDoc). `inner.spawn`'s REAL return value is always handed back to the
 * caller completely unmodified in substance — every `write`/`resize`/
 * `onData`/`onExit` call the extension makes still reaches `inner`'s own
 * session directly; only `dispose` is wrapped, purely to notice locally
 * when the tracked "active" session should be cleared (this function's
 * own `spawn`'s inline comment).
 */
export function createTerminalSessionTracker(
  inner: Pick<TerminalNamespace, "isSupported" | "spawn">,
): TerminalSessionTracker {
  let active: PtySession | undefined;

  function spawn(options: PtySpawnOptions): PtySession {
    const session = inner.spawn(options);
    active = session;

    // A session that exits on its own (the child process died) must stop
    // being "active" the same way an explicit `dispose()` does below —
    // `PtySession.onExit`'s own TSDoc: fires exactly once, never again,
    // including never for `dispose()` itself, which is why `dispose` is
    // ALSO wrapped separately rather than relying on this alone.
    session.onExit(() => {
      if (active === session) active = undefined;
    });

    return {
      write: session.write,
      resize: session.resize,
      onData: session.onData,
      onExit: session.onExit,
      dispose() {
        if (active === session) active = undefined;
        session.dispose();
      },
    };
  }

  return {
    isSupported: () => inner.isSupported(),
    spawn,
    writeToActiveSession(data) {
      active?.write(data);
    },
    hasActiveSession() {
      return active !== undefined;
    },
  };
}
