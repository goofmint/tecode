/**
 * The UI shell (Req 6.1-6.6; design.md §8.1, §8.2, §8.3; Task 1.14, Task
 * 2.1): the VS Code-style arrangement of `ActivityBar` / `Sidebar` /
 * `EditorArea` (`TabBar` + the real `EditorView`) / `Panel` / `StatusBar`,
 * wired to the {@link SlotRegistry} (Req 6.2, 6.3) and the
 * {@link LayoutStateService} (Req 6.4).
 *
 * **Component tree** (design.md §8.1 — `ThemeProvider`/`ContextFocusTracker`
 * wrap this from the outside, at the assembly layer, not inside this
 * module):
 *
 * ```
 * <Shell>
 *   <box row>              // ActivityBar | Sidebar | EditorArea
 *     <ActivityBar/>
 *     <Sidebar/>
 *     <EditorArea><TabBar/><EditorView/></EditorArea>
 *   </box>
 *   <Panel/>
 *   <StatusBar/>
 * </Shell>
 * ```
 *
 * **Reactivity**: every region subscribes to `SlotRegistry.onDidChange` for
 * the slot(s) it renders (via {@link useSlotViews}/{@link useSidebarPairs}/
 * {@link useStatusBarItems} below) so a `tecode.ui.registerView` call
 * re-renders exactly the affected region — the Shell itself never polls.
 * `EditorArea`'s tabs/active-document/`EditorState` are likewise driven
 * reactively off an optional `DocumentManager` via {@link useOpenDocuments}
 * (Req 6.5, 6.6, design.md §8.3).
 *
 * **Layout persistence** (Req 6.4): {@link useLayoutState} seeds React state
 * from `LayoutStateService.get()` (already populated with defaults even
 * before `ready` settles) and re-seeds once `ready` resolves; every
 * mutating action (toggling the sidebar, switching the active view,
 * resizing the panel) calls both `LayoutStateService.update()` (persisted,
 * debounced) and the local `setState` in the same handler — the Shell is
 * the layout service's one and only writer, so no `onDidChange` round-trip
 * is needed to stay in sync with itself.
 *
 * **`EditorArea`/`EditorView` wiring** (Req 6.5, 6.6, design.md §8.3):
 * `Shell` accepts an optional `documents: DocumentManager` prop — when
 * given, tabs, the active tab, and per-tab `EditorState` are all derived
 * from its open documents (see `ShellProps`' and `EditorArea`'s own TSDoc);
 * when omitted (existing callers/tests), `EditorArea` keeps its original,
 * fully decoupled `editorTabs`/`activeEditorTabId`/`onSelectEditorTab` props
 * and placeholder-only display exactly as before.
 */

import { basename } from "node:path";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { CliRenderEvents } from "@opentui/core";
import { useAppContext } from "@opentui/react";
import type { Disposable, SlotId, Uri } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { DocumentManager } from "../buffer/documentManager";
import { uriToPath } from "../buffer/uri";
import type { CommandRegistry } from "../commands/registry";
import type { ConfigService } from "../config/service";
import { RegisteredView, Tabs, type TabItem } from "./components";
import type { EditorSessionService } from "./editorSession";
import { createInitialEditorState, type EditorState } from "./editorState";
import { EditorView } from "./editorView";
import type { FindService } from "./findService";
import type { HighlightService } from "../languages/highlightService";
import { FindWidget } from "./findWidget";
import type { FocusableNode } from "./focus";
import { useFocusContextService, useFocusTracking } from "./focus";
import type { LayoutState, LayoutStateService } from "./layoutState";
import { INPUT_BOX_FOCUS_CONTEXT_KEY, QUICK_PICK_FOCUS_CONTEXT_KEY } from "./modalCommands";
import type { SidebarPair, SlotRegistry, SlotViewEntry } from "./slotRegistry";
import { toColorInput, useTheme } from "./theme";
import { computeEditorViewportHeight, type EditorAreaChrome } from "./viewport";

/* ------------------------------------------------------------------ */
/* Shared reactive-subscription hooks                                  */
/* ------------------------------------------------------------------ */

/** Re-renders the calling component whenever `slotRegistry` reports a
 * change to `slot`, and returns that slot's current views (design.md
 * §8.2's "shell regions subscribe and re-render on registration").
 *
 * **The subscribe-after-render race, and how this closes it**: the render
 * that reads `slotRegistry.getViews(slot)` below happens *before* this
 * component's `useEffect` runs and actually subscribes (React always
 * commits/paints before running effects) — a registration landing in that
 * gap fires `onDidChange` to no listener yet and is lost, leaving this
 * component on a stale snapshot until some *later*, unrelated change
 * happens to trigger a re-render. The fix is the unconditional
 * `forceRender()` right after subscribing below: it does not compare
 * "did anything change" (this hook has no cheap way to know, short of the
 * full `useSyncExternalStore` machinery, which risks its own subtle
 * infinite-render bugs if the snapshot isn't cached correctly — not worth
 * it for what is otherwise a one-line seam) — it just re-renders once,
 * unconditionally, right after the subscription is live, so this render's
 * `getViews(slot)` call is always guaranteed to be fresh as of a point in
 * time no earlier than "subscribed". */
function useSlotViews(slotRegistry: SlotRegistry, slot: SlotId): readonly SlotViewEntry[] {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = slotRegistry.onDidChange((changed) => {
      if (changed === slot) forceRender();
    });
    // Close the subscribe-after-render race (this function's TSDoc):
    // re-render now that the subscription is live, in case a change landed
    // in the gap between this render and this effect running.
    forceRender();
    return () => sub.dispose();
  }, [slotRegistry, slot]);
  return slotRegistry.getViews(slot);
}

/** Same as {@link useSlotViews}, but for the `activityBar.item` ↔
 * `sidebar.view` pairing (Req 6.2) — re-renders on a change to either
 * slot. */
function useSidebarPairs(slotRegistry: SlotRegistry): readonly SidebarPair[] {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = slotRegistry.onDidChange((changed) => {
      if (changed === "activityBar.item" || changed === "sidebar.view") forceRender();
    });
    // Closes the subscribe-after-render race — see useSlotViews's TSDoc.
    forceRender();
    return () => sub.dispose();
  }, [slotRegistry]);
  return slotRegistry.listSidebarPairs();
}

/** Same as {@link useSlotViews}, but for the sorted `statusBar.item`
 * enumeration (design.md §8.2). */
function useStatusBarItems(slotRegistry: SlotRegistry): readonly SlotViewEntry[] {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = slotRegistry.onDidChange((changed) => {
      if (changed === "statusBar.item") forceRender();
    });
    // Closes the subscribe-after-render race — see useSlotViews's TSDoc.
    forceRender();
    return () => sub.dispose();
  }, [slotRegistry]);
  return slotRegistry.listStatusBarItems();
}

