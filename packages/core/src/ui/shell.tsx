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
import { FindWidget } from "./findWidget";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import type { LayoutState, LayoutStateService } from "./layoutState";
import type { SidebarPair, SlotRegistry, SlotViewEntry } from "./slotRegistry";
import { toColorInput, useTheme } from "./theme";

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
 */
export function EditorArea(props: EditorAreaProps): ReactNode {
  const theme = useTheme();
  const focusRef = useFocusTracking("editorFocus");
  const tabs = props.tabs ?? [];
  const find = props.activeEditorState?.find;
  const isFindOpen = find?.isOpen ?? false;

  const textPlaneNodeRef = useRef<FocusableNode | null>(null);
  const wasFindOpenRef = useRef(false);
  useEffect(() => {
    if (wasFindOpenRef.current && !isFindOpen) {
      textPlaneNodeRef.current?.focus();
    }
    wasFindOpenRef.current = isFindOpen;
  }, [isFindOpen]);

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
      {find && isFindOpen && props.findService ? (
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
            config={props.config}
            onTextPlaneNode={(node) => {
              textPlaneNodeRef.current = node;
            }}
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

/** The bottom panel (Req 6.1, 6.2, 6.4): one tab per `panel.tab`
 * registration. */
export function Panel(props: PanelProps): ReactNode {
  const theme = useTheme();
  const views = useSlotViews(props.slotRegistry, "panel.tab");
  const focusRef = useFocusTracking("panelFocus");
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);

  if (!props.visible) return null;

  const activeId = activeTabId && views.some((v) => v.id === activeTabId) ? activeTabId : views[0]?.id;
  const active = views.find((v) => v.id === activeId);

  if (active && active.lazy && !active.component) {
    props.slotRegistry.requestActivation("panel.tab", active.id);
  }

  const tabs: TabItem[] = views.map((v) => ({ id: v.id, label: v.title ?? v.id }));

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
      {active?.component ? <RegisteredView key={active.id} component={active.component} /> : null}
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
    ? openDocuments.map((d) => ({ id: d.uri, label: basename(uriToPath(d.uri)) }))
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
        />
      </box>
      <Panel slotRegistry={props.slotRegistry} visible={layout.panelVisible} height={layout.panelHeight} />
      <StatusBar slotRegistry={props.slotRegistry} />
    </box>
  );
}
