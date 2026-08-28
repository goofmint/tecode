/**
 * `ModalOverlay` — the centered overlay component design.md §12 refers to
 * ("`tecode.window.showQuickPick/showInputBox` are implemented on the
 * shell's modal layer — a centered overlay component owned by core").
 * Renders {@link ModalService}'s current state: nothing while
 * `getState().mode` is `null`, a filter `Input` + `List` while
 * `"quickPick"`, or a prompt + `Input` + validation message while
 * `"inputBox"`.
 *
 * **Mount point** (Task 3.1's plan): `renderShell.tsx` mounts this as the
 * LAST sibling of `<Shell>`, inside the same `<ThemeProvider>`/
 * `<ContextFocusTracker>` — see that module's own comment. `ModalOverlay`
 * itself is ALWAYS mounted for the app's whole lifetime (never conditionally,
 * unlike `findWidget.tsx`); only the `QuickPickBody`/`InputBoxBody`
 * sub-components it renders internally mount/unmount as `getState().mode`
 * toggles — this split is what lets `ModalOverlay` play `EditorArea`'s own
 * "always-mounted parent restores focus on close" role (`shell.tsx`'s
 * `EditorArea`'s TSDoc) for a modal that, unlike the find widget, can be
 * opened from literally any previously-focused node in the shell.
 *
 * **Positioning** (verified against this repo's vendored `@opentui/core`
 * `Renderable.d.ts`/`lib/yoga.options.d.ts`): OpenTUI's Yoga-backed layout
 * supports genuine CSS-style `position: "absolute"` with percentage `top`/
 * `left`/`right`/`bottom` (resolved against the nearest sized ancestor —
 * here, the full-terminal root box `renderShell.tsx` wraps `<Shell>` and
 * this component in), so centering needs no terminal-dimension hook or
 * negative-margin arithmetic: `top`/`left`/`right`, all
 * {@link MODAL_MARGIN_PERCENT} (`"15%"`), remove the overlay from
 * the normal flex flow and center it horizontally with a matching margin on
 * each side. `zIndex` (a top-level `Renderable` option, confirmed in
 * `Renderable.d.ts`) lifts it above `Shell`'s own content.
 *
 * **Vertical bound (issue #93 — "the display does not update when
 * scrolling within the modal")**: this outer `<box>` itself still has no
 * `bottom`/`height` — it stays sized to whatever `QuickPickBody`/
 * `InputBoxBody` render, exactly as before this fix — but neither of THOSE
 * any longer sizes itself unboundedly. The root cause (`components.tsx`'s
 * `List` TSDoc): OpenTUI's `<select>` only ever RE-SCROLLS its visible
 * window when its own assigned `height` is smaller than its option count
 * (verified against the vendored `SelectRenderable`'s `updateScrollOffset`)
 * — `List`'s old unconditional `height={Math.max(items.length, 1)}` sized
 * every quick pick to fit EVERY item, so a long one both overflowed the
 * terminal and, independently, could never actually scroll (`scrollOffset`
 * has nowhere to move to when `height === options.length`). `QuickPickBody`
 * now bounds `List`'s height to however many rows are actually available
 * below this margin (`modalMarginRows`) — unchanged, and so still exactly
 * `items.length`, for a short list; capped once there are more items than
 * fit — while `InputBoxBody` (no `<select>`, but a caller-supplied
 * `prompt`/`validationMessage` that can ALSO overflow by wrapping across
 * many rows) just gets a hard `maxHeight` + `overflow: "hidden"` clip,
 * since it has no scrollable widget for a clamped size to make sense of.
 * `useTerminalDimensions()` (`@opentui/react`, re-exported alongside this
 * module's own `useRenderer` import) is what both read: reactive to the
 * renderer's own `"resize"` event, so a live terminal resize re-bounds an
 * already-open modal on its very next render, not just at mount.
 *
 * **Focus save/restore, and the ordering hazard this module works around**:
 * {@link ModalOverlay} needs to remember whatever OpenTUI node was focused
 * immediately BEFORE a modal opens (it could be anything — the sidebar, the
 * editor, another extension's view) and refocus it once the modal closes.
 * `useRenderer()` (`@opentui/react`) exposes the live `CliRenderer`, whose
 * `currentFocusedRenderable` getter and `focusRenderable()` method are
 * exactly the "read/set the single global focus pointer" primitives needed
 * (`renderer.d.ts`) — but capturing "whatever was focused before" CANNOT be
 * done in a `useEffect`: React runs child effects before parent effects in
 * the same commit, and `QuickPickBody`/`InputBoxBody`'s OWN mount effect
 * (mirroring `findWidget.tsx`'s "Ctrl+F opens focused" imperative `.focus()`
 * on mount) would already have claimed the focus pointer by the time an
 * effect ON THIS component ran — capturing `renderer.currentFocusedRenderable`
 * there would read back the modal's OWN just-focused input, not whatever was
 * focused beforehand. Capturing it DURING RENDER instead — guarded by an
 * edge-triggered ref comparison, `wasOpenRef` — runs strictly before ANY
 * effect in this commit (including the child's mount effect), so it always
 * observes the pre-modal focus target. This is a deliberate, narrow
 * exception to "don't mutate refs during render": it never affects what
 * this render PRODUCES (the read result isn't used until the close-side
 * effect fires, possibly commits later), so it cannot desync this
 * component's output from React's own reconciliation.
 */

