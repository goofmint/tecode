/**
 * `FindFileWidget` — the find-file minibuffer (Issue #164): a path input
 * pinned to the BOTTOM of the editor area, Emacs' `find-file` prompt rather
 * than a centred modal. Rendered by `shell.tsx`'s `EditorArea` as a
 * fixed-height sibling of `EditorView` (below it, where `FindWidget` sits
 * above), ONLY while `findFileService.getState().isOpen` is true — a
 * conditionally-MOUNTED sibling, not a hidden one, which is what makes the
 * "opens focused" effect below a plain mount effect.
 *
 * **Stateless** (`findWidget.tsx`'s own shape): the typed path lives in
 * `findFileService.ts`'s single global {@link FindFileState}, never in
 * local component state — every keystroke goes straight to
 * `findFileService.setQuery`, and every other action (accept, close,
 * complete) is driven by `findFileCommand.ts`'s keybindings calling the
 * service directly, never by a handler in here.
 *
 * **Layout — three stacked regions, all fixed-height**
 * ({@link findFileWidgetHeight}): the prompt row (label + `Input`), one
 * status row naming the resolved directory a Tab would list (Issue #164's
 * "入力中は「今どのディレクトリを見ているか」が分かる表示にする" — it is
 * the `~`-expanded, `..`-resolved directory, not the raw text), and the
 * candidate rows a completion that could not extend the query produced.
 * `EditorArea` feeds the EXACT same {@link findFileWidgetHeight} into
 * `viewport.ts`'s `EditorAreaChrome.findFileWidget`, so the rows this
 * component draws and the rows subtracted from `EditorView`'s
 * `viewportHeight` can never drift apart.
 *
 * **Candidate rows are plain `<text>`, not `components.tsx`'s `List`**: the
 * candidate list is informational (Emacs' `*Completions*` buffer) — there
 * is no selection to move and nothing to activate, whereas `List` renders
 * an OpenTUI `<select>`, whose whole contract is a focusable, selected-index
 * widget. Using `<select>` here would introduce a second focusable node
 * inside a minibuffer whose single `Input` must keep the focus pointer for
 * {@link FIND_FILE_FOCUS_CONTEXT_KEY} (and therefore for `tab`/`return`/
 * `escape`) to stay live.
 *
 * **"Opens focused"**: an imperative `.focus()` in a mount `useEffect`, NOT
 * `@opentui/react`'s declarative `focused` prop — `findWidget.tsx`'s TSDoc
 * documents the ordering bug that makes the declarative form silently miss
 * the `FOCUSED` event `useFocusTracking` depends on, and the same reasoning
 * applies verbatim here. Returning focus to the text plane on CLOSE is
 * `EditorArea`'s job for the same reason it already is for `FindWidget`:
 * by then this component has unmounted.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Input } from "./components";
import { FIND_FILE_FOCUS_CONTEXT_KEY } from "./findFileCommand";
import type { FindFileService, FindFileState } from "./findFileService";
import type { FocusableNode } from "./focus";
import { useFocusTracking } from "./focus";
import { toColorInput, useTheme } from "./theme";

/** Rows the prompt row (label + `Input`) occupies. */
const PROMPT_ROWS = 1;

/** Rows the "which directory am I in" status row occupies. */
const STATUS_ROWS = 1;

/** The most candidate rows the widget ever draws at once, however many
 * candidates the state holds — a cap on how much of the editor the
 * minibuffer may eat (`findFileService.ts`'s own
 * `FIND_FILE_MAX_CANDIDATES` separately caps how many are STORED). */
export const FIND_FILE_MAX_CANDIDATE_ROWS = 8;

/** How many candidate rows {@link FindFileWidget} draws for `state` (this
 * module's TSDoc's "Layout") — pure, so `EditorArea`'s chrome math can call
 * it without rendering anything. */
export function findFileCandidateRows(state: FindFileState): number {
  return Math.min(state.candidates.length, FIND_FILE_MAX_CANDIDATE_ROWS);
}

/** Total rows {@link FindFileWidget} occupies for `state` — the single
 * number both this component's own outer `height` and
 * `EditorAreaChrome.findFileWidget` are derived from (this module's TSDoc's
 * "Layout"). */
export function findFileWidgetHeight(state: FindFileState): number {
  return PROMPT_ROWS + STATUS_ROWS + findFileCandidateRows(state);
}

/** {@link FindFileWidget}'s props. */
export interface FindFileWidgetProps {
  /** The service's live state — always `isOpen: true` by the time
   * `EditorArea` mounts this component (this module's TSDoc). */
  state: FindFileState;
  /** The ONE action this widget drives directly (this module's TSDoc's
   * "Stateless") — narrowed to a `Pick`, matching `FindWidgetProps`'
   * own narrowing, so a test can inject a minimal fake. */
  findFileService: Pick<FindFileService, "setQuery">;
}

/** The status row's text: the resolved directory, plus how many candidates
 * were dropped by the store's cap or by this widget's row cap. */
function statusText(state: FindFileState): string {
  const hidden = Math.max(0, state.candidates.length - findFileCandidateRows(state)) + state.truncatedCount;
  if (hidden > 0) return `${state.dirPath}  (+${hidden} more)`;
  return state.dirPath;
}

/** The find-file minibuffer (Issue #164; this module's TSDoc). */
export function FindFileWidget(props: FindFileWidgetProps): ReactNode {
  const { state, findFileService } = props;
  const theme = useTheme();
  const focusRef = useFocusTracking(FIND_FILE_FOCUS_CONTEXT_KEY);
  // The input's own node, captured ALONGSIDE (not instead of) `focusRef`
  // — purely so the mount effect below has something to `.focus()`
  // (`findWidget.tsx`'s identical `queryInputRef`/`queryNodeRef` pair).
  const nodeRef = useRef<FocusableNode | null>(null);
  const inputRef = useCallback(
    (node: FocusableNode | null) => {
      focusRef(node);
      nodeRef.current = node;
    },
    [focusRef],
  );
  useEffect(() => {
    // Runs once, after every ref in this render has attached — the widget
    // only ever mounts already-open, so a plain mount effect IS "focus on
    // open" (this module's TSDoc's "Opens focused").
    nodeRef.current?.focus();
  }, []);

  const visibleCandidates = state.candidates.slice(0, findFileCandidateRows(state));

  return (
    <box
      style={{ flexDirection: "column", height: findFileWidgetHeight(state), flexShrink: 0 }}
      backgroundColor={toColorInput(theme.colors["input.background"])}
    >
      <box style={{ flexDirection: "row", height: PROMPT_ROWS, flexShrink: 0 }}>
        <text fg={toColorInput(theme.colors["input.placeholderForeground"])}>{"Find file: "}</text>
        <box style={{ flexGrow: 1 }}>
          <Input value={state.query} placeholder="path" onChange={findFileService.setQuery} inputRef={inputRef} />
        </box>
      </box>
      <box style={{ flexDirection: "row", height: STATUS_ROWS, flexShrink: 0 }}>
        <text fg={toColorInput(theme.colors["input.placeholderForeground"])}>{statusText(state)}</text>
      </box>
      {visibleCandidates.map((candidate) => (
        <box key={candidate} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={toColorInput(theme.colors["input.foreground"])}>{candidate}</text>
        </box>
      ))}
    </box>
  );
}
