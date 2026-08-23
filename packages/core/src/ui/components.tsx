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

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SelectOption, TabSelectOption, TabSelectRenderable } from "@opentui/core";
import type { ComponentType } from "@tecode/api";
import type { FocusableNode } from "./focus";
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
}

/** {@link Tree}'s props. */
export interface TreeProps {
  nodes?: TreeNode[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Node ids expanded by default (uncontrolled after mount — this is a
   * minimal MVP component, not a fully controlled tree). */
  defaultExpanded?: string[];
}

/** A minimal expand/collapse tree (`tecode.ui.Tree`, Req 10.1). No native
 * OpenTUI tree renderable exists yet, so this composes `<box>`/`<text>`
 * directly with hand-rolled indentation and local expand/collapse state. */
export function Tree(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as TreeProps;
  const theme = useTheme();
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set<string>(props.defaultExpanded ?? []),
  );

  function toggle(id: string): void {
    setExpanded((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number): ReactNode {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isExpanded = expanded.has(node.id);
    const isSelected = props.selectedId === node.id;
    const glyph = hasChildren ? (isExpanded ? "▾ " : "▸ ") : "  ";
    return (
      <box key={node.id} style={{ flexDirection: "column" }}>
        <text
          fg={toColorInput(
            isSelected ? theme.colors["list.activeSelectionForeground"] : theme.colors["sideBar.foreground"],
          )}
          bg={isSelected ? toColorInput(theme.colors["list.activeSelectionBackground"]) : undefined}
          onMouseDown={() => {
            if (hasChildren) toggle(node.id);
            props.onSelect?.(node.id);
          }}
        >
          {"  ".repeat(depth) + glyph + node.label}
        </text>
        {hasChildren && isExpanded
          ? (node.children ?? []).map((child) => renderNode(child, depth + 1))
          : null}
      </box>
    );
  }

  return <box style={{ flexDirection: "column" }}>{(props.nodes ?? []).map((n) => renderNode(n, 0))}</box>;
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
 * TSDoc). */
export interface TabItem {
  id: string;
  label: string;
}

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
    name: tab.label,
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
