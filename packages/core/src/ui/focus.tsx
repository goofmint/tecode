/**
 * `ContextFocusTracker`/`useFocusTracking()` (Req 4.6, design.md §8.1: "maps
 * OpenTUI focus → context keys"; Task 1.14). No new context store is
 * introduced — every focus change is reported through the existing
 * `createContextService().set` (`keymap/context.ts`), the same store `when`
 * clauses already read (design.md §6.4), so a keybinding's `when:
 * "editorFocus"` works identically whether the context key was set by the
 * keymap service or by this module.
 *
 * **How it observes focus**: OpenTUI's `Renderable` (`@opentui/core`)
 * extends Node's `EventEmitter` and emits `RenderableEvents.FOCUSED`/
 * `BLURRED` on itself (not a single renderer-wide focus event) when
 * `.focus()`/`.blur()` runs — including the OpenTUI-internal single-focus
 * bookkeeping that blurs whatever was previously focused. {@link useFocusTracking}
 * returns a `ref` callback a component attaches to one focusable OpenTUI
 * intrinsic (`<box ref={useFocusTracking("editorFocus")} focusable>`); it
 * subscribes to that specific instance's `FOCUSED`/`BLURRED` events (handling
 * both focus gain AND loss, per this task's requirement) and unsubscribes
 * from the previous instance whenever the ref target changes or the owning
 * component unmounts.
 */

import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";
import { RenderableEvents } from "@opentui/core";
import type { ContextService } from "../keymap/context";

/** The narrow slice of an OpenTUI `Renderable` {@link useFocusTracking}
 * needs — `Renderable`'s own `EventEmitter`-derived `on`/`off` (matches how
 * little of the underlying type most of this codebase's seams need). */
export interface FocusEmitter {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

const FocusContextServiceContext = createContext<ContextService | undefined>(undefined);

/** Props for {@link ContextFocusTracker}. */
export interface ContextFocusTrackerProps {
  /** The context service focus changes are reported to (`tecode.context`'s
   * backing implementation, `keymap/context.ts`). */
  context: ContextService;
  children?: ReactNode;
}

/**
 * Makes `context` available to every {@link useFocusTracking} call beneath
 * it (design.md §8.1's component tree: `<ContextFocusTracker>` wraps
 * `<Shell>`, inside `<ThemeProvider>`).
 */
export function ContextFocusTracker(props: ContextFocusTrackerProps): ReactNode {
  return (
    <FocusContextServiceContext.Provider value={props.context}>
      {props.children}
    </FocusContextServiceContext.Provider>
  );
}

/**
 * Returns a `ref` callback that reports `key`'s value (`true`/`false`) to
 * the {@link ContextFocusTracker}-provided context service whenever the
 * attached OpenTUI node gains or loses focus (this module's TSDoc). A
 * no-op ref (attaches, but reports nothing) when called outside a
 * {@link ContextFocusTracker} — matches this codebase's never-throwing
 * discipline rather than requiring every isolated component test to wrap
 * itself in a provider it does not care about.
 */
export function useFocusTracking(key: string): (node: FocusEmitter | null) => void {
  const context = useContext(FocusContextServiceContext);
  // Remembers the exact listener closures registered on the currently
  // attached node — `.off()` only removes a listener given the SAME
  // function reference passed to `.on()`, so cleanup must reuse these
  // rather than constructing fresh closures at detach time.
  const attached = useRef<{ node: FocusEmitter; onFocused: () => void; onBlurred: () => void } | null>(
    null,
  );

  return useCallback(
    (node: FocusEmitter | null) => {
      if (attached.current) {
        const { node: previousNode, onFocused, onBlurred } = attached.current;
        previousNode.off(RenderableEvents.FOCUSED, onFocused);
        previousNode.off(RenderableEvents.BLURRED, onBlurred);
        attached.current = null;
      }
      if (node) {
        const onFocused = () => context?.set(key, true);
        const onBlurred = () => context?.set(key, false);
        node.on(RenderableEvents.FOCUSED, onFocused);
        node.on(RenderableEvents.BLURRED, onBlurred);
        attached.current = { node, onFocused, onBlurred };
      }
    },
    [context, key],
  );
}