/** Re-renders on `documents`' `onDidOpen`/`onDidClose` and returns its
 * current document list (Req 6.5, design.md §8.1's EditorArea wiring) —
 * same subscribe-then-force-render shape as {@link useSlotViews}, including
 * the post-subscribe re-render that closes the same render-before-subscribe
 * race (this module's TSDoc). Returns `[]` when `documents` is
 * `undefined` — a caller that never wires a `DocumentManager` in gets
 * exactly the pre-existing "no tabs" placeholder behavior (this module's
 * TSDoc on `EditorArea`).
 *
 * `documents.documents` is a getter that returns a fresh `Array.from(...)`
 * on every access (`documentManager.ts`), so reading it directly here would
 * hand out a new array reference on every render — including renders this
 * hook's own subscription didn't cause — breaking any effect that depends
 * on `[openDocuments]` expecting that reference to stay stable when the
 * open-document set hasn't actually changed. `useMemo`, keyed on the
 * reducer's own `version` (bumped only by `forceRender`, i.e. only by an
 * actual `onDidOpen`/`onDidClose`), re-reads the getter just once per real
 * change instead. */
function useOpenDocuments(documents: DocumentManager | undefined): readonly CoreDocument[] {
  const [version, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!documents) return undefined;
    const openSub = documents.onDidOpen(() => forceRender());
    const closeSub = documents.onDidClose(() => forceRender());
    // Closes the subscribe-after-render race — see useSlotViews's TSDoc.
    forceRender();
    return () => {
      openSub.dispose();
      closeSub.dispose();
    };
  }, [documents]);
  return useMemo(() => documents?.documents ?? [], [documents, version]);
}

/** Seeds React state from `layoutState.get()` (Req 6.4) and keeps it in
 * sync with the service across `ready` and every local `update` call (this
 * module's TSDoc). */
function useLayoutState(
  layoutState: LayoutStateService,
): [LayoutState, (partial: Partial<LayoutState>) => void] {
  const [state, setState] = useState<LayoutState>(() => layoutState.get());

  useEffect(() => {
    let cancelled = false;
    void layoutState.ready.then(() => {
      if (!cancelled) setState(layoutState.get());
    });
    return () => {
      cancelled = true;
    };
  }, [layoutState]);

  const update = useCallback(
    (partial: Partial<LayoutState>) => {
      layoutState.update(partial);
      setState((prev) => ({ ...prev, ...partial }));
    },
    [layoutState],
  );

  return [state, update];
}

/* ------------------------------------------------------------------ */
/* ActivityBar                                                         */
/* ------------------------------------------------------------------ */

/** Props for {@link ActivityBar}. */
export interface ActivityBarProps {
  slotRegistry: SlotRegistry;
  activeView: string | undefined;
  onSelectView: (id: string) => void;
}

/** The activity bar (Req 6.1, 6.2): one icon per `activityBar.item` ↔
 * `sidebar.view` pair, highlighting the active one. */
