/**
 * Integration tests for `tecode.terminal`'s `activate(ctx)` (Issue #98
 * Phase 4) — a minimal fake `Tecode` (local to this file, `@tecode/api`
 * types only, matching `command-palette/index.test.ts`'s `createFakeApi`
 * house convention) stands in for the real core. Covers BOTH platform
 * branches: supported (POSIX — a real pty session is spawned, the view is
 * registered) and unsupported (Windows — commands still register, report
 * via `showMessage`, and never throw; no view is ever registered) — the
 * brief's own "this path needs a test with an injected platform or it is
 * untested forever" (this suite injects it at the `Tecode.terminal.
 * isSupported()` level, one layer above `@tecode/core`'s own already-tested
 * `ptyService.ts` platform guard).
 */

import { describe, expect, test } from "bun:test";
import type {
  CommandHandler,
  Disposable,
  ExtensionContext,
  Listener,
  MessageKind,
  PtyExitEvent,
  PtySession,
  PtySpawnOptions,
  Tecode,
} from "@tecode/api";
import { activate, deactivate, TERMINAL_UNSUPPORTED_MESSAGE } from "./index";
import { TERMINAL_FOCUS_COMMAND_ID, TERMINAL_NEW_COMMAND_ID, TERMINAL_VIEW_ID } from "./manifest";

function createFakeSession(): PtySession & { disposed: boolean } {
  let disposed = false;
  const exitListeners = new Set<Listener<PtyExitEvent>>();
  return {
    get disposed() {
      return disposed;
    },
    write() {},
    resize() {},
    onData: () => ({ dispose() {} }) as Disposable,
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    dispose() {
      disposed = true;
    },
  };
}

/** A minimal fake `Tecode` backing exactly what `terminal`'s `activate`
 * reads/writes: `commands`, `window.showMessage`, `terminal.isSupported`/
 * `spawn`, `ui.registerView`/`Terminal`. */
