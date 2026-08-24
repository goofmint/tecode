/**
 * The common component library `tecode.ui.List`/`Tree`/`Input`/`Tabs`
 * expose (Req 10.1, 6.3; design.md §8.1; Task 1.14) — minimal
 * implementations over OpenTUI's own `<select>`/`<tab-select>`/`<input>`/
 * `<box>` intrinsics, all colors sourced from {@link useTheme} (Req 7.3).
 * Deliberately minimal (tasks.md's Task 1.14: "later tasks extend") — no
 * virtualization, no keyboard-navigation customization beyond what the
 * underlying OpenTUI renderable already provides.
 *
 * **Prop typing, and why it looks loose**: `@tecode/api`'s
 * `ComponentType<P = Record<string, unknown>> = (props: P) => unknown` is
 * deliberately React-free (`namespaces.ts`'s TSDoc). `UiNamespace.List`
 * etc. are typed as the bare `ComponentType` (i.e. `P` defaults to
 * `Record<string, unknown>`), and TypeScript's strict function-parameter
 * contravariance means only a function whose parameter accepts *at least*
 * `Record<string, unknown>` is assignable there — a function typed to take
 * a narrower, concrete props interface is not. Every component below is
 * therefore declared as `(rawProps: Record<string, unknown>) => ReactNode`
 * and casts internally to its own documented props interface; callers using
 * JSX (`<List items={...} />`) stay fully ergonomic regardless, since an
 * object literal with known, narrower-typed properties is always assignable
 * to `Record<string, unknown>` (every property value is assignable to
 * `unknown`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KeyEvent, SelectOption, TabSelectOption, TabSelectRenderable } from "@opentui/core";
import type { ComponentType } from "@tecode/api";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import { toColorInput, useTheme } from "./theme";

/* ------------------------------------------------------------------ */
/* Bridging @tecode/api's ComponentType to a real React element         */
/* ------------------------------------------------------------------ */

/**
 * Render a registered `tecode.ui.registerView`/`List`/`Tree`/`Input`/`Tabs`
 * component (a plain `(props) => unknown` function, not a JSX component
 * type) as part of a real React tree (design.md §12's "bridge `@tecode/
 * api`'s React-free `ComponentType` to real React component types in
 * core"). `component` is cast to a real React function-component type and
 * rendered as a JSX element (`<Component .../>`) — never called directly as
 * a plain function. Calling it directly would attach any hooks it calls
 * (e.g. `tecode.ui.useTheme()`) to *this* component's own hook state
 * instead of a fiber of its own; swapping in a differently-registered
 * `component` with a different hook count at the same call site would then
 * throw ("Rendered fewer hooks than expected") and, when the hook counts
 * happen to match, leak state across unrelated views. Rendering it as a
 * real element gives every registered component its own fiber, keyed by
 * the caller (see `shell.tsx`'s `key={view.id}` usage) so switching views
 * cleanly unmounts the old one and mounts the new one.
 */
export function RegisteredView(props: {
  component: ComponentType;
  viewProps?: Record<string, unknown>;
}): ReactNode {
  const Component = props.component as unknown as (p: Record<string, unknown>) => ReactNode;
  return <Component {...(props.viewProps ?? {})} />;
}

/* ------------------------------------------------------------------ */
/* List                                                                 */
/* ------------------------------------------------------------------ */

/** One selectable row (the concrete shape {@link List} expects in its
 * `items` prop, cast from the loosely-typed `Record<string, unknown>` —
 * see this module's TSDoc). */
export interface ListItem {
  id: string;
  label: string;
  description?: string;
}

