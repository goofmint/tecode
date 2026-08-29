/**
 * `TerminalGridView` (Issue #98 Phase 4): the real `tecode.ui.Terminal`
 * component — owns a `VtEmulator` (`../terminal/vtEmulator.ts`, Issue #98
 * Phases 1-2, unmodified), feeds it a `PtySession`'s `onData` bytes, and
 * renders its cell grid using `editorView.tsx`'s own row-run rendering
 * pattern (one `<box row>` per grid row, one `<text>` per RUN of
 * same-attribute cells, never one node per cell).
 *
 * **Why this lives in `@tecode/core`, not `packages/builtin/terminal`**
 * (the terminal built-in, Phase 4's OTHER half): `createVtEmulator`
 * depends on `@xterm/headless` (a `packages/core`-only dependency, Phase
 * 5) and on `../terminal/ansiPalette.ts`/`./colorQuantize.ts` — none of
 * which `packages/builtin` may ever import (the ESLint layering rule
 * blocks `@tecode/core` entirely from `packages/builtin`). This mirrors
 * the EXACT precedent `tecode.ui.Tree`/`List`/`Input`/`Tabs` already set
 * (`api/create.ts`'s `uiNamespace`): the real, renderer-coupled
 * implementation lives here, and `@tecode/api`'s `UiNamespace.Terminal`
 * exposes it as a plain, React-free `ComponentType` a built-in bridges
 * into JSX exactly like `explorer/ExplorerView.tsx` bridges `Tree` — see
 * that file's own TSDoc for the cast pattern this repeats. The terminal
 * built-in still owns the `PtySession` itself (spawned via the public
 * `ctx.api.terminal.spawn`, Issue #98 Phases 1-2) and hands it to this
 * component as a prop; this component never spawns a process itself.
 *
 * **Sizing the pty AND the emulator together** (Issue #98's own
 * requirement): `props.cols`/`props.rows` — ultimately `Panel`'s own
 * `viewProps` (`shell.tsx`'s `Panel` TSDoc), reflecting the panel's real
 * content area — drive BOTH `session.resize(cols, rows)` and this
 * component's own `emulator.resize(cols, rows)` from the SAME effect,
 * every time either changes, so the two can never drift out of sync with
 * each other or with what is actually drawn.
 *
 * **`terminalFocus`** (Req 4.6, Issue #98): this component's own outer box
 * carries `useFocusTracking("terminalFocus")` directly — hardcoded, not a
 * prop, matching `EditorArea`'s own hardcoded `"editorFocus"` (there is
 * exactly one caller of this component, the terminal built-in's single
 * panel tab, so there is nothing to parameterize).
 *
 * **Grabbing real focus is imperative, in a `useEffect`, NOT the
 * declarative `focused` prop** — `findWidget.tsx`'s own TSDoc documents
 * exactly why in detail: `@opentui/react`'s declarative `focused={true}`
 * prop is applied during `setInitialProperties`, at INSTANCE-CREATION
 * time, strictly BEFORE React has attached this component's own `ref`
 * callback (refs attach during commit, after the host node exists) — a
 * `focused={true}` prop on first render would call `instance.focus()`
 * before `useFocusTracking`'s `FOCUSED` listener is even registered on
 * that instance, silently missing the event `"terminalFocus"` depends on
 * (the underlying node WOULD be really focused — but the context key
 * `keyRouting.ts` gates all of its terminal-forwarding on would stay
 * `false` forever). {@link TerminalGridViewProps.autoFocus} therefore
 * drives a `useEffect`-timed `rootNodeRef.current?.focus()` instead —
 * strictly after every ref in the tree has attached, exactly
 * `findWidget.tsx`'s own "Ctrl+F opens focused" mechanism. {@link
 * TerminalGridViewProps.onFocusHandleChange} publishes that SAME
 * imperative handle upward (mirrors `shell.tsx`'s `EditorArea`'s own
 * `onEditorFocusHandleChange`, Issue #98 Phase 3) for the terminal
 * built-in's `terminal.focus` command to call directly when the panel is
 * ALREADY visible/mounted but not currently focused (Escape was pressed
 * earlier) — `autoFocus` alone only fires once, on mount.
 */

