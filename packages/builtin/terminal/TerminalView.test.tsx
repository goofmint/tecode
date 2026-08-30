/**
 * Tests for {@link TerminalView}/{@link createTerminalViewComponent} (Issue
 * #98 Phase 4) — a fake `tecode.ui.Terminal` stands in for `@tecode/core`'s
 * real `TerminalGridView` (this built-in has no compile-time or runtime
 * dependency on it), proving the PROP WIRING (`session`/`cols`/`rows`/
 * `onFocusHandleChange`) and the `store.ensureSession()`/
 * `onDidChange` lifecycle, rather than `tecode.ui.Terminal`'s own
 * rendering (already covered by `@tecode/core`'s `terminalGridView.test.tsx`)
 * — matches `explorer/ExplorerView.test.tsx`'s own "fake the injected
 * component" convention exactly.
 *
 * **No unconditional `autoFocus` (Issue #113)**: `TerminalView` used to pass
 * a hardcoded `autoFocus` prop on every mount, which meant a startup
 * restore of `layoutState.panelVisible` (`~/.config/tecode/state.json`)
 * silently stole OpenTUI focus into the terminal panel — every keystroke
 * (including Ctrl+C) then went to the child shell/pty instead of the
 * editor, with no `terminal.focus`/`terminal.new` command ever having run.
 * `store.ts`'s `requestFocus`/`registerFocusHandle` pending-focus mechanism
 * already covers the legitimate case (`terminal.focus`/`terminal.new`
 * calling `store.requestFocus()` before or after the view mounts) without
 * that prop, so it was simply removed — see "does NOT auto-focus on a
 * plain mount" and "DOES focus when a requestFocus() was already pending"
 * below for the two directions this must keep holding.
 */

import { describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { Disposable, PtySpawnOptions, Tecode } from "@tecode/api";
import { createTerminalStore } from "./store";
import { createTerminalViewComponent, TerminalView } from "./TerminalView";

/** A minimal fake `tecode.ui.Terminal` — captures the last props it was
 * rendered with. */
function createFakeTerminalComponent(): {
  Terminal: Tecode["ui"]["Terminal"];
  lastProps: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const Terminal = ((rawProps: Record<string, unknown>) => {
    captured = rawProps;
    return <text>{"terminal"}</text> as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Terminal"];
  return { Terminal, lastProps: () => captured };
}

function createStoreWithFakeSpawn(): { store: ReturnType<typeof createTerminalStore>; spawnCalls: PtySpawnOptions[] } {
  const spawnCalls: PtySpawnOptions[] = [];
  const store = createTerminalStore({
    spawn: (options) => {
      spawnCalls.push(options);
      return {
        write() {},
        resize() {},
        onData: () => ({ dispose() {} }) as Disposable,
        onExit: () => ({ dispose() {} }) as Disposable,
        dispose() {},
      };
    },
    cmd: ["/bin/sh"],
    initialCols: 80,
    initialRows: 24,
  });
  return { store, spawnCalls };
}

describe("TerminalView (Issue #98 Phase 4)", () => {
  test("spawns a session lazily on mount and passes it, plus cols/rows, to tecode.ui.Terminal", async () => {
    const { store, spawnCalls } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    const { renderOnce } = await testRender(
      <TerminalView store={store} Terminal={Terminal} height={10} width={40} />,
      { width: 40, height: 10 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(spawnCalls).toHaveLength(1);
    expect(lastProps()?.["session"]).toBe(store.getSession());
    expect(lastProps()?.["cols"]).toBe(40);
    expect(lastProps()?.["rows"]).toBe(10);
    expect(typeof lastProps()?.["onFocusHandleChange"]).toBe("function");
  });

  test("Issue #113: does NOT pass autoFocus on a plain mount — a startup restore of panelVisible must not steal OpenTUI focus into the terminal", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    // No `store.requestFocus()` anywhere in this test — this is exactly
    // the "Panel restored `panelVisible: true` from `state.json` and
    // mounted this view on its own, with no `terminal.focus`/`terminal.
    // new` command ever having run" scenario Issue #113 reported.
    const { renderOnce } = await testRender(<TerminalView store={store} Terminal={Terminal} />, {
      width: 10,
      height: 5,
    });
    await act(async () => {
      await renderOnce();
    });

    // The removed prop must actually be absent, not merely falsy-by-luck:
    // `undefined` is the only value a bare "the prop was never included in
    // the JSX" produces (`lastProps()` captures the literal object handed
    // to the fake component).
    expect(lastProps()?.["autoFocus"]).toBeUndefined();

    // The stronger claim this bug is actually about: the focus handle this
    // mount published is never itself invoked without an outstanding
    // `requestFocus()`. `registerFocusHandle`'s own "consume pending
    // immediately" branch (`store.ts`) is the only thing that could call
    // it at mount time, and there is no pending request here.
    const handle = lastProps()?.["onFocusHandleChange"] as (focus: () => void) => void;
    let focusInvocations = 0;
    act(() => {
      handle(() => focusInvocations++);
    });
    expect(focusInvocations).toBe(0);
  });

  test("Issue #113: DOES focus on mount when requestFocus() was already pending — the terminal.focus/terminal.new command path must keep working", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    // Mirrors `index.ts`'s `terminal.focus` handler calling `store.
    // requestFocus()` BEFORE `Panel` has mounted `TerminalView` at all
    // (`store.ts`'s own "remembered as PENDING... consumed the next time
    // registerFocusHandle runs" TSDoc) — no live handle exists yet, so
    // this sets `focusPending` rather than calling anything synchronously.
    store.requestFocus();

    const { renderOnce } = await testRender(<TerminalView store={store} Terminal={Terminal} />, {
      width: 10,
      height: 5,
    });
    await act(async () => {
      await renderOnce();
    });

    // `TerminalView`'s mount effect hands its stable `handleFocusHandleChange`
    // callback to the fake component via `onFocusHandleChange`; the fake
    // component (matching the real `TerminalGridView`) calls it once with
    // its own imperative focus function, which reaches `store.
    // registerFocusHandle` — and THAT must consume the still-pending
    // request immediately, exactly as `store.ts`'s TSDoc promises.
    const handle = lastProps()?.["onFocusHandleChange"] as (focus: () => void) => void;
    let focusInvocations = 0;
    act(() => {
      handle(() => focusInvocations++);
    });
    expect(focusInvocations).toBe(1);
  });

  test("falls back to the default 80x24 when height/width are omitted", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    const { renderOnce } = await testRender(<TerminalView store={store} Terminal={Terminal} />, {
      width: 40,
      height: 10,
    });
    await act(async () => {
      await renderOnce();
    });

    expect(lastProps()?.["cols"]).toBe(80);
    expect(lastProps()?.["rows"]).toBe(24);
  });

  test("cols/rows are clamped to at least 1 even if given 0", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    const { renderOnce } = await testRender(
      <TerminalView store={store} Terminal={Terminal} height={0} width={0} />,
      { width: 10, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(lastProps()?.["cols"]).toBe(1);
    expect(lastProps()?.["rows"]).toBe(1);
  });

  test("the published onFocusHandleChange handle registers with the store", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    const { renderOnce } = await testRender(<TerminalView store={store} Terminal={Terminal} />, {
      width: 10,
      height: 5,
    });
    await act(async () => {
      await renderOnce();
    });

    const handle = lastProps()?.["onFocusHandleChange"] as (focus: () => void) => void;
    let focused = 0;
    act(() => {
      handle(() => focused++);
    });
    store.requestFocus();
    expect(focused).toBe(1);
  });

  test("unmount clears the published focus handle: a stale handle is never invoked by a later requestFocus(), which is instead remembered as pending for the next mount's handle", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    // `testRender` (`@opentui/react/test-utils`) has no `unmount` — so a
    // small wrapper conditionally mounts/unmounts `TerminalView` based on
    // `show`, and the test flips `show` from outside by capturing `set`
    // into a closure variable (this file's own "capture a closure
    // variable" convention, e.g. `createFakeTerminalComponent`'s
    // `captured`) rather than exposing it as a prop.
    let setShow: (show: boolean) => void = () => {
      throw new Error("setShow was never captured — Wrapper did not render");
    };
    function Wrapper(): ReactNode {
      const [show, set] = useState(true);
      setShow = set;
      return show
        ? (<TerminalView store={store} Terminal={Terminal} /> as ReactNode)
        : (<text>{"unmounted"}</text> as unknown as ReactNode);
    }

    const { renderOnce } = await testRender(<Wrapper />, { width: 10, height: 5 });
    await act(async () => {
      await renderOnce();
    });

    const handle = lastProps()?.["onFocusHandleChange"] as (focus: () => void) => void;
    let focused = 0;
    act(() => {
      handle(() => focused++);
    });
    store.requestFocus();
    expect(focused).toBe(1);

    // Unmount `TerminalView` — its cleanup effect (`TerminalView.tsx`'s
    // `return () => store.registerFocusHandle(undefined);`) must run.
    act(() => {
      setShow(false);
    });
    await act(async () => {
      await renderOnce();
    });

    // The stale handle must NOT fire: the store no longer holds it, so
    // `requestFocus()` falls back to `store.ts`'s "pending" path instead
    // of invoking a handle whose underlying node already detached.
    store.requestFocus();
    expect(focused).toBe(1);

    // ...and that pending request is consumed the moment a fresh handle
    // registers (`store.ts`'s `registerFocusHandle`: "Consumes a pending
    // requestFocus call immediately if one is outstanding"), proving the
    // request was remembered rather than silently dropped.
    let refocused = 0;
    store.registerFocusHandle(() => refocused++);
    expect(refocused).toBe(1);
  });

  test("store.onDidChange (a respawn) forces a re-render with the new session", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();

    const { renderOnce } = await testRender(<TerminalView store={store} Terminal={Terminal} />, {
      width: 10,
      height: 5,
    });
    await act(async () => {
      await renderOnce();
    });
    const firstSession = lastProps()?.["session"];

    await act(async () => {
      store.respawn();
      await renderOnce();
    });

    expect(lastProps()?.["session"]).not.toBe(firstSession);
    expect(lastProps()?.["session"]).toBe(store.getSession());
  });
});

describe("createTerminalViewComponent (Issue #98 Phase 4)", () => {
  test("forwards Panel's viewProps (height/width) through to TerminalView", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();
    const Component = createTerminalViewComponent({ store, Terminal });

    const { renderOnce } = await testRender(
      // `Component` is a plain `ComponentType` — cast to JSX the same way
      // `RegisteredView` (`@tecode/core`'s `components.tsx`) does at its
      // own call site.
      (Component as unknown as (p: Record<string, unknown>) => ReactNode)({ height: 12, width: 50 }),
      { width: 50, height: 12 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(lastProps()?.["cols"]).toBe(50);
    expect(lastProps()?.["rows"]).toBe(12);
  });

  test("non-number viewProps (or none at all) fall back to TerminalView's own defaults", async () => {
    const { store } = createStoreWithFakeSpawn();
    const { Terminal, lastProps } = createFakeTerminalComponent();
    const Component = createTerminalViewComponent({ store, Terminal });

    const { renderOnce } = await testRender(
      (Component as unknown as (p: Record<string, unknown>) => ReactNode)({}),
      { width: 10, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(lastProps()?.["cols"]).toBe(80);
    expect(lastProps()?.["rows"]).toBe(24);
  });
});