import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Input, List, type ListItem } from "./components";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import { INPUT_BOX_FOCUS_CONTEXT_KEY, QUICK_PICK_FOCUS_CONTEXT_KEY } from "./modalCommands";
import type { ModalService, ModalState } from "./modalService";
import { toColorInput, useTheme } from "./theme";

type QuickPickModalState = Extract<ModalState, { mode: "quickPick" }>;
type InputBoxModalState = Extract<ModalState, { mode: "inputBox" }>;

/**
 * Vertical margin (issue #93 — "the display does not update when scrolling
 * within the modal"), in percent-of-terminal-height, kept on BOTH sides of
 * the overlay's content — matches the `top: "15%"` this module's own outer
 * `<box>` (below) already uses for its top offset and its horizontal
 * `left`/`right` margins — one number for BOTH axes, which is why it is
 * not named `..._VERTICAL_...`: changing it to tune the vertical inset
 * moves the horizontal one too, by design. The modal keeps the same
 * visual proportions
 * it always has; the number now ALSO seeds {@link modalMarginRows}, which
 * bounds every mode's content height so it can never grow past the
 * terminal (this module's TSDoc's "Positioning" already covers the
 * horizontal half of this; nothing previously bounded the vertical half —
 * see `List`'s `style`, `components.tsx`'s TSDoc, for why an OVERSIZED
 * `<select>` specifically also broke scrolling, not just overflowed).
 */
const MODAL_MARGIN_PERCENT = 15;

/**
 * A conservative (i.e. never UNDER-estimating) row count for one of this
 * module's `15%`-of-terminal-height margins (this module's TSDoc's
 * "Positioning"). `Math.ceil` — rather than trying to reproduce Yoga's own
 * internal percentage-to-row rounding exactly — guarantees this is always
 * `>=` whatever row count Yoga actually resolves `top: "15%"` to, for ANY
 * rounding rule Yoga might use (floor, round, or ceil itself): reserving
 * one row too many just leaves a little extra blank margin; reserving one
 * row too few is how a bounded box overflows the terminal by exactly the
 * row this function under-counted. Exported so `modalOverlay.test.tsx`'s
 * regression test can compute the SAME bound this module uses, instead of
 * guessing at Yoga's actual resolved pixel offset itself.
 */
export function modalMarginRows(terminalHeight: number): number {
  return Math.ceil((terminalHeight * MODAL_MARGIN_PERCENT) / 100);
}

/** Rows {@link QuickPickBody}'s own chrome always occupies ABOVE `List`,
 * inside the modal's top margin (`modalMarginRows`): its `border={[...]}`
 * (this module's TSDoc — 1 row top + 1 row bottom) plus the filter `Input`
 * (always exactly 1 row — a single-line OpenTUI `<input>`). Subtracted from
 * the rows available below the top margin to get `List`'s own bound. */
const QUICK_PICK_RESERVED_ROWS = 3;

/** Props for {@link ModalOverlay}. */
export interface ModalOverlayProps {
  /** Narrowed to exactly what rendering + input handling needs — matches
   * `findWidget.tsx`'s `FindWidgetProps.findService` narrowing convention. */
  modalService: Pick<ModalService, "getState" | "onDidChange" | "setFilter" | "setInputValue">;
}