import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import type { RGBA } from "@opentui/core";
import type { PtySession, RGB } from "@tecode/api";
import type { HostLog } from "../host/errors";
import { createVtEmulator, type TerminalCell, type TerminalCellColor, type VtEmulator } from "../terminal/vtEmulator";
import type { FocusableNode, FocusEmitter } from "./focus";
import { useFocusTracking } from "./focus";
import { toColorInput, useTheme } from "./theme";

/** One rendered run of consecutive same-colored cells on one terminal row
 * — the unit {@link buildTerminalRowRuns} produces and `TerminalGridView`
 * renders as one `<text>` node (this module's TSDoc's "never one node per
 * cell"). */
export interface TerminalRowRun {
  text: string;
  foreground: TerminalCellColor;
  background: TerminalCellColor;
}

/** Structural equality for two {@link TerminalCellColor} values — used by
 * {@link buildTerminalRowRuns} to decide whether two adjacent cells belong
 * to the same run. Compares by VALUE, not by reference (the emulator's own
 * `getCell` reuses a scratch cell — `vtEmulator.ts`'s TSDoc — so a fresh
 * `TerminalCellColor` object is built per call and reference equality
 * would never merge anything). */
function terminalColorsEqual(a: TerminalCellColor, b: TerminalCellColor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "default") return true;
  if (a.kind === "rgb" && b.kind === "rgb") {
    return a.rgb.r === b.rgb.r && a.rgb.g === b.rgb.g && a.rgb.b === b.rgb.b;
  }
  if (a.kind === "palette" && b.kind === "palette") {
    return a.index === b.index;
  }
  return false;
}

/**
 * Build one terminal row's render runs (this module's TSDoc) — walks
 * `x` from `0` to `cols - 1` via `getCell(x, y)`, skipping width-`0`
 * continuation cells entirely (`TerminalCell.width`'s own documented
 * contract) and merging consecutive cells whose foreground AND background
 * both match ({@link terminalColorsEqual}) into one run.
 *
 * **`cell.chars || " "`, deliberately `||` and not `??`** (this issue's
 * own flagged landmine): an on-screen but otherwise empty cell's `chars`
 * is `""` (falsy, but NOT `nullish`) — `?? " "` would silently pass `""`
 * straight through (nullish coalescing only replaces `null`/`undefined`),
 * collapsing every blank cell in a run to nothing and shifting every
 * character after it left by one column. A cell missing entirely
 * (`getCell` returned `undefined` — out of bounds, or the emulator has no
 * grid yet) also renders as a single space, via the same fallback,
 * treated as an ordinary default-colored blank rather than a special case.
 *
 * Pure and `@opentui/react`-free — takes a plain `getCell` function rather
 * than a `VtEmulator` instance so a test can supply a hand-built grid with
 * no real `@xterm/headless` `Terminal` involved at all.
 */
export function buildTerminalRowRuns(
  getCell: (x: number, y: number) => TerminalCell | undefined,
  y: number,
  cols: number,
): TerminalRowRun[] {
  const runs: TerminalRowRun[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = getCell(x, y);
    if (cell && cell.width === 0) continue; // Continuation of a wide character — already drawn.

    const text = cell?.chars || " ";
    const foreground: TerminalCellColor = cell?.foreground ?? { kind: "default" };
    const background: TerminalCellColor = cell?.background ?? { kind: "default" };

    const last = runs[runs.length - 1];
    if (last && terminalColorsEqual(last.foreground, foreground) && terminalColorsEqual(last.background, background)) {
      last.text += text;
    } else {
      runs.push({ text, foreground, background });
    }
  }
  return runs;
}

/** Resolve one cell color to the `RGBA` `<text fg>`/`<text bg>` OpenTUI
 * props accept — `"default"` falls back to `fallback` (this component's
 * own theme-derived default, since this codebase has no dedicated
 * `terminal.foreground`/`terminal.background` theme tokens yet — Issue
 * #98's MVP scope reuses `editor.foreground`/`panel.background`, the
 * panel this view always renders inside). */
function resolveRunColor(color: TerminalCellColor, fallback: RGB): RGBA {
  if (color.kind === "default") return toColorInput(fallback);
  return toColorInput(color.rgb);
}

