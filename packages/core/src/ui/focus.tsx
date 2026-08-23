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

/** {@link FocusEmitter} plus the two imperative methods a caller that
 * DRIVES focus (rather than merely tracking it) needs — `Renderable.focus`/
 * `.blur` (this module's TSDoc). Used where a component captures a node
 * specifically to call `.focus()` on it later (Req 11.1's "Escape closes
 * returning focus to the text", `ui/shell.tsx`'s `EditorArea`) rather than
 * just to report `FOCUSED`/`BLURRED` into the context service. */
export interface FocusableNode extends FocusEmitter {
  focus(): void;
  blur(): void;
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
 *
 * **Detaching a still-focused node** (Req 11.1's find widget — the first
 * conditionally-mounted-only-while-focused consumer this codebase has):
 * every OTHER `useFocusTracking` consumer so far stays mounted for the
 * app's whole lifetime, so it always gets a real `BLURRED` event before
 * anything else takes focus. A component that unmounts WHILE still
 * focused (closing the find widget on `escape`) may never fire one — its
 * node can be detached from the render tree before `RenderableEvents.
 * BLURRED` has a chance to reach this hook's listener, which would
 * otherwise leave `key` stuck reporting `true` forever. The ref callback
 * tracks whether ITS OWN node was the one last reported focused and, if
 * so, force-reports `false` on detach (switching to a different node, or
 * unmounting to `null`) — closing that gap without needing every caller to
 * remember to blur before unmounting.
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
  // This hook's own last-known focus state for the CURRENTLY attached node
  // (this function's TSDoc's "detaching a still-focused node") — not
  // whether the underlying OpenTUI node is *actually* still focused (it
  // may already be gone by the time detach runs), just whether the last
  // event THIS hook observed for it was a gain, not a loss.
  const isFocusedRef = useRef(false);

  return useCallback(
    (node: FocusEmitter | null) => {
      if (attached.current) {
        const { node: previousNode, onFocused, onBlurred } = attached.current;
        previousNode.off(RenderableEvents.FOCUSED, onFocused);
        previousNode.off(RenderableEvents.BLURRED, onBlurred);
        attached.current = null;
        if (isFocusedRef.current) {
          isFocusedRef.current = false;
          context?.set(key, false);
        }
      }
      if (node) {
        const onFocused = () => {
          isFocusedRef.current = true;
          context?.set(key, true);
        };
        const onBlurred = () => {
          isFocusedRef.current = false;
          context?.set(key, false);
        };
        node.on(RenderableEvents.FOCUSED, onFocused);
        node.on(RenderableEvents.BLURRED, onBlurred);
        attached.current = { node, onFocused, onBlurred };
      }
    },
    [context, key],
  );
}