/** Renders the quick pick's filter `Input` + `List` (this module's TSDoc).
 * A fresh mount/unmount every time `ModalOverlay`'s parent toggles between
 * `mode !== "quickPick"` and `"quickPick"` — its own `useEffect(() => {...},
 * [])` mount effect focuses the filter input exactly once per open, the
 * same "conditionally mounted, self-focusing" shape as `findWidget.tsx`. */
function QuickPickBody(props: {
  state: QuickPickModalState;
  setFilter: (query: string) => void;
}): ReactNode {
  const theme = useTheme();
  const focusRef = useFocusTracking(QUICK_PICK_FOCUS_CONTEXT_KEY);
  const nodeRef = useRef<FocusableNode | null>(null);
  // A stable identity across re-renders (the same "focus-identity-churn"
  // lesson `findWidget.tsx`'s `queryInputRef`/`shell.tsx`'s `EditorArea.
  // handleTextPlaneNode` document): `ModalOverlay`'s own mount effect calls
  // an unconditional `forceRender()` right after subscribing to
  // `modalService.onDidChange` (closing the same "subscribe-after-render
  // race" every other `onDidChange` consumer in this codebase closes,
  // `shell.tsx`'s `useSlotViews`'s TSDoc) — that extra render happens
  // WHILE this component is still mounted, and a freshly-allocated inline
  // ref callback on that render would make React detach-then-reattach this
  // Input's ref (calling it with `null`, then the SAME node again) in
  // between this component's own mount effect calling `.focus()` and the
  // event actually being observed, silently dropping the very `FOCUSED`
  // event `useFocusTracking` needs. `useCallback` keyed only on `focusRef`
  // (itself stable — `useFocusTracking`'s own `useCallback`, keyed on
  // `context`/`key`, neither of which changes here) keeps this ref's
  // identity stable across that extra render.
  const inputRef = useCallback(
    (node: FocusableNode | null) => {
      focusRef(node);
      nodeRef.current = node;
    },
    [focusRef],
  );
  useEffect(() => {
    // Runs once, after every ref in this render has attached — mirrors
    // `findWidget.tsx`'s own mount-focus effect exactly (its TSDoc explains
    // why a `useEffect` is required here rather than the declarative
    // `focused` prop).
    nodeRef.current?.focus();
  }, []);

  const listItems: ListItem[] = props.state.items.map((item, index) => ({
    id: String(index),
    label: item.label,
    description: item.description,
  }));
  const activeId = props.state.activeIndex >= 0 ? String(props.state.activeIndex) : undefined;

  // Bound `List`'s height (issue #93's fix — `components.tsx`'s `List`
  // TSDoc's "Sizing") to however many rows actually fit below the modal's
  // own top margin, MINUS this box's own border (1 row top + 1 bottom —
  // `border={[...]}` below) and the filter `Input` above (always exactly 1
  // row, single-line). Below that many items, this comes out to
  // `listItems.length` itself — i.e. IDENTICAL to `List`'s own unconstrained
  // default — so a short list still hugs its own content exactly as before;
  // only once there are MORE items than fit does this clamp kick in,
  // handing `List` a height smaller than its item count so OpenTUI's
  // `<select>` scrolls instead of overflowing (this module's TSDoc).
  const { height: terminalHeight } = useTerminalDimensions();
  const maxListRows = Math.max(1, terminalHeight - modalMarginRows(terminalHeight) - QUICK_PICK_RESERVED_ROWS);
  const listHeight = Math.max(1, Math.min(listItems.length, maxListRows));

  return (
    <box
      style={{ flexDirection: "column" }}
      backgroundColor={toColorInput(theme.colors["input.background"])}
      border={["top", "right", "bottom", "left"]}
      borderColor={toColorInput(theme.colors["focusBorder"])}
    >
      <Input
        value={props.state.filterQuery}
        placeholder={props.state.options?.placeHolder ?? ""}
        onChange={props.setFilter}
        inputRef={inputRef}
      />
      {listItems.length > 0 ? (
        <List items={listItems} selectedId={activeId} style={{ height: listHeight, overflow: "hidden" }} />
      ) : (
        <text fg={toColorInput(theme.colors["input.placeholderForeground"])}>{" No matching results "}</text>
      )}
    </box>
  );
}

/** Renders the input box's prompt + `Input` + validation message (this
 * module's TSDoc) — same conditionally-mounted, self-focusing shape as
 * {@link QuickPickBody}. */