/** Dependencies/props for {@link TerminalGridView}. */
export interface TerminalGridViewProps {
  /** The live pty session driving this view — `undefined` before one has
   * spawned, or after it has exited (Issue #98's terminal built-in owns
   * spawning/disposal via the public `ctx.api.terminal.spawn`; this
   * component only reads `onData`/calls `resize`). While `undefined`, the
   * emulator still renders (typically its initial blank grid) — there is
   * simply nothing feeding it new bytes and no pty to resize. */
  session: Pick<PtySession, "onData" | "resize"> | undefined;
  /** Column count to size the emulator AND (via `session.resize`) the pty
   * to — clamped to at least 1 (a 0-sized grid is meaningless and
   * `@xterm/headless` itself does not accept it). */
  cols: number;
  /** Row count — see {@link cols}. */
  rows: number;
  /** Structured log threaded to the internal `VtEmulator` (design.md
   * §14). Optional — omitted swallows write/dispose failures silently,
   * exactly like `VtEmulator` itself. */
  log?: HostLog;
  /** Imperatively focus this view's root box exactly once, on mount (this
   * module's TSDoc's "Grabbing real focus is imperative" — NOT
   * `@opentui/react`'s declarative `focused` prop, which would silently
   * fail to set `"terminalFocus"`). Defaults to `false`: a caller/test
   * that omits it renders unfocused, matching every other optional prop
   * in this module. */
  autoFocus?: boolean;
  /** Receives a stable `() => void` handle for re-focusing this view's
   * root box from outside React (this module's TSDoc) — called once, with
   * a function whose identity never changes across this component's
   * lifetime, mirroring `shell.tsx`'s `EditorArea.onEditorFocusHandleChange`
   * exactly. Optional: a caller/test that omits it simply never receives
   * the handle. */
  onFocusHandleChange?: (focus: () => void) => void;
}

/**
 * {@link TerminalGridView}'s implementation (this module's TSDoc). Takes
 * `rawProps: Record<string, unknown>`, not {@link TerminalGridViewProps}
 * directly, and casts internally — matches `components.tsx`'s `List`/
 * `Tree`/`Input`/`Tabs`, all of which do the same: `@tecode/api`'s
 * `ComponentType<P = Record<string, unknown>>` is the type `tecode.ui`'s
 * fields are actually held as, and a function declared to take a MORE
 * SPECIFIC parameter type is not assignable to one declared to take that
 * default (parameters are checked contravariantly) — this is what lets
 * `create.ts`'s `uiNamespace.Terminal: TerminalGridView` type-check at
 * all.
 */