export function ActivityBar(props: ActivityBarProps): ReactNode {
  const theme = useTheme();
  const pairs = useSidebarPairs(props.slotRegistry);

  return (
    <box
      style={{ flexDirection: "column", width: 4 }}
      backgroundColor={toColorInput(theme.colors["activityBar.background"])}
    >
      {pairs.map((pair) => {
        const isActive = pair.id === props.activeView;
        const item = pair.activityItem;
        if (item?.component) {
          return (
            <box key={pair.id} onMouseDown={() => props.onSelectView(pair.id)}>
              <RegisteredView key={pair.id} component={item.component} viewProps={{ active: isActive }} />
            </box>
          );
        }
        const glyph = item?.icon ?? item?.title?.slice(0, 1) ?? pair.id.slice(0, 1);
        return (
          <text
            key={pair.id}
            fg={toColorInput(
              isActive
                ? theme.colors["activityBar.foreground"]
                : theme.colors["activityBar.inactiveForeground"],
            )}
            onMouseDown={() => props.onSelectView(pair.id)}
          >
            {` ${glyph} `}
          </text>
        );
      })}
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                              */
/* ------------------------------------------------------------------ */

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  slotRegistry: SlotRegistry;
  visible: boolean;
  width: number;
  activeView: string | undefined;
}

/** The sidebar (Req 6.1, 6.2, 6.4): renders the `sidebar.view` paired with
 * `activeView`, requesting lazy activation if it has no component yet
 * (design.md §8.2). */
export function Sidebar(props: SidebarProps): ReactNode {
  const theme = useTheme();
  const pairs = useSidebarPairs(props.slotRegistry);
  const focusRef = useFocusTracking("sidebarFocus");

  if (!props.visible) return null;

  const active = props.activeView ? pairs.find((p) => p.id === props.activeView) : undefined;
  const view = active?.sidebarView;

  if (view && view.lazy && !view.component) {
    // Fire-and-forget lazy activation (this module's TSDoc; design.md
    // §8.2's "activating the owning extension lazily if needed"). Safe to
    // call on every render — requestActivation de-duplicates in-flight
    // requests itself (slotRegistry.ts).
    props.slotRegistry.requestActivation("sidebar.view", view.id);
  }

  return (
    <box
      ref={focusRef}
      focusable
      style={{ flexDirection: "column", width: props.width }}
      backgroundColor={toColorInput(theme.colors["sideBar.background"])}
      border={["right"]}
      borderColor={toColorInput(theme.colors["sideBar.border"])}
    >
      {view?.title ? (
        <text fg={toColorInput(theme.colors["sideBarTitle.foreground"])}>{view.title}</text>
      ) : null}
      {view?.component ? (
        // Keyed by view.id (not just position) so switching the active
        // sidebar view — same conditional slot, different registered
        // component — unmounts the old view's fiber instead of reusing it
        // (components.tsx's RegisteredView TSDoc: this is what keeps hook
        // state from leaking across views).
        <RegisteredView key={view.id} component={view.component} />
      ) : (
        <text fg={toColorInput(theme.colors["sideBar.foreground"])}>
          {view ? "Activating…" : ""}
        </text>
      )}
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* EditorArea (TabBar + EditorView)                                     */
/* ------------------------------------------------------------------ */

/** Rows `Tabs`' `<tab-select>` (`components.tsx`, over `@opentui/core`'s
 * `TabSelectRenderable`) occupies once tabs are shown (Issue #92, this
 * module's `EditorArea` — its `tabs.length > 0` condition below decides
 * WHETHER this constant applies, never a made-up literal that could drift
 * from the real render). `TabSelectRenderable`'s own
 * `calculateDynamicHeight(showUnderline, showDescription)` — both left at
 * their `@opentui/core@0.1.107` library defaults, `true`/`true`, since
 * `Tabs` never overrides either — computes `1` (tab row) + `1` (underline)
 * + `1` (description row) = `3`; confirmed directly against the vendored
 * headless renderer (a mounted `<tab-select>` with no explicit `height`
 * measures exactly `3` rows), not merely read off the library's source. */
const TAB_BAR_HEIGHT = 3;

/** Rows `FindWidget`'s own outer box occupies while open (`findWidget.tsx`'s
 * `style={{ height: 1 }}`) — Req 11.1. */
const FIND_WIDGET_HEIGHT = 1;

/** Rows `StatusBar` occupies (`shell.tsx`'s `StatusBar`, `style={{ height: 1
 * }}`) — always rendered, so always reserved. */
const STATUS_BAR_HEIGHT = 1;

/** The live terminal's current column/row count, reactively — see this
 * function's own TSDoc for the full rationale. */
interface LiveTerminalDimensions {
  width: number;
  height: number;
}

/**
 * The live terminal's current column/row count (Issue #92's row half; Req
 * 6.5, 6.6, 13.1; design.md §8.3's `EditorView` `viewportHeight` scope
 * note; Issue #98's column half, needed to size the terminal panel's own
 * pty/VT emulator to the real terminal width), reactively — the "optional
 * dependency, `undefined` when unavailable" shape `theme.tsx`'s
 * {@link useLiveTheme}/`focus.tsx`'s `useFocusTracking` already use, applied
 * to `@opentui/react`'s live `CliRenderer` instead of a `ThemeService`/
 * `ContextService`.
 *
 * **Why this reads `@opentui/react`'s `AppContext` directly, rather than
 * calling that package's own `useTerminalDimensions`/`useOnResize`**:
 * verified against the installed `@opentui/react@0.1.107`'s
 * `src/hooks/use-renderer.ts` — EVERY ONE of `useRenderer`,
 * `useTerminalDimensions`, and `useOnResize` calls `useRenderer()`
 * internally, which THROWS (`"Renderer not found."`) the instant no live
 * `CliRenderer` is mounted above them (`modalOverlay.tsx`'s `useRenderer`
 * TSDoc already relies on that renderer always being present for ITS
 * caller — `ModalOverlay` is unconditionally mounted at the composition
 * root). `EditorArea`/`Panel` have no such guarantee: a caller/test that
 * constructs either directly (outside `Shell`, outside a `testRender`/
 * `renderShellToTerminal` tree) would crash outright. `useAppContext()`
 * itself never throws — its `AppContext`'s own default value is
 * `{ renderer: null }` (`@opentui/react`'s `src/components/app.tsx`) — so
 * reading `renderer` through it and replicating `useTerminalDimensions`'s
 * own seed-then-subscribe-to-`"resize"` logic by hand gets the exact same
 * live behavior with a real fallback path instead of a crash.
 *
 * Returns `undefined` when no renderer is mounted — `EditorArea` falls
 * back to `EditorView`'s own `DEFAULT_VIEWPORT_HEIGHT` constant in that
 * case (this task's "fall back to the existing constant"), exactly
 * mirroring `useLiveTheme`'s `themeService === undefined` fallback; `Panel`
 * (Issue #98) falls back to not sizing its `viewProps` at all, leaving a
 * `panel.tab` view's own component to pick its own default.
 *
 * One hook, one subscription, both dimensions together (rather than two
 * separate `useLiveTerminalHeight`/`useLiveTerminalWidth` hooks each
 * re-deriving the same `AppContext`/`RESIZE` wiring) — a single `resize`
 * event already carries both values in one payload, so splitting this into
 * two hooks would either drop one of them or double-subscribe for no
 * benefit.
 */
function useLiveTerminalDimensions(): LiveTerminalDimensions | undefined {
  const { renderer } = useAppContext();
  const [dimensions, setDimensions] = useState<LiveTerminalDimensions | undefined>(
    renderer ? { width: renderer.width, height: renderer.height } : undefined,
  );
  useEffect(() => {
    if (!renderer) return undefined;
    // Re-syncs to whatever the renderer's size is RIGHT NOW before
    // subscribing — closes the same subscribe-after-render race
    // `useLiveTheme`'s TSDoc documents (a resize landing in the gap
    // between this render and this effect running would otherwise be
    // missed until some later, unrelated re-render).
    setDimensions({ width: renderer.width, height: renderer.height });
    const onResize = (width: number, height: number) => setDimensions({ width, height });
    renderer.on(CliRenderEvents.RESIZE, onResize);
    return () => {
      renderer.off(CliRenderEvents.RESIZE, onResize);
    };
  }, [renderer]);
  return renderer ? dimensions : undefined;
}

/** Props for {@link EditorArea}. */
export interface EditorAreaProps {
  /** Open editor tabs — one editor group, N tabs (Req 6.5). Empty by
   * default: no document manager is wired into the shell yet (this
   * module's TSDoc). */
  tabs?: TabItem[];
  activeTabId?: string;
  onSelectTab?: (id: string) => void;
  /** The active document `EditorView` renders (Req 6.5, 6.6, design.md
   * §8.3). `undefined` keeps the "No editor open." placeholder — unchanged
   * for a caller that never wires a `DocumentManager` into `Shell` (this
   * module's TSDoc). */
  activeDocument?: CoreDocument;
  /** This tab's `EditorState` — required alongside `activeDocument` (both
   * are set, or neither is, from `Shell`'s wiring below). */
  activeEditorState?: EditorState;
  /** Threaded through to `EditorView` for its `editor.lineNumbers` lookup
   * (Req 9.5). */
  config?: ConfigService;
  /**
   * Backs the `FindWidget` sibling (Req 11.1, design.md §13) — omitted
   * entirely (no `<FindWidget>` renders, regardless of `find?.isOpen`) for
   * a caller that never wires a `FindService` into `Shell`, matching every
   * other optional-dependency fallback in this module (`editorSession`'s
   * own TSDoc). Narrowed to the 3 actions `findWidget.tsx` actually calls.
   */
  findService?: Pick<FindService, "setQuery" | "setReplaceQuery" | "toggleCaseSensitive">;
  /** Threaded straight through to `EditorView` (Req 8.1, design.md §10) —
   * see `EditorViewProps.highlightService`'s TSDoc. Optional, matching
   * `findService`/`config` above: a caller/test that omits it gets
   * `EditorView`'s current (unhighlighted) rendering unchanged. */
  highlightService?: Pick<HighlightService, "getSpansForLine" | "onDidChange">;
  /** Whether `Shell`'s bottom `Panel` is currently visible, and its height
   * when it is (`layoutState.ts`'s `LayoutState.panelVisible`/
   * `panelHeight`) — Issue #92. `Panel` is `EditorArea`'s SIBLING at the
   * `Shell` level (design.md §8.1's component tree), not a descendant, but
   * both sit in the same flex column above `StatusBar`, so `Panel`'s
   * height still eats into the space left for `EditorArea` (and therefore
   * `EditorView`'s text plane) to stretch into — the live-`viewportHeight`
   * computation below needs both to size the text plane correctly. Omitted
   * (a caller/test that constructs `EditorArea` directly, without `Shell`):
   * treated as "no panel", matching every other optional-dependency
   * fallback in this module. */
  panelVisible?: boolean;
  panelHeight?: number;
  /** Receives a stable `() => void` handle for focusing the editor's text
   * plane from outside React (Issue #98 Phase 3) — see this module's
   * `EditorArea` TSDoc's "Publishing a focus handle for the terminal's own
   * escape hatch". Optional: a caller/test that omits it simply never gets
   * the handle, matching every other optional-dependency fallback in this
   * module. */
  onEditorFocusHandleChange?: (focus: () => void) => void;
}

/** The editor area (Req 6.1, 6.5, 6.6, 11.1): a `TabBar` over the real
 * `EditorView` (design.md §8.3) once a document is active, or the
 * "No editor open." placeholder otherwise — plus, when the active tab's
 * `find?.isOpen` is true, a `FindWidget` sibling underneath the tab bar
 * (Req 11.1, design.md §13).
 *
 * **Returning focus to the text on close** (Req 11.1's "Escape closes
 * returning focus to the text", `findWidget.tsx`'s TSDoc): this component
 * — not the widget itself, which has already unmounted by the time `find.
 * isOpen` flips back to `false` — captures `EditorView`'s text-plane node
 * via `onTextPlaneNode` and imperatively `.focus()`s it back on exactly
 * that true→false transition (an edge-triggered `useEffect`, not a
 * level-triggered one — this must fire ONCE per close, not on every render
 * where find happens to already be closed, which would otherwise fight
 * the user clicking anywhere else in the shell while find stays shut).
 *
 * **Initial/re-focus of the text plane** (Req 4.6, 6.7; Issue #82): nothing
 * ELSE in the app ever imperatively focuses the text plane on its own —
 * before this fix, `editorTextFocus` simply stayed `undefined` forever
 * after mount, so `editorInputRouter.routeKeyEvent`'s `if (!context.
 * get("editorTextFocus")) return false;` gate (`editor/inputRouter.ts`)
 * dropped every printable keystroke while chord-consumed commands with no
 * `when` clause kept working — exactly the reported "can't type, but
 * ctrl+g still works" symptom. A second edge-triggered `useEffect`, keyed
 * on `props.activeDocument?.uri` (via `previousActiveUriRef` below), grants
 * focus on exactly one transition — "the active document's uri just
 * changed" — which covers all three startup/lifecycle cases in one rule:
 *
 *  1. **A document is already open at startup**: `previousActiveUriRef`
 *     starts at `undefined`, so the very first effect run (where
 *     `activeDocument` is already set) counts as a transition too —
 *     `EditorView`'s ref attaches during the SAME commit, before any
 *     effect runs, so `textPlaneNodeRef.current` is already valid.
 *  2. **No document is open at startup, one opens later**: `uri` stays
 *     `undefined` (this effect no-ops — there is no text plane yet) until
 *     the document opens, at which point `uri` flips from `undefined` to
 *     a real value — the same transition as case 1.
 *  3. **Switching tabs**: `uri` flips from one open document's uri to
 *     another's. `EditorView` remounts (`key={props.activeDocument.uri}`
 *     below), so by the time this effect runs `textPlaneNodeRef.current`
 *     already points at the NEW tab's node. Refocusing here matches "typing
 *     resumes immediately after switching tabs", the same way reopening a
 *     file does in case 2.
 *
 * Deliberately does NOT refire on a re-render that leaves `uri` unchanged
 * — the same reason the find-close effect above is edge- rather than
 * level-triggered: refiring on every unrelated re-render would fight a
 * user who has since moved focus elsewhere on their own (the sidebar, the
 * palette) every single time `EditorArea` re-renders for any reason.
 *
 * **Do-not-steal guard**: skipped entirely while the command palette
 * (`quickPickFocus`), an input box (`inputBoxFocus`), the find widget
 * (`findWidgetFocus`, or this tab's own `find.isOpen`), the explorer
 * sidebar (`explorerFocus`), or the terminal panel (`terminalFocus`, Issue
 * #98) legitimately holds focus. None of those are `EditorArea`'s own
 * React descendants — `ModalOverlay` is `Shell`'s sibling (`modalOverlay.
 * tsx`), `Sidebar`/`Panel` are `Shell`'s children — so this reads them
 * back through the shared `ContextService`
 * (`focus.tsx`'s `useFocusContextService`) rather than through React's own
 * tree structure. Getting this wrong (focusing unconditionally) would
 * steal focus out from under someone mid-typing in the palette the moment
 * a document happens to open or a tab happens to switch underneath it —
 * worse than the bug this effect exists to fix (this task's own framing).
 *
 * **A deferred attempt is retried, never discarded** (CodeRabbit PR #83
 * follow-up — Issue #82's own most common path: an empty workspace, the
 * command palette opens the picked file, which activates it as the new
 * tab WHILE the palette is still showing): the FIRST version of this
 * effect advanced `previousActiveUriRef` unconditionally before checking
 * the guard, so a transition that arrived while guarded was marked
 * "already handled" and then discarded — nothing re-attempted it once the
 * palette closed, because `focusContext` never changes identity (its
 * `quickPickFocus` value living inside the `ContextService`'s internal Map
 * is invisible to a React dependency array) and `props.activeDocument?.uri`
 * does not change again on its own. `ModalOverlay` cannot rescue this
 * either — it restores focus only to whatever was focused BEFORE the modal
 * opened (`modalOverlay.tsx`'s `previousFocusRef`), which in this flow is
 * not the new document's text plane at all. Fixed by separating two
 * concerns that used to live in one ref: `previousActiveUriRef` ONLY
 * detects "is this a genuinely new active-document uri" (advanced the
 * instant a transition is seen, guard or no guard — this part was never
 * the bug); `pendingFocusUriRef` holds whatever uri is still OWED a focus
 * attempt, cleared only once `attemptFocus` actually succeeds. A second
 * `useEffect` below subscribes to the context service's own `onDidChange`
 * (exposed for exactly this by `focus.tsx`'s `useFocusContextService`) and
 * calls `attemptFocus` again on every firing — cheap and safe to over-call,
 * since `attemptFocus` itself no-ops the instant nothing is pending.
 * Subscribing to `onDidChange` unfiltered (not just for the specific key
 * that unblocked things) is deliberate: it means a deferred attempt is
 * retried no matter WHICH of the five guards clears first — the command
 * palette, an input box, the find widget, the explorer sidebar, or the
 * terminal panel — with no separate per-key wiring needed for each.
 *
 * **Publishing a focus handle for the terminal's own escape hatch** (Issue
 * #98 Phase 3): `packages/cli`'s `keyRouting.ts` needs a way to
 * imperatively focus THIS component's text plane from outside React
 * entirely — when the terminal panel has focus and the user presses the
 * one reserved escape stroke, focus must move back to the editor, and
 * nothing else in the app currently exposes a handle for that (this
 * component's own `textPlaneNodeRef` is otherwise private). `props.
 * onEditorFocusHandleChange`, when given, is called once with a STABLE
 * function (`focusEditorText` below, closing only over the ref, matching
 * `handleTextPlaneNode`'s own empty-deps stability rationale) that calls
 * `.focus()` on whatever text plane is currently attached — the same
 * "hand over a callback, not the renderer" convention `renderShell.tsx`'s
 * `onClipboardWriterReady`/`onDestroy` already use. This is independent of
 * (and does not replace) the do-not-steal guard above — calling the
 * published handle is always an explicit, caller-requested focus move
 * (Escape pressed while the terminal genuinely has focus), never a
 * side-effect of some unrelated re-render the guard exists to suppress.
 *
 * **Sizing `EditorView`'s `viewportHeight` to the real terminal** (Issue
 * #92 — "Only the first 20 lines are displayed" no matter how tall the
 * terminal actually is): {@link useLiveTerminalHeight} reads the live
 * terminal row count, {@link computeEditorViewportHeight} (`viewport.ts`)
 * subtracts exactly the chrome THIS render actually draws — the tab bar
 * (`tabs.length > 0`), the find widget (the same `find && isFindOpen &&
 * props.findService` condition the JSX below uses to decide whether
 * `<FindWidget>` renders at all), `Shell`'s sibling `Panel`
 * (`props.panelVisible`/`panelHeight`), and `StatusBar` — and the result is
 * threaded straight into `<EditorView>`'s `viewportHeight` prop. When no
 * live terminal is available (a caller/test that constructs `EditorArea`
 * outside a real/headless `CliRenderer`), `viewportHeight` is left
 * `undefined` and `EditorView` falls back to its own
 * `DEFAULT_VIEWPORT_HEIGHT` constant, unchanged from before this fix.
 */
export function EditorArea(props: EditorAreaProps): ReactNode {
  const theme = useTheme();
  const focusRef = useFocusTracking("editorFocus");
  const tabs = props.tabs ?? [];
  const find = props.activeEditorState?.find;
  const isFindOpen = find?.isOpen ?? false;
  // The exact same condition the JSX below uses to decide whether
  // `<FindWidget>` renders at all (this component's TSDoc's "Sizing
  // `EditorView`'s `viewportHeight`") — computed once and reused for both,
  // so the chrome height calculation can never drift from what's actually
  // drawn.
  const findWidgetVisible = Boolean(find && isFindOpen && props.findService);

  // Issue #92 — see this component's own TSDoc.
  const terminalHeight = useLiveTerminalDimensions()?.height;
  const chrome: EditorAreaChrome = {
    tabBar: tabs.length > 0 ? TAB_BAR_HEIGHT : 0,
    findWidget: findWidgetVisible ? FIND_WIDGET_HEIGHT : 0,
    panel: props.panelVisible ? (props.panelHeight ?? 0) : 0,
    statusBar: STATUS_BAR_HEIGHT,
  };
  const viewportHeight =
    terminalHeight !== undefined ? computeEditorViewportHeight(terminalHeight, chrome) : undefined;

  const textPlaneNodeRef = useRef<FocusableNode | null>(null);
  const wasFindOpenRef = useRef(false);
  useEffect(() => {
    if (wasFindOpenRef.current && !isFindOpen) {
      textPlaneNodeRef.current?.focus();
    }
    wasFindOpenRef.current = isFindOpen;
  }, [isFindOpen]);

  // Initial/re-focus of the text plane (Req 4.6, 6.7; Issue #82) — see this
  // component's own TSDoc above ("Initial/re-focus of the text plane" and
  // "A deferred attempt is retried, never discarded") for the full "why".
  // `focusContext` is `undefined` outside a `ContextFocusTracker` (`focus.
  // tsx`'s `useFocusContextService` TSDoc) — every guard read below then
  // evaluates to `undefined` (falsy), i.e. "assume nothing else holds
  // focus", matching every other optional-dependency fallback in this
  // module rather than skipping the whole effect.
  const focusContext = useFocusContextService();
  // Detects a genuine "active document changed" transition ONLY — advanced
  // unconditionally the instant a new uri is seen, independent of the
  // do-not-steal guard below (this was never the bug CodeRabbit found;
  // keep it separate from `pendingFocusUriRef` so it stays that way).
  const previousActiveUriRef = useRef<string | undefined>(undefined);
  // The uri still OWED a focus attempt, if any — set when a transition is
  // detected, left alone (not cleared) if the guard defers it, and cleared
  // only once `attemptFocus` actually calls `.focus()`. `undefined` means
  // "nothing pending" — the common, unguarded case reaches that state on
  // the very same render that detected the transition.
  const pendingFocusUriRef = useRef<string | undefined>(undefined);

  const attemptFocus = useCallback(() => {
    if (!pendingFocusUriRef.current) return; // Nothing owed — including a prior success.

    // Do-not-steal guard (this component's TSDoc): the command palette, an
    // input box, the find widget, or the explorer sidebar may legitimately
    // hold focus right now — none of them are this component's own React
    // descendants, so they can only be observed through the shared context
    // service, not through props/tree structure. Left pending (not
    // cleared) when guarded, so a later retry (this effect's own `uri`
    // change, or the `onDidChange`-driven retry below) can pick it back up.
    if (
      focusContext?.get<boolean>(QUICK_PICK_FOCUS_CONTEXT_KEY) ||
      focusContext?.get<boolean>(INPUT_BOX_FOCUS_CONTEXT_KEY) ||
      focusContext?.get<boolean>("findWidgetFocus") ||
      focusContext?.get<boolean>("explorerFocus") ||
      focusContext?.get<boolean>("terminalFocus") ||
      isFindOpen
    ) {
      return;
    }

    // Cleared BEFORE focusing (not after): `.focus()` synchronously fires
    // `FOCUSED`, which `editorView.tsx`'s `useFocusTracking("editorTextFocus")`
    // reports straight into `focusContext`, which in turn fires the
    // `onDidChange` this same function is subscribed to below — clearing
    // first guarantees that re-entrant call sees nothing pending and no-ops,
    // rather than racing a second `.focus()` call on the same node.
    pendingFocusUriRef.current = undefined;
    textPlaneNodeRef.current?.focus();
  }, [focusContext, isFindOpen]);

  useEffect(() => {
    const uri = props.activeDocument?.uri;
    if (uri === previousActiveUriRef.current) return; // No transition.
    previousActiveUriRef.current = uri;
    pendingFocusUriRef.current = uri; // `undefined` uri: nothing to focus (case 2's precondition).
    attemptFocus();
  }, [props.activeDocument?.uri, attemptFocus]);

  // Retries a deferred attempt once whatever guarded it clears (this
  // component's TSDoc's "A deferred attempt is retried, never discarded").
  // `onDidChange` fires on ANY context-service key changing, not just the
  // four this guard reads — deliberately unfiltered, since `attemptFocus`
  // itself is a cheap no-op whenever nothing is pending (`pendingFocusUriRef`
  // is `undefined`) or the guard is still active, so over-calling it here
  // costs nothing and needs no per-key wiring to stay correct as guards
  // come and go.
  useEffect(() => {
    if (!focusContext) return undefined;
    const subscription = focusContext.onDidChange(() => attemptFocus());
    return () => subscription.dispose();
  }, [focusContext, attemptFocus]);

  // Stable identity across every render (CodeRabbit finding on PR #59) — a
  // fresh inline arrow here would give `EditorView`'s own `textPlaneRef`
  // `useCallback` (`editorView.tsx`, deps include `onTextPlaneNode`) a new
  // function identity on every `EditorArea` re-render, and React detaches/
  // reattaches a `ref` callback (calling the OLD one with `null`, then the
  // NEW one with the node) whenever ITS OWN identity changes — even though
  // the underlying OpenTUI node never actually changed. `editorView.tsx`'s
  // `textPlaneRef` also carries `useFocusTracking("editorTextFocus")`
  // (`contextFocusRef`): detaching a node `useFocusTracking` currently
  // believes is focused force-reports `editorTextFocus` FALSE (`focus.tsx`'s
  // "detaching a still-focused node" fix, from this same PR) — so an
  // `editorSession.setState`-driven re-render while the user is mid-typing
  // in the buffer would spuriously blur it, discarding every keystroke that
  // arrives before the immediately-following re-render re-attaches (and
  // still never refocuses, since the node's OWN `_focused` flag never
  // changed — no new `FOCUSED` event fires to flip `useFocusTracking`'s
  // tracked state back). An empty-deps `useCallback` (this closes only over
  // the ref, never over any per-render value) keeps the SAME function
  // identity for `EditorArea`'s whole lifetime, so `EditorView`'s ref only
  // ever attaches/detaches on a REAL mount/unmount (e.g. switching the
  // active document, `key={props.activeDocument.uri}` below), never on an
  // unrelated re-render.
  const handleTextPlaneNode = useCallback((node: FocusableNode | null) => {
    textPlaneNodeRef.current = node;
  }, []);

  // Publishes the terminal's escape-hatch focus handle (this component's
  // TSDoc's "Publishing a focus handle for the terminal's own escape
  // hatch", Issue #98 Phase 3) — stable identity (empty deps, mirrors
  // `handleTextPlaneNode` above) so `props.onEditorFocusHandleChange` is
  // called exactly once for this component's whole lifetime, regardless of
  // how many times the active document (and therefore `textPlaneNodeRef`'s
  // underlying node) changes afterward.
  const focusEditorText = useCallback(() => {
    textPlaneNodeRef.current?.focus();
  }, []);
  useEffect(() => {
    props.onEditorFocusHandleChange?.(focusEditorText);
  }, [props.onEditorFocusHandleChange, focusEditorText]);

  return (
    <box
      ref={focusRef}
      focusable
      style={{ flexDirection: "column", flexGrow: 1 }}
      backgroundColor={toColorInput(theme.colors["editor.background"])}
    >
      {tabs.length > 0 ? (
        <Tabs tabs={tabs} activeId={props.activeTabId} onSelect={props.onSelectTab} />
      ) : null}
      {findWidgetVisible && find && props.findService ? (
        <FindWidget find={find} findService={props.findService} />
      ) : null}
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        {props.activeDocument && props.activeEditorState ? (
          // Keyed by the document's uri — the same "switching content
          // unmounts the old fiber" pattern this module already uses for
          // Sidebar/Panel's `key={view.id}` (components.tsx's
          // RegisteredView TSDoc), applied to the active tab's EditorView.
          <EditorView
            key={props.activeDocument.uri}
            document={props.activeDocument}
            state={props.activeEditorState}
            viewportHeight={viewportHeight}
            config={props.config}
            highlightService={props.highlightService}
            onTextPlaneNode={handleTextPlaneNode}
          />
        ) : (
          <text fg={toColorInput(theme.colors["editor.foreground"])}>
            {tabs.length > 0 ? "" : "No editor open."}
          </text>
        )}
      </box>
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */

/** Props for {@link Panel}. */
export interface PanelProps {
  slotRegistry: SlotRegistry;
  visible: boolean;
  height: number;
}

/** Rows the Panel's own top border occupies (`border={["top"]}` below) —
 * always drawn while the panel is visible at all, so always reserved
 * (matches `STATUS_BAR_HEIGHT`'s own "always rendered, always reserved"
 * framing). */
const PANEL_BORDER_HEIGHT = 1;

/** The bottom panel (Req 6.1, 6.2, 6.4): one tab per `panel.tab`
 * registration.
 *
 * **`viewProps` (Issue #98 Phase 3)**: the active tab's component receives
 * `{ height, width }` — the panel's own CONTENT area, already net of this
 * component's own chrome (`PANEL_BORDER_HEIGHT`'s top border, plus
 * `TAB_BAR_HEIGHT` whenever a tab bar actually renders) — via `viewProps`,
 * the same mechanism `ActivityBar` already uses for `viewProps={{ active
 * }}`; `RegisteredView` (`components.tsx`) simply spreads whatever object
 * it's given onto the rendered component as props. A `panel.tab` view that
 * needs to size a live pty/VT emulator to its real drawing area (the
 * terminal built-in, Issue #98 Phase 4) reads these instead of trying to
 * re-derive Panel's own internal layout constants itself. `undefined`
 * width/height (no live renderer mounted — `useLiveTerminalDimensions`'s
 * own TSDoc) is passed through as-is; a view that cares falls back to its
 * own default, matching every other "optional dependency" convention in
 * this module. */
export function Panel(props: PanelProps): ReactNode {
  const theme = useTheme();
  const views = useSlotViews(props.slotRegistry, "panel.tab");
  const focusRef = useFocusTracking("panelFocus");
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);
  const terminalDimensions = useLiveTerminalDimensions();

  if (!props.visible) return null;

  const activeId = activeTabId && views.some((v) => v.id === activeTabId) ? activeTabId : views[0]?.id;
  const active = views.find((v) => v.id === activeId);

  if (active && active.lazy && !active.component) {
    props.slotRegistry.requestActivation("panel.tab", active.id);
  }

  const tabs: TabItem[] = views.map((v) => ({ id: v.id, label: v.title ?? v.id }));
  const tabBarHeight = tabs.length > 0 ? TAB_BAR_HEIGHT : 0;
  const contentHeight = Math.max(0, props.height - PANEL_BORDER_HEIGHT - tabBarHeight);
  const viewProps = {
    height: contentHeight,
    width: terminalDimensions?.width,
  };

  return (
    <box
      ref={focusRef}
      focusable
      style={{ flexDirection: "column", height: props.height }}
      backgroundColor={toColorInput(theme.colors["panel.background"])}
      border={["top"]}
      borderColor={toColorInput(theme.colors["panel.border"])}
    >
      {tabs.length > 0 ? <Tabs tabs={tabs} activeId={activeId} onSelect={setActiveTabId} /> : null}
      {/* Keyed by active.id for the same reason as Sidebar above — switching
       * the active panel tab must remount rather than reuse the previous
       * tab's fiber. */}
      {active?.component ? (
        <RegisteredView key={active.id} component={active.component} viewProps={viewProps} />
      ) : null}
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* StatusBar                                                            */
/* ------------------------------------------------------------------ */

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
  slotRegistry: SlotRegistry;
}

/** The status bar (Req 6.1, 6.2): every `statusBar.item`, sorted by side
 * and priority (design.md §8.2). */
export function StatusBar(props: StatusBarProps): ReactNode {
  const theme = useTheme();
  const items = useStatusBarItems(props.slotRegistry);
  const left = items.filter((i) => (i.statusBar?.side ?? "left") === "left");
  const right = items.filter((i) => (i.statusBar?.side ?? "left") === "right");

  function renderItem(item: SlotViewEntry): ReactNode {
    if (item.component) return <RegisteredView key={item.id} component={item.component} />;
    return (
      <text key={item.id} fg={toColorInput(theme.colors["statusBar.foreground"])}>
        {item.title ?? item.id}
      </text>
    );
  }

  return (
    <box
      style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}
      backgroundColor={toColorInput(theme.colors["statusBar.background"])}
    >
      <box style={{ flexDirection: "row" }}>{left.map(renderItem)}</box>
      <box style={{ flexDirection: "row" }}>{right.map(renderItem)}</box>
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                                */
/* ------------------------------------------------------------------ */

/** Props for {@link Shell}. */
export interface ShellProps {
  slotRegistry: SlotRegistry;
  layoutState: LayoutStateService;
  /** Registers a `workbench.view.<id>` command per known sidebar pair (Req
   * 6.2: "the `workbench.view.<id>` command switches to the same-id
   * sidebar view"), kept in sync as pairs come and go. Optional — a caller
   * with no command registry wired yet (e.g. an isolated component test)
   * simply gets activity-bar-click switching without the command. */
  commands?: CommandRegistry;
  /** Fallback tab list used only when `documents` is not provided (or has
   * no open documents yet) — this module's original decoupled-from-any-
   * document-manager tab display, kept for backward compatibility with
   * existing callers/tests (this module's TSDoc). */
  editorTabs?: TabItem[];
  activeEditorTabId?: string;
  onSelectEditorTab?: (id: string) => void;
  /** Drives the real `EditorArea`/`EditorView` from open documents (Req
   * 6.5, 6.6, design.md §8.1) — tabs, the active tab, and per-tab
   * `EditorState` are all derived from this instead of the
   * `editorTabs`/`activeEditorTabId`/`onSelectEditorTab` props above once
   * it is given. Optional and kept that way deliberately: existing
   * callers/tests that construct a `Shell` without a `DocumentManager`
   * (there is no core-owned default one to fall back to) keep working
   * exactly as before (this module's TSDoc). */
  documents?: DocumentManager;
  /** Threaded through to `EditorView` for its `editor.lineNumbers` lookup
   * (Req 9.5). */
  config?: ConfigService;
  /**
   * Owns the active document uri and every open document's `EditorState`
   * from outside this component (Task 2.2, `ui/editorSession.ts`'s TSDoc)
   * — needed once something other than `Shell` itself (the editor input
   * router, at the composition root, `packages/cli`) must read/write the
   * same active-document/cursor state React does. When given, `Shell`
   * defers to it entirely for both concerns and re-renders on its
   * `onDidChange`; the local `useState`/`useRef` fallback below (Task 2.1's
   * original, still-correct implementation) only runs when it is omitted,
   * so an existing caller/test that never passes one keeps its exact prior
   * behavior. */
  editorSession?: EditorSessionService;
  /** Threaded straight through to `EditorArea` for its `FindWidget`
   * sibling (Req 11.1, design.md §13) — see `EditorAreaProps.findService`'s
   * TSDoc. */
  findService?: Pick<FindService, "setQuery" | "setReplaceQuery" | "toggleCaseSensitive">;
  /** Threaded straight through to `EditorArea` for `EditorView`'s syntax
   * highlighting (Req 8.1, design.md §10) — see
   * `EditorAreaProps.highlightService`'s TSDoc. */
  highlightService?: Pick<HighlightService, "getSpansForLine" | "onDidChange">;
  /** Threaded straight through to `EditorArea` (Issue #98 Phase 3) — see
   * `EditorAreaProps.onEditorFocusHandleChange`'s TSDoc. */
  onEditorFocusHandleChange?: (focus: () => void) => void;
}

/** Re-renders the calling component whenever any currently-open document's
 * `dirty` flag can have changed (Task 3.5, Req 6.5): a document's `dirty`
 * flip is NOT reflected in `openDocuments`' own array identity
 * (`useOpenDocuments` above only re-renders — and re-memoizes — on
 * `onDidOpen`/`onDidClose`, never on a document's own `onDidChange`/
 * `onDidSave`), so `editorTabs`' `dirty: d.dirty` read below would
 * otherwise only ever reflect whatever `dirty` happened to read at the
 * moment SOME OTHER open/close-driven render last ran. Two event sources
 * are needed, not one: `document.onDidChange` fires the moment an edit
 * sets `dirty = true` (`buffer/document.ts`'s `applyEdits`), but a
 * successful save clears `dirty` via `CoreDocument.markSaved()` WITHOUT
 * itself firing `onDidChange` (`document.ts`'s `markSaved`'s own TSDoc) —
 * `DocumentManager.onDidSave` is what reports that transition instead
 * (`documentManager.ts`'s `saveNow`). Subscribes to both per open
 * document.
 *
 * **Re-subscribes exactly when the open set changes, not on every dirty
 * flip** (this hook's own correctness requirement — a stale subscription
 * set would silently stop tracking a document closed-then-reopened under
 * a different in-memory instance, or leak a subscription for one no
 * longer open): keyed on `[documents, openDocuments]` in the effect's
 * dependency array — `openDocuments` is `useOpenDocuments`'s `useMemo`
 * result, a stable reference across renders UNTIL the open set itself
 * changes (that hook's own TSDoc), so this effect only re-runs (tearing
 * down the old per-document subscriptions and building fresh ones) on a
 * real open/close, never merely because some document's `dirty` flag
 * flipped and triggered this hook's own `forceRender`. No-op (no
 * subscriptions at all) when `documents` is `undefined` — matches
 * `useOpenDocuments`'s own "no `DocumentManager` wired in" contract. */
function useDocumentDirtyTick(
  documents: DocumentManager | undefined,
  openDocuments: readonly CoreDocument[],
): void {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!documents) return undefined;
    const disposables: Disposable[] = openDocuments.map((d) => d.onDidChange(() => forceRender()));
    disposables.push(documents.onDidSave(() => forceRender()));
    // Closes the subscribe-after-render race — see useSlotViews's TSDoc: a
    // dirty flip landing in the gap between the render that read `d.dirty`
    // and this effect actually subscribing must not be lost.
    forceRender();
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [documents, openDocuments]);
}

/** Re-renders the calling component whenever `session` reports a change
 * (Task 2.2, `ui/editorSession.ts`) — same subscribe-then-force-render
 * shape, including the same subscribe-after-render race fix, as
 * {@link useSlotViews}/{@link useOpenDocuments} above. A no-op subscription
 * when `session` is `undefined` (`Shell`'s Task 2.1 fallback path never
 * needs this to fire). */
function useEditorSessionVersion(session: EditorSessionService | undefined): void {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!session) return undefined;
    const sub = session.onDidChange(() => forceRender());
    // Closes the subscribe-after-render race — see useSlotViews's TSDoc.
    forceRender();
    return () => sub.dispose();
  }, [session]);
}

/** The UI shell (Req 6.1-6.5, design.md §8.1): the top-level VS Code-style
 * layout. `ThemeProvider`/`ContextFocusTracker` wrap this from the outside
 * (this module's TSDoc) — `Shell` itself only needs the slot registry and
 * layout state. */
export function Shell(props: ShellProps): ReactNode {
  const [layout, updateLayout] = useLayoutState(props.layoutState);
  const pairs = useSidebarPairs(props.slotRegistry);
  const editorSession = props.editorSession;
  useEditorSessionVersion(editorSession);

  // Req 6.5, 6.6, design.md §8.1: tabs/active-tab/EditorState derived from
  // `props.documents` once it's given — see ShellProps' TSDoc for the
  // fallback when it isn't.
  const openDocuments = useOpenDocuments(props.documents);
  // Task 3.5, Req 6.5: re-render on a dirty-flag flip so `editorTabs`'
  // `dirty: d.dirty` below stays live — see this hook's own TSDoc.
  useDocumentDirtyTick(props.documents, openDocuments);
  // Task 2.1's original, component-local active-uri/EditorState tracking —
  // used only when `props.editorSession` is not given (ShellProps' TSDoc on
  // `editorSession`). Both hooks below still run unconditionally (Rules of
  // Hooks); each simply no-ops when a session was provided, since the
  // session already runs this exact policy itself (`ui/editorSession.ts`).
  const [localActiveDocumentUri, setLocalActiveDocumentUri] = useState<Uri | undefined>(undefined);
  const localEditorStatesRef = useRef<Map<Uri, EditorState>>(new Map());

  useEffect(() => {
    if (editorSession) return;
    if (openDocuments.length === 0) {
      setLocalActiveDocumentUri(undefined);
      return;
    }
    setLocalActiveDocumentUri((current) => {
      // Keep the current active document if it's still open; otherwise
      // fall back to the first open one (covers both "nothing selected
      // yet" and "the active document just closed").
      if (current && openDocuments.some((d) => d.uri === current)) return current;
      return openDocuments[0]!.uri;
    });
  }, [openDocuments, editorSession]);

  useEffect(() => {
    if (editorSession) return;
    // Drop retained EditorState for documents that are no longer open —
    // otherwise a long session's Map would grow forever across
    // open/close cycles.
    const openUris = new Set(openDocuments.map((d) => d.uri));
    for (const uri of Array.from(localEditorStatesRef.current.keys())) {
      if (!openUris.has(uri)) localEditorStatesRef.current.delete(uri);
    }
  }, [openDocuments, editorSession]);

  function getOrCreateEditorState(uri: Uri): EditorState {
    if (editorSession) return editorSession.getState(uri);
    let state = localEditorStatesRef.current.get(uri);
    if (!state) {
      state = createInitialEditorState(uri);
      localEditorStatesRef.current.set(uri, state);
    }
    return state;
  }

  const activeDocumentUri = editorSession ? editorSession.getActiveDocumentUri() : localActiveDocumentUri;
  const setActiveDocumentUri = useCallback(
    (uri: string) => {
      if (editorSession) editorSession.setActiveDocumentUri(uri);
      else setLocalActiveDocumentUri(uri);
    },
    [editorSession],
  );

  const hasOpenDocuments = openDocuments.length > 0;
  // With an `editorSession`, resolve the active document through the
  // service itself — `ShellProps` allows `editorSession` without
  // `documents`, and in that configuration `openDocuments` is empty even
  // though the session knows the active document.
  const activeDocument = editorSession
    ? editorSession.getActiveDocument()
    : activeDocumentUri
      ? openDocuments.find((d) => d.uri === activeDocumentUri)
      : undefined;
  const editorTabs: TabItem[] = hasOpenDocuments
    ? openDocuments.map((d) => ({ id: d.uri, label: basename(uriToPath(d.uri)), dirty: d.dirty }))
    : (props.editorTabs ?? []);
  const activeEditorTabId = hasOpenDocuments ? activeDocumentUri : props.activeEditorTabId;
  const onSelectEditorTab = hasOpenDocuments ? setActiveDocumentUri : props.onSelectEditorTab;

  const selectSidebarView = useCallback(
    (id: string) => {
      if (layout.activeView === id) {
        // Clicking the already-active item toggles the sidebar shut, VS
        // Code-style, rather than doing nothing.
        updateLayout({ sidebarVisible: !layout.sidebarVisible });
        return;
      }
      updateLayout({ activeView: id, sidebarVisible: true });
    },
    [layout.activeView, layout.sidebarVisible, updateLayout],
  );

  // Req 6.2: a `workbench.view.<id>` command per known pair, added/removed
  // as pairs come and go (an extension activating late, or unregistering).
  useEffect(() => {
    if (!props.commands) return undefined;
    const commands = props.commands;
    const disposables: Disposable[] = pairs.map((pair) =>
      commands.register(`workbench.view.${pair.id}`, () => selectSidebarView(pair.id)),
    );
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [props.commands, pairs, selectSidebarView]);

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <ActivityBar
          slotRegistry={props.slotRegistry}
          activeView={layout.activeView}
          onSelectView={selectSidebarView}
        />
        <Sidebar
          slotRegistry={props.slotRegistry}
          visible={layout.sidebarVisible}
          width={layout.sidebarWidth}
          activeView={layout.activeView}
        />
        <EditorArea
          tabs={editorTabs}
          activeTabId={activeEditorTabId}
          onSelectTab={onSelectEditorTab}
          activeDocument={activeDocument}
          activeEditorState={activeDocument ? getOrCreateEditorState(activeDocument.uri) : undefined}
          config={props.config}
          findService={props.findService}
          highlightService={props.highlightService}
          panelVisible={layout.panelVisible}
          panelHeight={layout.panelHeight}
          onEditorFocusHandleChange={props.onEditorFocusHandleChange}
        />
      </box>
      <Panel slotRegistry={props.slotRegistry} visible={layout.panelVisible} height={layout.panelHeight} />
      <StatusBar slotRegistry={props.slotRegistry} />
    </box>
  );
}