/** {@link List}'s props. */
export interface ListProps {
  items?: ListItem[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  focused?: boolean;
}

/** A minimal selectable list (`tecode.ui.List`, Req 10.1), over OpenTUI's
 * `<select>`. */
export function List(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as ListProps;
  const theme = useTheme();
  const items = props.items ?? [];
  const options: SelectOption[] = items.map((item) => ({
    name: item.label,
    description: item.description ?? "",
    value: item.id,
  }));
  const selectedIndex = props.selectedId
    ? items.findIndex((item) => item.id === props.selectedId)
    : -1;

  return (
    <select
      options={options}
      // OpenTUI's <select> only shows as many rows as its own assigned
      // height, defaulting very small when unconstrained; size it to fit
      // every item unless a parent layout (flexGrow, an explicit height)
      // overrides this via `style`.
      height={Math.max(items.length, 1)}
      selectedIndex={selectedIndex >= 0 ? selectedIndex : undefined}
      focused={props.focused}
      showDescription={items.some((item) => item.description)}
      backgroundColor={toColorInput(theme.colors["sideBar.background"])}
      textColor={toColorInput(theme.colors["sideBar.foreground"])}
      selectedBackgroundColor={toColorInput(theme.colors["list.activeSelectionBackground"])}
      selectedTextColor={toColorInput(theme.colors["list.activeSelectionForeground"])}
      onSelect={(_index, option) => {
        if (option && typeof option.value === "string") props.onSelect?.(option.value);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Tree                                                                 */
/* ------------------------------------------------------------------ */

/** One node of a {@link Tree} (the concrete shape {@link Tree} expects —
 * see this module's TSDoc). */
export interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
  /**
   * Explicit override for whether this node shows the expand/collapse
   * affordance and participates in `right`/`left`-arrow nav as a branch
   * (this module's TSDoc's "keyboard nav"), independent of `children`'s
   * current length (Task 3.3, Req 11.2). The explorer's directory nodes
   * are known to BE directories — and so must show the expand arrow —
   * before their children have ever been loaded via `workspace.fs.
   * readdir` (`children` stays `undefined` until the first expand).
   * Omitted (the default): falls back to `(children?.length ?? 0) > 0`,
   * Task 1.14's original, still-correct behavior for a fully-eager caller
   * that always has every node's full `children` array up front.
   */
  hasChildren?: boolean;
}

/** {@link Tree}'s props. */
export interface TreeProps {
  nodes?: TreeNode[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  /**
   * Controlled expansion (Task 3.3, Req 11.2): when given, expand/collapse
   * state is driven entirely by the caller (paired with {@link onToggle})
   * instead of Tree's own internal state. The explorer built-in needs this
   * — its tree nodes are populated lazily via `workspace.fs.readdir` as
   * each directory is expanded for the first time, so it must observe
   * every expand/collapse itself rather than let Tree silently manage that
   * state internally. Omitting this prop keeps the original UNCONTROLLED
   * behavior ({@link defaultExpanded} seeds internal state once at mount;
   * toggling thereafter only ever updates that internal state) — existing
   * callers (Task 1.14) are unaffected.
   */
  expandedIds?: string[];
  /**
   * Called whenever a node with children is toggled — Enter/Return,
   * `left`/`right` (this module's TSDoc's "keyboard nav"), or a mouse
   * click — with `expanding` reporting the state the node is MOVING TO
   * (`true` = about to expand). Fires alongside Tree's own internal
   * uncontrolled toggle too (not just in controlled mode), so a caller
   * that only wants to observe expansion (e.g. to lazily load a
   * directory's children) without taking over the state entirely can pass
   * this without also passing {@link expandedIds}.
   */
  onToggle?: (id: string, expanding: boolean) => void;
  /** Node ids expanded by default (uncontrolled mode only — ignored once
   * {@link expandedIds} is given). */
  defaultExpanded?: string[];
  /**
   * Called when a node is "activated" — pressing Enter/Return while it is
   * the selected node (Task 3.3) — distinct from {@link onSelect} (which
   * also fires on a plain highlight move via the arrow keys or a mouse
   * click over a branch node). The explorer opens a file only on this
   * callback, not on every selection change. Fires for both leaf and
   * branch nodes; a branch node's own Enter ALSO toggles its expansion
   * (see this module's TSDoc's "keyboard nav") independently of whatever
   * this callback does.
   */
  onActivate?: (id: string) => void;
  /**
   * When set, focus gain/loss on Tree's own root box is reported to this
   * context key via `useFocusTracking` (Task 3.3, Req 4.6, 11.2) — e.g.
   * the explorer's `"explorerFocus"`, so a `when: "explorerFocus"`
   * keybinding can gate on it. Omitted (the default): no focus reporting,
   * matching Task 1.14's original behavior.
   */
  focusContextKey?: string;
  /** Ref callback onto the underlying OpenTUI `<box>` node — an escape
   * hatch mirroring {@link InputProps.inputRef}'s own TSDoc (same
   * rationale: not part of `tecode.ui.Tree`'s public extension-facing
   * contract, since `ComponentType`'s props are plain `Record<string,
   * unknown>` — an extension that never sets this key is unaffected).
   * This module's own tests use it to invoke `onKeyDown` directly against
   * the real renderable, the same "capture the real node, call its methods
   * directly" style `focus.test.tsx` uses for `.focus()`/`.blur()`, rather
   * than depend on `testRender`'s mouse/keyboard simulation reproducing a
   * real focus transition end-to-end (`shell.test.tsx`'s documented
   * "Coverage gap" precedent for why that is its own, separate concern).
   */
  treeRef?: (node: FocusableNode | null) => void;
  /** Declarative initial/imperative focus, forwarded straight to the root
   * `<box>` (`@opentui/react`'s own `focused` prop — see `findWidget.tsx`'s
   * TSDoc for the one documented caveat: a `true` value on the very FIRST
   * render focuses the node before `focusContextKey`'s own tracking ref has
   * attached, so the underlying OpenTUI node still becomes genuinely
   * keyboard-focused — real key events dispatch to it correctly — even
   * though that specific initial transition is not itself reported to
   * `focusContextKey`). */
  focused?: boolean;
}

/** One node of {@link Tree}'s CURRENTLY VISIBLE (i.e. every ancestor is
 * expanded) nodes, flattened depth-first in on-screen order — what
 * {@link Tree}'s keyboard nav (this module's TSDoc) walks up/down over, and
 * what its rendering loop iterates to lay out indentation without deep
 * JSX recursion. */
interface FlatTreeNode {
  id: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  parentId: string | undefined;
}

/** Depth-first flatten of `nodes`, stopping recursion at any node not in
 * `expanded` (this module's TSDoc). */
function flattenVisibleNodes(
  nodes: readonly TreeNode[] | undefined,
  expanded: ReadonlySet<string>,
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  function walk(list: readonly TreeNode[], depth: number, parentId: string | undefined): void {
    for (const node of list) {
      const hasChildren = node.hasChildren ?? (node.children?.length ?? 0) > 0;
      result.push({ id: node.id, label: node.label, depth, hasChildren, parentId });
      if (hasChildren && expanded.has(node.id)) {
        walk(node.children ?? [], depth + 1, node.id);
      }
    }
  }
  walk(nodes ?? [], 0, undefined);
  return result;
}

/**
 * A minimal expand/collapse tree (`tecode.ui.Tree`, Req 10.1, 11.2). No
 * native OpenTUI tree renderable exists yet, so this composes `<box>`/
 * `<text>` directly over a depth-first-flattened, indentation-rendered node
 * list (this module's TSDoc's {@link FlatTreeNode}).
 *
 * **Keyboard nav while focused** (Task 3.3, Req 11.2 — the explorer's core
 * interaction): a `focusable` root `<box>` with its own `onKeyDown` handler
 * — the same "a focused OpenTUI node handles its own keys directly, via
 * `RenderableOptions.onKeyDown`" mechanism `@opentui/core`'s own
 * `SelectRenderable`/`TextareaRenderable` use internally (verified against
 * this repo's vendored `@opentui/core@0.1.107` typings: `Renderable.
 * onKeyDown`/`focusable`), rather than a core-level `when`-gated keybinding
 * — Tree is a REUSABLE `tecode.ui` component any extension can mount, with
 * no manifest of its own to declare a keybinding against, so it must own
 * its navigation the same self-contained way OpenTUI's built-in focusable
 * renderables do. `key.name` values (`"up"`/`"down"`/`"left"`/`"right"`/
 * `"return"`) match `@opentui/core`'s own parsed key names, the same names
 * `keymap/keyEvent.ts`'s `keyEventToStroke` reads elsewhere in this
 * codebase:
 * - `up`/`down`: move the highlighted node to the previous/next VISIBLE
 *   node (this module's `flattenVisibleNodes`) and call `onSelect`. No
 *   current `selectedId` (or one no longer visible): lands on the first
 *   node.
 * - `right`: on a collapsed branch, expands it (`toggle`); on an already-
 *   expanded branch, moves selection to its first child; a no-op on a leaf.
 * - `left`: on an expanded branch, collapses it; otherwise (a leaf, or an
 *   already-collapsed branch) moves selection to the parent, if any.
 * - `return`: calls {@link TreeProps.onActivate} for the selected node;
 *   ADDITIONALLY toggles a branch node's expansion (opening a file and
 *   expanding/collapsing a directory are both reasonable "Enter" outcomes,
 *   and are not mutually exclusive — the explorer's own `onActivate`
 *   decides what, if anything, "open" means for a directory id).
 *
 * Every other key passes through unhandled (no `preventDefault` call is
 * available on `@opentui/core`'s `KeyEvent` shape here — this component
 * simply does not act on it, the same "not our key, ignore it" discipline
 * `editor/inputRouter.ts` documents for its own fallthrough scope).
 */
export function Tree(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as TreeProps;
  const theme = useTheme();
  const isControlled = props.expandedIds !== undefined;
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set<string>(props.defaultExpanded ?? []),
  );
  const expanded = useMemo(
    () => (isControlled ? new Set(props.expandedIds ?? []) : internalExpanded),
    [isControlled, props.expandedIds, internalExpanded],
  );
  const focusRef = useFocusTracking(props.focusContextKey);
  const rootRef = useCallback(
    (node: FocusableNode | null) => {
      focusRef(node);
      props.treeRef?.(node);
    },
    [focusRef, props.treeRef],
  );

  const toggle = useCallback(
    (id: string) => {
      const expanding = !expanded.has(id);
      if (!isControlled) {
        setInternalExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
      props.onToggle?.(id, expanding);
    },
    [expanded, isControlled, props.onToggle],
  );

  const flat = useMemo(() => flattenVisibleNodes(props.nodes, expanded), [props.nodes, expanded]);

  const handleKeyDown = useCallback(
    (key: KeyEvent) => {
      if (flat.length === 0) return;
      const currentIndex = props.selectedId ? flat.findIndex((n) => n.id === props.selectedId) : -1;
      const current = currentIndex >= 0 ? flat[currentIndex] : undefined;

      switch (key.name) {
        case "down": {
          const next = flat[currentIndex === -1 ? 0 : Math.min(flat.length - 1, currentIndex + 1)];
          if (next) props.onSelect?.(next.id);
          break;
        }
        case "up": {
          const previous = flat[currentIndex === -1 ? 0 : Math.max(0, currentIndex - 1)];
          if (previous) props.onSelect?.(previous.id);
          break;
        }
        case "right": {
          if (!current) break;
          if (current.hasChildren && !expanded.has(current.id)) {
            toggle(current.id);
          } else if (current.hasChildren) {
            const child = flat[currentIndex + 1];
            if (child && child.parentId === current.id) props.onSelect?.(child.id);
          }
          break;
        }
        case "left": {
          if (!current) break;
          if (current.hasChildren && expanded.has(current.id)) {
            toggle(current.id);
          } else if (current.parentId !== undefined) {
            props.onSelect?.(current.parentId);
          }
          break;
        }
        case "return": {
          if (!current) break;
          if (current.hasChildren) toggle(current.id);
          props.onActivate?.(current.id);
          break;
        }
        default:
          break;
      }
    },
    [flat, props.selectedId, props.onSelect, props.onActivate, expanded, toggle],
  );

  return (
    <box ref={rootRef} focusable focused={props.focused} onKeyDown={handleKeyDown} style={{ flexDirection: "column" }}>
      {flat.map((node) => {
        const isExpanded = expanded.has(node.id);
        const isSelected = props.selectedId === node.id;
        const glyph = node.hasChildren ? (isExpanded ? "▾ " : "▸ ") : "  ";
        return (
          <text
            key={node.id}
            fg={toColorInput(
              isSelected ? theme.colors["list.activeSelectionForeground"] : theme.colors["sideBar.foreground"],
            )}
            bg={isSelected ? toColorInput(theme.colors["list.activeSelectionBackground"]) : undefined}
            onMouseDown={() => {
              if (node.hasChildren) toggle(node.id);
              else props.onActivate?.(node.id);
              props.onSelect?.(node.id);
            }}
          >
            {"  ".repeat(node.depth) + glyph + node.label}
          </text>
        );
      })}
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

/** {@link Input}'s props. */
export interface InputProps {
  value?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  focused?: boolean;
  /**
   * Ref callback onto the underlying OpenTUI `<input>` node — an escape
   * hatch for a `core`-internal caller that needs the raw node itself, to
   * either track its focus (`useFocusTracking`, Req 11.1) or imperatively
   * drive it (`.focus()` — the find widget's own mount effect, `focus.tsx`'s
   * `FocusableNode`'s TSDoc explains why a manual call is needed rather
   * than the declarative `focused` prop below). Not part of `tecode.ui.
   * Input`'s public extension-facing contract — `ComponentType`'s props are
   * plain `Record<string, unknown>` (this module's TSDoc), so an extension
   * that never sets this key is unaffected either way.
   */
  inputRef?: (node: FocusableNode | null) => void;
}

/** A minimal single-line text input (`tecode.ui.Input`, Req 10.1), over
 * OpenTUI's `<input>`. */
export function Input(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as InputProps;
  const theme = useTheme();
  // OpenTUI's `<input>` intrinsic tag name collides with React's built-in
  // DOM `<input>` element, so its declared `onSubmit` type is the
  // intersection of both worlds' shapes (`(e: SubmitEvent) => void &
  // (value: string) => void`). A handler typed to accept `unknown` is
  // assignable to either half by contravariance, so it satisfies both at
  // once without an unsound cast.
  const onSubmit = props.onSubmit
    ? (value: unknown) => {
        if (typeof value === "string") props.onSubmit?.(value);
      }
    : undefined;
  return (
    <input
      ref={props.inputRef}
      value={props.value}
      placeholder={props.placeholder}
      focused={props.focused}
      onInput={props.onChange}
      onSubmit={onSubmit}
      backgroundColor={toColorInput(theme.colors["input.background"])}
      textColor={toColorInput(theme.colors["input.foreground"])}
      placeholderColor={toColorInput(theme.colors["input.placeholderForeground"])}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

/** One tab (the concrete shape {@link Tabs} expects — see this module's
 * TSDoc). `dirty` (Task 3.5, Req 6.5) marks a tab whose document has
 * unsaved changes — `shell.tsx`'s `editorTabs` reads this straight off
 * `CoreDocument.dirty`, the single source of truth (`buffer/document.ts`).
 * Optional and defaulted to `false` so every pre-Task-3.5 caller (every
 * test/story that builds a bare `{ id, label }`) keeps rendering exactly
 * as before. */
export interface TabItem {
  id: string;
  label: string;
  dirty?: boolean;
}

/** The marker {@link Tabs} embeds into a dirty tab's displayed name (Task
 * 3.5) — OpenTUI's `<tab-select>` only accepts each option's display name
 * as a plain string (`TabSelectOption.name`, this module's `options`
 * mapping below), so there is no separate "dirty" visual channel to hook
 * into; prefixing the label is the only available signal. Exported so
 * `components.test.tsx` (and any other caller that needs to recognize a
 * dirty tab's rendered text) doesn't have to duplicate the literal. */
export const TAB_DIRTY_MARKER = "● ";

/** {@link Tabs}'s props. */
export interface TabsProps {
  tabs?: TabItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  focused?: boolean;
}

/** A minimal tab strip (`tecode.ui.Tabs`, Req 10.1, 6.5), over OpenTUI's
 * `<tab-select>` — used by `EditorArea`'s `TabBar` (design.md §8.1). */
export function Tabs(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as TabsProps;
  const theme = useTheme();
  const tabs = props.tabs ?? [];
  const options: TabSelectOption[] = tabs.map((tab) => ({
    name: tab.dirty ? `${TAB_DIRTY_MARKER}${tab.label}` : tab.label,
    description: "",
    value: tab.id,
  }));
  const selectedIndex = props.activeId ? tabs.findIndex((tab) => tab.id === props.activeId) : -1;
  const ref = useRef<TabSelectRenderable | null>(null);

  // `<tab-select>` only accepts its selected tab as an imperative
  // `setSelectedIndex` call (`TabSelectRenderable`), not a constructor/JSX
  // option — so `activeId` is applied via a ref effect rather than a prop.
  useEffect(() => {
    if (selectedIndex >= 0) ref.current?.setSelectedIndex(selectedIndex);
    // `tabs.length` is included alongside `selectedIndex`: when the tab
    // list itself changes (a tab added/removed) but `selectedIndex`
    // happens to come out the same number, this effect would otherwise
    // skip re-applying it — even though `<tab-select>`'s own options just
    // changed underneath the same numeric index — leaving the wrong tab
    // visually selected.
  }, [selectedIndex, tabs.length]);

  return (
    <tab-select
      ref={ref}
      options={options}
      focused={props.focused}
      backgroundColor={toColorInput(theme.colors["tab.inactiveBackground"])}
      textColor={toColorInput(theme.colors["tab.inactiveForeground"])}
      selectedBackgroundColor={toColorInput(theme.colors["tab.activeBackground"])}
      selectedTextColor={toColorInput(theme.colors["tab.activeForeground"])}
      onSelect={(_index, option) => {
        if (option && typeof option.value === "string") props.onSelect?.(option.value);
      }}
    />
  );
}