export function TerminalGridView(rawProps: Record<string, unknown>): ReactNode {
  const props = rawProps as unknown as TerminalGridViewProps;
  const theme = useTheme();
  const cols = Math.max(1, props.cols);
  const rows = Math.max(1, props.rows);

  // Combined ref (matches `editorView.tsx`'s `textPlaneRef`'s own
  // combining pattern): `useFocusTracking`'s own ref reports FOCUSED/
  // BLURRED into `"terminalFocus"`; `rootNodeRef` additionally captures
  // the node itself so `autoFocus`/`onFocusHandleChange` below can call
  // `.focus()` on it imperatively.
  const contextFocusRef = useFocusTracking("terminalFocus");
  const rootNodeRef = useRef<FocusableNode | null>(null);
  const rootRef = useCallback(
    (node: FocusEmitter | null) => {
      contextFocusRef(node);
      rootNodeRef.current = node as FocusableNode | null;
    },
    [contextFocusRef],
  );

  // `autoFocus` (this module's TSDoc's "Grabbing real focus is
  // imperative"): fires once, strictly after this component's own ref has
  // attached — deliberately NOT re-run on every `autoFocus` value change
  // (empty deps), matching `findWidget.tsx`'s own "opens focused" mount
  // effect exactly, so remounting (Panel fully unmounts its hidden tab —
  // `shell.tsx`'s `Panel` TSDoc) is what re-triggers this, not a prop
  // flip on an already-mounted instance.
  const autoFocus = props.autoFocus ?? false;
  useEffect(() => {
    if (autoFocus) rootNodeRef.current?.focus();
  }, []);

  // Publishes the re-focus handle (this module's TSDoc) — stable identity
  // (empty deps, mirrors `shell.tsx`'s `EditorArea`'s own
  // `focusEditorText`) so `props.onFocusHandleChange` is called exactly
  // once for this component's whole lifetime.
  const focusThisView = useCallback(() => {
    rootNodeRef.current?.focus();
  }, []);
  useEffect(() => {
    props.onFocusHandleChange?.(focusThisView);
  }, [props.onFocusHandleChange, focusThisView]);

  // Lazy, ref-based construction (not `useState(() => ...)`): a
  // `useState` lazy initializer can run more than once under React
  // Strict Mode with the surplus silently discarded — this codebase never
  // enables Strict Mode (`grep -r StrictMode packages/` is empty), but a
  // ref makes "constructed exactly once, for this component instance's
  // whole lifetime" true unconditionally rather than by omission, and
  // matches `editorView.tsx`'s/`shell.tsx`'s own `useRef`-for-imperative-
  // singleton convention.
  const emulatorRef = useRef<VtEmulator | null>(null);
  if (!emulatorRef.current) {
    emulatorRef.current = createVtEmulator({ cols, rows, log: props.log });
  }
  const emulator = emulatorRef.current;

  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = emulator.onDidChange(() => forceRender());
    // Closes the subscribe-after-render race (`shell.tsx`'s `useSlotViews`
    // TSDoc's own precedent) — a write landing between this component's
    // first render and this effect subscribing would otherwise be missed
    // until some later, unrelated re-render.
    forceRender();
    return () => sub.dispose();
  }, [emulator]);

  // Tear down the `@xterm/headless` `Terminal` this component owns on
  // unmount (Panel fully unmounts its active tab's component while
  // hidden — `shell.tsx`'s `Panel`'s own `if (!props.visible) return
  // null` — so this fires every time the panel is hidden, not just on a
  // genuine app-level teardown; a fresh `VtEmulator` is built again the
  // next time the panel becomes visible, matching `ExplorerView`'s own
  // "re-fetch on remount" shape for its own external store).
  useEffect(() => () => emulator.dispose(), [emulator]);

  // Feed the pty's raw output bytes into the emulator (Issue #98's core
  // pipeline: "Bun.Terminal (pty) --bytes--> @xterm/headless (VT) -->
  // Panel view"). Re-subscribes if `props.session` itself changes
  // identity (a new session replacing an exited one) — the common case
  // (one session for this component's whole lifetime) re-runs this effect
  // exactly once, on mount.
  useEffect(() => {
    if (!props.session) return undefined;
    const session = props.session;
    const sub = session.onData((bytes) => {
      void emulator.write(bytes);
    });
    return () => sub.dispose();
  }, [props.session, emulator]);

  // Resize BOTH the pty and the emulator together, every time either
  // dimension changes (this module's TSDoc's "Sizing the pty AND the
  // emulator together") — the two are independent seams
  // (`vtEmulator.ts`'s TSDoc) that this is the one place responsible for
  // keeping in lockstep.
  useEffect(() => {
    emulator.resize(cols, rows);
    props.session?.resize(cols, rows);
  }, [cols, rows, emulator, props.session]);

  const defaultForeground = theme.colors["editor.foreground"];
  const defaultBackground = theme.colors["panel.background"];

  const rowNodes: ReactNode[] = [];
  for (let y = 0; y < rows; y++) {
    const runs = buildTerminalRowRuns((x, yy) => emulator.getCell(x, yy), y, cols);
    rowNodes.push(
      <box key={y} style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
        {runs.map((run, index) => (
          // Index as key is safe here — `runs` is rebuilt from scratch on
          // every render, with no cross-render identity to preserve
          // (matches `editorView.tsx`'s `EditorLineRow`'s own run-key
          // reasoning).
          <text
            key={index}
            fg={resolveRunColor(run.foreground, defaultForeground)}
            bg={resolveRunColor(run.background, defaultBackground)}
          >
            {run.text}
          </text>
        ))}
      </box>,
    );
  }

  return (
    <box
      ref={rootRef}
      focusable
      style={{ flexDirection: "column", flexGrow: 1 }}
      backgroundColor={toColorInput(defaultBackground)}
    >
      {rowNodes}
    </box>
  );
}