function InputBoxBody(props: {
  state: InputBoxModalState;
  setInputValue: (value: string) => void;
}): ReactNode {
  const theme = useTheme();
  const focusRef = useFocusTracking(INPUT_BOX_FOCUS_CONTEXT_KEY);
  const nodeRef = useRef<FocusableNode | null>(null);
  // Stable identity across re-renders — see `QuickPickBody`'s identical
  // `inputRef` for the full "focus-identity-churn" explanation.
  const inputRef = useCallback(
    (node: FocusableNode | null) => {
      focusRef(node);
      nodeRef.current = node;
    },
    [focusRef],
  );
  useEffect(() => {
    nodeRef.current?.focus();
  }, []);

  // `InputBoxBody` has no `<select>` to size (issue #93 is specifically
  // about `List`'s scrolling), but its `prompt`/`validationMessage` are
  // caller-supplied strings of unbounded length — a long one wraps across
  // many rows and can ALSO overflow the terminal, the same underlying
  // "nothing bounds this modal's content" gap `QuickPickBody` closes above
  // (verified empirically: a ~400-char prompt/validation pair in a
  // 20-row terminal renders ~35 content rows, well past the bottom edge).
  // A hard `maxHeight` + `overflow: "hidden"` clip — rather than
  // `QuickPickBody`'s adaptive row-counting `listHeight` — is the right fix
  // here: there is no scrollable widget underneath to keep a selection
  // visible in, so there is nothing to make scrollable; clipping is simply
  // "never draw past the terminal's edge", the same guarantee `List`'s own
  // bounded `<select>` gets from its assigned `height`.
  const { height: terminalHeight } = useTerminalDimensions();
  const maxContentRows = Math.max(1, terminalHeight - modalMarginRows(terminalHeight));

  return (
    <box
      style={{ flexDirection: "column", maxHeight: maxContentRows, overflow: "hidden" }}
      backgroundColor={toColorInput(theme.colors["input.background"])}
      border={["top", "right", "bottom", "left"]}
      borderColor={toColorInput(theme.colors["focusBorder"])}
    >
      {props.state.options?.prompt ? (
        <text fg={toColorInput(theme.colors["input.placeholderForeground"])}>{props.state.options.prompt}</text>
      ) : null}
      <Input
        value={props.state.value}
        placeholder={props.state.options?.placeHolder ?? ""}
        onChange={props.setInputValue}
        inputRef={inputRef}
      />
      {props.state.validationMessage ? (
        <text fg={toColorInput(theme.colors["statusBar.debuggingBackground"])}>{props.state.validationMessage}</text>
      ) : null}
    </box>
  );
}

/** The modal overlay (Task 3.1, Req 10.1, design.md §12; this module's
 * TSDoc). */
export function ModalOverlay(props: ModalOverlayProps): ReactNode {
  const renderer = useRenderer();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = props.modalService.onDidChange(() => forceRender());
    // Closes the subscribe-after-render race — see `shell.tsx`'s
    // `useSlotViews`'s TSDoc for the full explanation of this shape.
    forceRender();
    return () => sub.dispose();
  }, [props.modalService]);

  const state = props.modalService.getState();
  const isOpen = state.mode !== null;

  const wasOpenRef = useRef(false);
  const previousFocusRef = useRef<FocusableNode | null>(null);
  // Captured DURING RENDER, not in an effect — see this module's TSDoc for
  // why the ordering matters here.
  if (isOpen && !wasOpenRef.current) {
    previousFocusRef.current = (renderer.currentFocusedRenderable as unknown as FocusableNode | null) ?? null;
  }
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      try {
        previousFocusRef.current?.focus();
      } catch {
        // The previously-focused node may have been destroyed while the
        // modal was open (e.g. its owning view was unregistered) — never
        // throw out of a focus-restore attempt.
      }
      previousFocusRef.current = null;
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  if (state.mode === null) return null;

  return (
    <box
      style={{
        position: "absolute",
        top: `${MODAL_MARGIN_PERCENT}%`,
        left: `${MODAL_MARGIN_PERCENT}%`,
        right: `${MODAL_MARGIN_PERCENT}%`,
      }}
      zIndex={1000}
    >
      {state.mode === "quickPick" ? (
        <QuickPickBody state={state} setFilter={props.modalService.setFilter} />
      ) : (
        <InputBoxBody state={state} setInputValue={props.modalService.setInputValue} />
      )}
    </box>
  );
}
