/**
 * The UI shell (Req 6.1-6.5; design.md §8.1, §8.2; Task 1.14): the VS
 * Code-style arrangement of `ActivityBar` / `Sidebar` / `EditorArea`
 * (`TabBar` + a placeholder `EditorView`) / `Panel` / `StatusBar`, wired to
 * the {@link SlotRegistry} (Req 6.2, 6.3) and the {@link LayoutStateService}
 * (Req 6.4).
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
 * **`EditorView` is a placeholder** (design.md §8.3 — the real
 * cursor/selection/gutter-rendering editor is a later task; tasks.md's
 * Phase 1 exit criterion is explicitly "no visible editing yet"). `TabBar`
 * accordingly renders whatever `tabs` `EditorArea` is given (empty by
 * default) rather than reading from a document manager this task does not
 * wire in.
 */

import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import type { Disposable, SlotId } from "@tecode/api";
import type { CommandRegistry } from "../commands/registry";
import { RegisteredView, Tabs, type TabItem } from "./components";
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
/* EditorArea (TabBar + placeholder EditorView)                        */
/* ------------------------------------------------------------------ */

/** Props for {@link EditorArea}. */
export interface EditorAreaProps {
  /** Open editor tabs — one editor group, N tabs (Req 6.5). Empty by
   * default: no document manager is wired into the shell yet (this
   * module's TSDoc). */
  tabs?: TabItem[];
  activeTabId?: string;
  onSelectTab?: (id: string) => void;
}

/** The editor area (Req 6.1, 6.5): a `TabBar` over a placeholder
 * `EditorView` (design.md §8.3 — the real editor is a later task). */
export function EditorArea(props: EditorAreaProps): ReactNode {
  const theme = useTheme();
  const focusRef = useFocusTracking("editorFocus");
  const tabs = props.tabs ?? [];

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
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        <text fg={toColorInput(theme.colors["editor.foreground"])}>
          {tabs.length > 0 ? "" : "No editor open."}
        </text>
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
  editorTabs?: TabItem[];
  activeEditorTabId?: string;
  onSelectEditorTab?: (id: string) => void;
}

/** The UI shell (Req 6.1-6.5, design.md §8.1): the top-level VS Code-style
 * layout. `ThemeProvider`/`ContextFocusTracker` wrap this from the outside
 * (this module's TSDoc) — `Shell` itself only needs the slot registry and
 * layout state. */
export function Shell(props: ShellProps): ReactNode {
  const [layout, updateLayout] = useLayoutState(props.layoutState);
  const pairs = useSidebarPairs(props.slotRegistry);

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
          tabs={props.editorTabs}
          activeTabId={props.activeEditorTabId}
          onSelectTab={props.onSelectEditorTab}
        />
      </box>
      <Panel slotRegistry={props.slotRegistry} visible={layout.panelVisible} height={layout.panelHeight} />
      <StatusBar slotRegistry={props.slotRegistry} />
    </box>
  );
}
