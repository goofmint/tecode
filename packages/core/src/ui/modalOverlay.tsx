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
 * negative-margin arithmetic: `top: "15%", left: "15%", right: "15%"`
 * removes the overlay from the normal flex flow and centers it
 * horizontally with a 15%-of-width margin on each side, sized vertically by
 * its own content. `zIndex` (a top-level `Renderable` option, confirmed in
 * `Renderable.d.ts`) lifts it above `Shell`'s own content.
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
import { useRenderer } from "@opentui/react";
import { Input, List, type ListItem } from "./components";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import { INPUT_BOX_FOCUS_CONTEXT_KEY, QUICK_PICK_FOCUS_CONTEXT_KEY } from "./modalCommands";
import type { ModalService, ModalState } from "./modalService";
import { toColorInput, useTheme } from "./theme";

type QuickPickModalState = Extract<ModalState, { mode: "quickPick" }>;
type InputBoxModalState = Extract<ModalState, { mode: "inputBox" }>;

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
        <List items={listItems} selectedId={activeId} />
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

  return (
    <box
      style={{ flexDirection: "column" }}
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
    <box style={{ position: "absolute", top: "15%", left: "15%", right: "15%" }} zIndex={1000}>
      {state.mode === "quickPick" ? (
        <QuickPickBody state={state} setFilter={props.modalService.setFilter} />
      ) : (
        <InputBoxBody state={state} setInputValue={props.modalService.setInputValue} />
      )}
    </box>
  );
}
