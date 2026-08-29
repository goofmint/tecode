/**
 * Tests for {@link TerminalView}/{@link createTerminalViewComponent} (Issue
 * #98 Phase 4) — a fake `tecode.ui.Terminal` stands in for `@tecode/core`'s
 * real `TerminalGridView` (this built-in has no compile-time or runtime
 * dependency on it), proving the PROP WIRING (`session`/`cols`/`rows`/
 * `autoFocus`/`onFocusHandleChange`) and the `store.ensureSession()`/
 * `onDidChange` lifecycle, rather than `tecode.ui.Terminal`'s own
 * rendering (already covered by `@tecode/core`'s `terminalGridView.test.tsx`)
 * — matches `explorer/ExplorerView.test.tsx`'s own "fake the injected
 * component" convention exactly.
 */

import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
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
  test("spawns a session lazily on mount and passes it, plus cols/rows/autoFocus, to tecode.ui.Terminal", async () => {
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
    expect(lastProps()?.["autoFocus"]).toBe(true);
    expect(typeof lastProps()?.["onFocusHandleChange"]).toBe("function");
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

  test("the published onFocusHandleChange handle registers with the store, and unmount clears it", async () => {
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