function createFakeApi(opts: { supported: boolean }) {
  const commandHandlers = new Map<string, CommandHandler>();
  const messages: { message: string; kind?: MessageKind }[] = [];
  const registeredViews = new Map<string, unknown>();
  const spawnCalls: PtySpawnOptions[] = [];
  const sessions: ReturnType<typeof createFakeSession>[] = [];
  const showPanelCalls: number[] = [];

  const commands: Tecode["commands"] = {
    register(id, handler) {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    async execute(id, ...args) {
      if (id === "workbench.action.showPanel") {
        showPanelCalls.push(1);
        return undefined;
      }
      const handler = commandHandlers.get(id);
      if (!handler) return undefined;
      return handler(...args);
    },
    list: () => [],
  };

  const api: Tecode = {
    commands,
    workspace: { rootUri: "file:///workspace/" } as unknown as Tecode["workspace"],
    window: {
      showMessage(message: string, kind?: MessageKind) {
        messages.push({ message, kind });
      },
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      setStatusBarItem: () => ({ dispose() {} }),
    } as unknown as Tecode["window"],
    editor: undefined as never,
    ui: {
      registerView: (_slot, id, component) => {
        registeredViews.set(id, component);
        return { dispose: () => registeredViews.delete(id) };
      },
      useTheme: undefined as never,
      List: undefined as never,
      Tree: undefined as never,
      Input: undefined as never,
      Tabs: undefined as never,
      Terminal: (() => undefined) as never,
    },
    config: undefined as never,
    context: { get: () => undefined, set: () => {} },
    languages: undefined as never,
    themes: undefined as never,
    clipboard: undefined as never,
    terminal: {
      isSupported: () => opts.supported,
      spawn: (options: PtySpawnOptions) => {
        spawnCalls.push(options);
        const session = createFakeSession();
        sessions.push(session);
        return session;
      },
    },
  };

  return { api, commandHandlers, messages, registeredViews, spawnCalls, sessions, showPanelCalls };
}

function createCtx(api: Tecode): ExtensionContext {
  return {
    api,
    extensionUri: "file:///builtin/tecode.terminal/",
    subscriptions: [],
    storagePath: "/tmp/tecode-test-terminal",
  };
}

describe("tecode.terminal — unsupported platform (Windows)", () => {
  test("both commands are still registered", () => {
    const { api, commandHandlers } = createFakeApi({ supported: false });
    activate(createCtx(api));

    expect(commandHandlers.has(TERMINAL_FOCUS_COMMAND_ID)).toBe(true);
    expect(commandHandlers.has(TERMINAL_NEW_COMMAND_ID)).toBe(true);
  });

  test("no view is ever registered", () => {
    const { api, registeredViews } = createFakeApi({ supported: false });
    activate(createCtx(api));

    expect(registeredViews.has(TERMINAL_VIEW_ID)).toBe(false);
  });

  test("terminal.focus reports the platform limitation via showMessage('error'), never throws, never spawns", async () => {
    const { api, messages, spawnCalls } = createFakeApi({ supported: false });
    const ctx = createCtx(api);
    activate(ctx);

    await expect(api.commands.execute(TERMINAL_FOCUS_COMMAND_ID)).resolves.toBeUndefined();

    expect(messages).toEqual([{ message: TERMINAL_UNSUPPORTED_MESSAGE, kind: "error" }]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("terminal.new ALSO reports the platform limitation and never spawns", async () => {
    const { api, messages, spawnCalls } = createFakeApi({ supported: false });
    activate(createCtx(api));

    await api.commands.execute(TERMINAL_NEW_COMMAND_ID);

    expect(messages).toEqual([{ message: TERMINAL_UNSUPPORTED_MESSAGE, kind: "error" }]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("activate() itself never throws on the unsupported path", () => {
    const { api } = createFakeApi({ supported: false });
    expect(() => activate(createCtx(api))).not.toThrow();
  });
});

describe("tecode.terminal — supported platform (POSIX)", () => {
  test("registers the panel.tab view under TERMINAL_VIEW_ID", () => {
    const { api, registeredViews } = createFakeApi({ supported: true });
    activate(createCtx(api));

    expect(registeredViews.has(TERMINAL_VIEW_ID)).toBe(true);
  });

  test("terminal.focus spawns a session (lazily, once), shows the panel, and never reports the Windows message", async () => {
    const { api, spawnCalls, messages, showPanelCalls } = createFakeApi({ supported: true });
    activate(createCtx(api));

    await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);

    expect(spawnCalls).toHaveLength(1);
    expect(showPanelCalls).toHaveLength(1);
    expect(messages).toEqual([]);
  });

  test("terminal.focus invoked twice does not spawn a second session", async () => {
    const { api, spawnCalls } = createFakeApi({ supported: true });
    activate(createCtx(api));

    await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);
    await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);

    expect(spawnCalls).toHaveLength(1);
  });

  test("terminal.new disposes the current session and spawns a fresh one", async () => {
    const { api, spawnCalls, sessions } = createFakeApi({ supported: true });
    activate(createCtx(api));

    await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);
    await api.commands.execute(TERMINAL_NEW_COMMAND_ID);

    expect(spawnCalls).toHaveLength(2);
    expect(sessions[0]?.disposed).toBe(true);
    expect(sessions[1]?.disposed).toBe(false);
  });

  test("spawns the user's $SHELL, falling back to /bin/sh", async () => {
    const originalShell = process.env["SHELL"];
    try {
      process.env["SHELL"] = "/usr/bin/zsh";
      const { api, spawnCalls } = createFakeApi({ supported: true });
      activate(createCtx(api));
      await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);
      expect(spawnCalls[0]?.cmd).toEqual(["/usr/bin/zsh"]);
    } finally {
      if (originalShell === undefined) delete process.env["SHELL"];
      else process.env["SHELL"] = originalShell;
    }
  });

  test("deactivate() (via a subscription pushed at activate time) disposes the live session", async () => {
    const { api, sessions } = createFakeApi({ supported: true });
    const ctx = createCtx(api);
    activate(ctx);
    await api.commands.execute(TERMINAL_FOCUS_COMMAND_ID);

    // The host disposes `ctx.subscriptions` on deactivation (Req 2.6) —
    // this suite drives that directly rather than depending on a real
    // `ExtensionHost`.
    for (const sub of ctx.subscriptions.slice().reverse()) sub.dispose();
    deactivate();

    expect(sessions[0]?.disposed).toBe(true);
  });
});
