/**
 * `FindWidget` — the inline find/replace overlay `editor-core`'s in-buffer
 * find/replace lives behind (Req 11.1, design.md §13). Rendered by
 * `shell.tsx`'s `EditorArea` as a fixed-height sibling of `EditorView`,
 * ONLY while the active tab's `EditorState.find?.isOpen` is true (a
 * conditionally-MOUNTED sibling, not a hidden one — this module's TSDoc's
 * "opens focused" below relies on that).
 *
 * **Query input + replace input, reusing `components.tsx`'s `Input`**
 * (design.md §13): every keystroke typed into either box goes straight to
 * `findService.setQuery`/`setReplaceQuery` — this component holds no local
 * text state of its own, matching `editor-core`'s "pure command handlers"
 * architecture (this module never talks to `findService` about anything
 * OTHER than what the user just typed/clicked; all matching/navigation
 * logic lives in `ui/findService.ts`).
 *
 * **"Ctrl+F opens focused"** — a `useEffect`-driven, imperative `.focus()`
 * call on mount, NOT `@opentui/react`'s declarative `focused` prop, and the
 * ordering is why: that prop-diffing runs inside `setInitialProperties` at
 * INSTANCE-CREATION time — before React has attached this component's own
 * `ref` callback (refs attach during commit, strictly after the host node
 * exists) — so a `focused={true}` prop on the very first render calls
 * `instance.focus()` before `useFocusTracking`'s `FOCUSED` listener is
 * even registered on that instance, silently missing the event the
 * `findWidgetFocus` context key depends on (and `Renderable.focus()`
 * itself no-ops if the node is already focused, so a LATER manual
 * `.focus()` call wouldn't re-fire it either). A `useEffect` runs strictly
 * after every ref in the tree has attached, so calling `.focus()` there —
 * the query input's node is captured via {@link queryInputNodeRef} below,
 * on top of (not instead of) `useFocusTracking`'s own tracking ref — is
 * the first `.focus()` call this node ever sees, and fires the event
 * correctly to an already-listening `useFocusTracking`.
 *
 * **"Escape closes returning focus to the text"**: the OTHER half of that
 * requirement — moving focus back once find CLOSES — cannot be driven the
 * same declarative way, because by the time `find.isOpen` flips to
 * `false`, THIS component has already unmounted (see the "conditionally
 * mounted" note above) and has no node left to blur, let alone a node to
 * focus instead. `shell.tsx`'s `EditorArea` (which renders `EditorView`
 * and this widget as siblings, and therefore has both) owns that
 * edge-triggered imperative `.focus()` back onto `EditorView`'s text
 * plane — see its own TSDoc.
 *
 * **`findWidgetFocus` context key**: only the query input reports into
 * `useFocusTracking("findWidgetFocus")` — the SAME context key `editor-
 * core`'s `return`/`shift+return`/`escape` keybindings gate on
 * (`manifest.ts`). The replace input intentionally does NOT track a
 * separate context key: Tab (once a later task wires focus-cycling between
 * the two inputs) moves OpenTUI's own single-focus pointer between them,
 * but both inputs being part of the SAME find widget is what `when:
 * "findWidgetFocus"` is meant to mean here — a real per-input distinction
 * (e.g. "is Enter in the replace box also findNext, or should it replace
 * instead") is a nuance left for a later task; every stroke in this
 * widget behaves identically regardless of which of its two inputs holds
 * the OpenTUI focus pointer, for now.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { FindState } from "./editorState";
import type { FindService } from "./findService";
import { Input } from "./components";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import { toColorInput, useTheme } from "./theme";

/** The find widget's public shape (this module's TSDoc). */
export interface FindWidgetProps {
  /** The active tab's find state — always defined and `isOpen: true` by
   * the time `shell.tsx`'s `EditorArea` mounts this component (this
   * module's TSDoc's "conditionally mounted"). */
  find: FindState;
  /** The 3 actions this widget actually drives directly — narrowed to a
   * `Pick` (matches every other `*ServiceDeps` narrowing in this codebase)
   * so a test can inject a minimal fake. Every other `FindService` method
   * (`open`/`close`/`next`/`previous`/`replaceCurrent`/`replaceAll`) is
   * driven entirely by `editor-core`'s keybindings (`ctrl+f`, `return`/
   * `shift+return`, `escape` — all gated `when: "findWidgetFocus"`) calling
   * straight through `ctx.api.editor.find.*`, NEVER by a click target or
   * `onSubmit` handler inside this component: since those keybindings
   * `preventDefault()` a consumed stroke before OpenTUI's own focused-
   * input key handling ever sees it (`keyRouting.ts`'s "consumed" branch),
   * wiring a redundant `onSubmit` here would be dead code that never
   * actually fires in practice. */
  findService: Pick<FindService, "setQuery" | "setReplaceQuery" | "toggleCaseSensitive">;
}

/** "current/total", "No results" (a non-empty query with zero matches), or
 * "" (an empty query — nothing to report yet) — Req 11.1's match count. */
function matchCountText(find: FindState): string {
  if (find.query.length === 0) return "";
  if (find.matches.length === 0) return "No results";
  return `${find.activeMatchIndex + 1}/${find.matches.length}`;
}

/** The inline find/replace widget (Req 11.1, design.md §13; this module's
 * TSDoc). */
export function FindWidget(props: FindWidgetProps): ReactNode {
  const { find, findService } = props;
  const theme = useTheme();
  // Only the query input tracks `findWidgetFocus` (this module's TSDoc).
  const queryFocusRef = useFocusTracking("findWidgetFocus");
  // The query input's own node, captured ALONGSIDE (not instead of)
  // `queryFocusRef` above (this module's TSDoc's "Ctrl+F opens focused") —
  // purely so the mount effect below has something to call `.focus()` on.
  const queryNodeRef = useRef<FocusableNode | null>(null);
  const queryInputRef = useCallback(
    (node: FocusableNode | null) => {
      queryFocusRef(node);
      queryNodeRef.current = node;
    },
    [queryFocusRef],
  );
  useEffect(() => {
    // Runs once, after every ref in this render has attached (this
    // module's TSDoc) — the widget only ever mounts already-open, so a
    // plain mount effect IS "focus on open", no `isOpen` transition to
    // watch for.
    queryNodeRef.current?.focus();
  }, []);

  return (
    <box
      style={{ flexDirection: "row", height: 1, flexShrink: 0 }}
      backgroundColor={toColorInput(theme.colors["input.background"])}
    >
      <box style={{ width: 24 }}>
        <Input value={find.query} placeholder="Find" onChange={findService.setQuery} inputRef={queryInputRef} />
      </box>
      <text
        fg={toColorInput(theme.colors["input.placeholderForeground"])}
        onMouseDown={() => findService.toggleCaseSensitive()}
      >
        {find.caseSensitive ? " [Aa] " : "  Aa  "}
      </text>
      <box style={{ width: 24 }}>
        <Input value={find.replaceQuery} placeholder="Replace" onChange={findService.setReplaceQuery} />
      </box>
      <text fg={toColorInput(theme.colors["input.placeholderForeground"])}>{` ${matchCountText(find)} `}</text>
    </box>
  );
}
