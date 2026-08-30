import { describe, expect, test } from "bun:test";
import {
  createBindingTable,
  createChordStateMachine,
  createContextService,
  createDocument,
  createEditorInputRouter,
  createHostLog,
  createNoopStatusSink,
  type KeyEventLike,
  type KeymapLayers,
} from "@tecode/core";
import editorCoreManifest from "@tecode/builtin/editor-core/manifest";
import {
  handleKeyEvent,
  handlePasteEvent,
  TERMINAL_ESCAPE_STROKE,
  type KeyRoutingDeps,
  type PasteRoutingDeps,
  type RoutableKeyEvent,
  type TerminalKeyRoutingDeps,
} from "./keyRouting";

function keyOf(partial: Partial<KeyEventLike> & { name: string }): RoutableKeyEvent {
  return {
    ctrl: false,
    shift: false,
    option: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    ...partial,
  };
}

describe("handleKeyEvent (Task 2.2, design.md §6.1's full pipeline)", () => {
  test("a consumed stroke calls preventDefault and never reaches the editor router", () => {
    let routed: RoutableKeyEvent | undefined;
    let prevented = false;
    const deps: KeyRoutingDeps = {
      chordMachine: { handleStroke: () => "consumed" },
      editorInputRouter: {
        routeKeyEvent: (event) => {
          routed = event;
          return true;
        },
      },
    };
    const event = keyOf({ name: "p", ctrl: true, shift: true });
    event.preventDefault = () => {
      prevented = true;
    };

    handleKeyEvent(deps, event);

    expect(prevented).toBe(true);
    expect(routed).toBeUndefined();
  });

  test("a passthrough stroke reaches the editor router with the original event", () => {
    let routed: RoutableKeyEvent | undefined;
    let prevented = false;
    const deps: KeyRoutingDeps = {
      chordMachine: { handleStroke: () => "passthrough" },
      editorInputRouter: {
        routeKeyEvent: (event) => {
          routed = event;
          return true;
        },
      },
    };
    const event = keyOf({ name: "b", sequence: "b" });
    event.preventDefault = () => {
      prevented = true;
    };

    handleKeyEvent(deps, event);

    expect(prevented).toBe(false);
    expect(routed).toBe(event);
  });

  test("a missing preventDefault (bare KeyEventLike) does not throw on a consumed stroke", () => {
    const deps: KeyRoutingDeps = {
      chordMachine: { handleStroke: () => "consumed" },
      editorInputRouter: { routeKeyEvent: () => false },
    };
    expect(() => handleKeyEvent(deps, keyOf({ name: "a" }))).not.toThrow();
  });

  test("editor-core's Enter keybinding is consumed by the REAL chord machine and never reaches the editor router (Task 2.3, no double-insertion)", () => {
    // Builds the actual layered pipeline (`@opentui/core`'s reported Enter
    // key name is "return", not "enter" — `editor-core/manifest.ts`'s own
    // TSDoc) against `editor-core`'s real manifest keybindings, exactly as
    // `buildAssemblyRoot`/`runDeferredPhase` wire it in production — proof
    // that a bound Enter stroke is fully "consumed" by the keymap layer
    // BEFORE `editorInputRouter.routeKeyEvent` (Task 2.2's plain-typing
    // fallthrough, which does not itself special-case "return" either way)
    // ever sees it, so `editor.action.insertNewLine` is the newline's sole
    // source — never a double insertion.
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);

    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: editorCoreManifest.contributes.keybindings ?? [],
      user: [],
    };
    const table = createBindingTable(layers, { log });

    const executed: string[] = [];
    const chordMachine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
        return Promise.resolve(undefined);
      },
      getContext: (key) => context.get(key),
      log,
    });

    let routed = false;
    const deps: KeyRoutingDeps = {
      chordMachine,
      editorInputRouter: {
        routeKeyEvent: () => {
          routed = true;
          return true;
        },
      },
    };

    handleKeyEvent(deps, keyOf({ name: "return", sequence: "\r" }));

    expect(executed).toEqual(["editor.action.insertNewLine"]);
    expect(routed).toBe(false);

    chordMachine.dispose();
  });

  test("editor-core's bracket keybinding ('(') is consumed by the REAL chord machine and never reaches the editor router (Task 2.4, no double-insertion)", () => {
    // Verifies the stroke name `manifest.ts`'s TSDoc documents for typing
    // "(": an unmodified printable keystroke is NEVER sent as a Kitty
    // escape sequence (`@opentui/core`'s `CliRenderer` never requests the
    // "report all keys as escape codes" flag), so on every terminal it
    // arrives as the literal byte and `parseKeypress` reports `{ name:
    // "(", ctrl: false, shift: false, ... }` — no `shift+` prefix, even
    // though it's a shifted key on a US layout — so `keyEventToStroke`
    // produces the canonical stroke `"("` itself, exactly what this
    // manifest binds. Proof that the keybinding — not `editor/
    // inputRouter.ts`'s plain-typing fallthrough — is `editor.action.
    // typeOpenParen`'s sole source, so bracket auto-close never
    // double-inserts.
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);

    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: editorCoreManifest.contributes.keybindings ?? [],
      user: [],
    };
    const table = createBindingTable(layers, { log });

    const executed: string[] = [];
    const chordMachine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
        return Promise.resolve(undefined);
      },
      getContext: (key) => context.get(key),
      log,
    });

    let routed = false;
    const deps: KeyRoutingDeps = {
      chordMachine,
      editorInputRouter: {
        routeKeyEvent: () => {
          routed = true;
          return true;
        },
      },
    };

    handleKeyEvent(deps, keyOf({ name: "(", sequence: "(" }));

    expect(executed).toEqual(["editor.action.typeOpenParen"]);
    expect(routed).toBe(false);

    chordMachine.dispose();
  });
});

describe("editor-core's Task 2.4 keybindings — verified strokes (manifest.ts's TSDoc)", () => {
  /** Build the real chord machine over `editor-core`'s manifest bindings
   * and fire one key event through it, returning which command (if any)
   * executed and whether the event reached the editor router — the same
   * harness as this file's "Enter"/bracket tests above, factored out since
   * this block exercises many strokes. */
  function fireEditorCoreKeybinding(event: RoutableKeyEvent): { executed: string[]; routed: boolean } {
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);

    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: editorCoreManifest.contributes.keybindings ?? [],
      user: [],
    };
    const table = createBindingTable(layers, { log });

    const executed: string[] = [];
    const chordMachine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
        return Promise.resolve(undefined);
      },
      getContext: (key) => context.get(key),
      log,
    });

    let routed = false;
    handleKeyEvent(
      { chordMachine, editorInputRouter: { routeKeyEvent: () => (routed = true) } },
      event,
    );
    chordMachine.dispose();
    return { executed, routed };
  }

  test("ctrl+/ on a Kitty-disambiguating terminal reaches toggleLineComment", () => {
    // Verified Kitty CSI-u decode: `{ name: "/", ctrl: true }`.
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "/", ctrl: true }));
    expect(executed).toEqual(["editor.action.toggleLineComment"]);
  });

  test("ctrl+/ on a non-Kitty terminal (raw 0x1F -> name '_') also reaches toggleLineComment", () => {
    // Verified legacy decode of the raw control byte 0x1F: `{ name: "_",
    // ctrl: true }` — the dual `ctrl+_` binding this manifest declares
    // specifically for this case.
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "_", ctrl: true }));
    expect(executed).toEqual(["editor.action.toggleLineComment"]);
  });

  test("alt+up (verified: option AND meta both set) reaches moveLinesUp", () => {
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "up", option: true, meta: true }));
    expect(executed).toEqual(["editor.action.moveLinesUp"]);
  });

  test("alt+down (verified: option AND meta both set) reaches moveLinesDown", () => {
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "down", option: true, meta: true }));
    expect(executed).toEqual(["editor.action.moveLinesDown"]);
  });

  test("shift+alt+down (verified: shift/option/meta all set) reaches duplicateLine, not moveLinesDown", () => {
    const { executed } = fireEditorCoreKeybinding(
      keyOf({ name: "down", shift: true, option: true, meta: true }),
    );
    expect(executed).toEqual(["editor.action.duplicateLine"]);
  });

  test("ctrl+z reaches undo; ctrl+y and ctrl+shift+z both reach redo", () => {
    expect(fireEditorCoreKeybinding(keyOf({ name: "z", ctrl: true })).executed).toEqual([
      "editor.action.undo",
    ]);
    expect(fireEditorCoreKeybinding(keyOf({ name: "y", ctrl: true })).executed).toEqual([
      "editor.action.redo",
    ]);
    expect(fireEditorCoreKeybinding(keyOf({ name: "z", ctrl: true, shift: true })).executed).toEqual([
      "editor.action.redo",
    ]);
  });

  test("documented degraded mode: ctrl+shift+z on a non-Kitty terminal collides with ctrl+z (fires undo)", () => {
    // A non-Kitty terminal cannot distinguish Ctrl+Shift+Z from Ctrl+Z (a
    // raw control byte carries no case/shift information) — this
    // manifest's TSDoc documents `redo`'s `ctrl+shift+z` binding as
    // accepting this risk (mitigated by the always-safe `ctrl+y`
    // alternate above) since an accidental undo is non-destructive. This
    // test pins that documented, deliberate degraded behavior rather than
    // silently reversing it later.
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "z", ctrl: true, shift: false }));
    expect(executed).toEqual(["editor.action.undo"]);
  });

  test("ctrl+d reaches addSelectionToNextFindMatch (no collision with duplicateLine's key)", () => {
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "d", ctrl: true }));
    expect(executed).toEqual(["editor.action.addSelectionToNextFindMatch"]);
  });

  test("ctrl+shift+k on a non-Kitty terminal (collapses to ctrl+k) safely does nothing — no command claims ctrl+k", () => {
    const { executed, routed } = fireEditorCoreKeybinding(keyOf({ name: "k", ctrl: true, shift: false }));
    expect(executed).toEqual([]);
    // Not a printable/editable key either (ctrl held) — the editor router
    // would not have inserted anything even if this had fallen through.
    expect(routed).toBe(true);
  });

  test("ctrl+shift+k on a Kitty-disambiguating terminal reaches deleteLine", () => {
    const { executed } = fireEditorCoreKeybinding(keyOf({ name: "k", ctrl: true, shift: true }));
    expect(executed).toEqual(["editor.action.deleteLine"]);
  });
});

describe("editor-core's Task 2.5 find/replace keybindings (Req 11.1, manifest.ts's TSDoc)", () => {
  /** Same shape as `fireEditorCoreKeybinding` above, but with the calling
   * context supplied by the test (rather than hardcoded to
   * `editorTextFocus: true`) — Task 2.5's find keybindings are gated on
   * TWO different context keys depending on the stroke, unlike every
   * earlier binding in this file. */
  function fireWithContext(
    event: RoutableKeyEvent,
    setContext: (context: ReturnType<typeof createContextService>) => void,
  ): { executed: string[]; routed: boolean } {
    const log = createHostLog();
    const context = createContextService();
    setContext(context);

    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: editorCoreManifest.contributes.keybindings ?? [],
      user: [],
    };
    const table = createBindingTable(layers, { log });

    const executed: string[] = [];
    const chordMachine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
        return Promise.resolve(undefined);
      },
      getContext: (key) => context.get(key),
      log,
    });

    let routed = false;
    handleKeyEvent(
      { chordMachine, editorInputRouter: { routeKeyEvent: () => (routed = true) } },
      event,
    );
    chordMachine.dispose();
    return { executed, routed };
  }

  test("ctrl+f under editorTextFocus is consumed and reaches editor.action.find", () => {
    const { executed, routed } = fireWithContext(keyOf({ name: "f", ctrl: true }), (context) =>
      context.set("editorTextFocus", true),
    );
    expect(executed).toEqual(["editor.action.find"]);
    expect(routed).toBe(false); // never reached the editor router (consumed)
  });

  test("ctrl+f with NEITHER context key set falls through untouched (not consumed, not routed to an insert)", () => {
    // No active editor / nothing focused at all — a documented no-op
    // shape: the chord machine reports passthrough (no binding's `when`
    // passed), and the editor router's own `editorTextFocus` gate (checked
    // inside `routeKeyEvent`, not exercised by this fake) would also
    // refuse it — this test only proves the KEYMAP layer's half.
    const { executed } = fireWithContext(keyOf({ name: "f", ctrl: true }), () => {
      // Neither editorTextFocus nor findWidgetFocus set.
    });
    expect(executed).toEqual([]);
  });

  test("return under findWidgetFocus is consumed and reaches editor.action.findNext, NOT insertNewLine", () => {
    const { executed, routed } = fireWithContext(keyOf({ name: "return", sequence: "\r" }), (context) =>
      context.set("findWidgetFocus", true),
    );
    expect(executed).toEqual(["editor.action.findNext"]);
    expect(routed).toBe(false);
  });

  test("return under editorTextFocus (findWidgetFocus absent) still reaches insertNewLine — the two 'return' bindings don't collide", () => {
    const { executed } = fireWithContext(keyOf({ name: "return", sequence: "\r" }), (context) =>
      context.set("editorTextFocus", true),
    );
    expect(executed).toEqual(["editor.action.insertNewLine"]);
  });

  test("shift+return under findWidgetFocus reaches editor.action.findPrevious", () => {
    const { executed } = fireWithContext(
      keyOf({ name: "return", sequence: "\r", shift: true }),
      (context) => context.set("findWidgetFocus", true),
    );
    expect(executed).toEqual(["editor.action.findPrevious"]);
  });

  test("escape under findWidgetFocus is consumed and reaches editor.action.closeFind", () => {
    const { executed, routed } = fireWithContext(keyOf({ name: "escape", sequence: "\x1b" }), (context) =>
      context.set("findWidgetFocus", true),
    );
    expect(executed).toEqual(["editor.action.closeFind"]);
    expect(routed).toBe(false);
  });

  test("escape under editorTextFocus (findWidgetFocus absent) matches no binding — passes through", () => {
    // No `escape` binding exists under `editorTextFocus` in this manifest
    // — proves `closeFind`'s binding is genuinely gated on
    // `findWidgetFocus`, not simply "escape always closes find".
    const { executed, routed } = fireWithContext(keyOf({ name: "escape", sequence: "\x1b" }), (context) =>
      context.set("editorTextFocus", true),
    );
    expect(executed).toEqual([]);
    expect(routed).toBe(true); // falls through to the editor router
  });
});

describe("handleKeyEvent — terminal focus routing (Issue #98 Phase 3)", () => {
  /** A `KeyRoutingDeps.chordMachine`/`editorInputRouter` pair that fails
   * the test the instant either is touched — proves the terminal-focus
   * branch runs BEFORE, and instead of, the ordinary keymap pipeline. */
  function forbiddenPipeline(): Pick<KeyRoutingDeps, "chordMachine" | "editorInputRouter"> {
    return {
      chordMachine: {
        handleStroke: () => {
          throw new Error("chordMachine must not run while the terminal has focus");
        },
      },
      editorInputRouter: {
        routeKeyEvent: () => {
          throw new Error("editorInputRouter must not run while the terminal has focus");
        },
      },
    };
  }

  function fakeTerminal(focused: boolean): TerminalKeyRoutingDeps & {
    written: string[];
    escaped: number;
  } {
    const written: string[] = [];
    let escaped = 0;
    return {
      written,
      get escaped() {
        return escaped;
      },
      isFocused: () => focused,
      write: (data) => written.push(data),
      escape: () => {
        escaped++;
      },
    };
  }

  test("while focused, an ordinary key is written to the pty using event.raw, never reaching chordMachine/editorInputRouter", () => {
    const terminal = fakeTerminal(true);
    let prevented = false;
    const event = keyOf({ name: "down", sequence: "\x1b[B" });
    (event as RoutableKeyEvent).raw = "\x1b[B";
    event.preventDefault = () => {
      prevented = true;
    };

    handleKeyEvent({ ...forbiddenPipeline(), terminal }, event);

    expect(terminal.written).toEqual(["\x1b[B"]);
    expect(terminal.escaped).toBe(0);
    expect(prevented).toBe(true);
  });

  test("while focused, a key with no event.raw falls back to event.sequence", () => {
    const terminal = fakeTerminal(true);
    const event = keyOf({ name: "a", sequence: "a" });

    handleKeyEvent({ ...forbiddenPipeline(), terminal }, event);

    expect(terminal.written).toEqual(["a"]);
  });

  test("Issue #110 regression guard: while focused, a multi-character IME sequence is STILL forwarded to the pty unchanged, never reaching editorInputRouter", () => {
    // This is the terminal-focus branch's existing behavior (`event.raw ??
    // event.sequence`, unconditional) — the Issue #110 fix lives entirely
    // in `@tecode/core`'s `inputRouter.ts`'s `isPrintableSequence`, which
    // this branch never calls at all (`forbiddenPipeline` would throw if it
    // did). Proves widening what `isPrintableSequence` accepts did not
    // change what reaches the terminal panel.
    const terminal = fakeTerminal(true);
    const event = keyOf({ name: "日本語", sequence: "日本語" });
    (event as RoutableKeyEvent).raw = "日本語";

    handleKeyEvent({ ...forbiddenPipeline(), terminal }, event);

    expect(terminal.written).toEqual(["日本語"]);
    expect(terminal.escaped).toBe(0);
  });

  test("Ctrl+C reaching this function while focused is still forwarded like any other key — OpenTUI's own exitOnCtrlC intercepts it earlier in production, this function has no special case for it", () => {
    const terminal = fakeTerminal(true);
    const event = keyOf({ name: "c", ctrl: true, sequence: "\x03" });

    handleKeyEvent({ ...forbiddenPipeline(), terminal }, event);

    expect(terminal.written).toEqual(["\x03"]);
  });

  test("the reserved escape stroke (ctrl+o) while focused calls terminal.escape(), writes nothing, and never reaches chordMachine/editorInputRouter", () => {
    const terminal = fakeTerminal(true);
    let prevented = false;
    const event = keyOf({ name: "o", ctrl: true });
    event.preventDefault = () => {
      prevented = true;
    };

    handleKeyEvent({ ...forbiddenPipeline(), terminal }, event);

    expect(terminal.escaped).toBe(1);
    expect(terminal.written).toEqual([]);
    expect(prevented).toBe(true);
  });

  test("TERMINAL_ESCAPE_STROKE is exactly the canonical stroke ctrl+o presses normalize to", () => {
    expect(TERMINAL_ESCAPE_STROKE).toBe("ctrl+o");
  });

  test("mutation check — removing the escape-stroke branch would trap the user: without it, ctrl+o would be forwarded to the pty like any other key", () => {
    // This test documents (and pins) the SHAPE of the safety property by
    // asserting the escape stroke's actual behavior differs from a
    // same-shaped ordinary key's — if a future edit collapsed the
    // `stroke === TERMINAL_ESCAPE_STROKE` branch into the plain forwarding
    // branch, this test fails because `written` would gain an entry and
    // `escaped` would stay 0.
    const terminal = fakeTerminal(true);
    const escapeEvent = keyOf({ name: "o", ctrl: true });
    handleKeyEvent({ ...forbiddenPipeline(), terminal }, escapeEvent);
    expect(terminal.written).toEqual([]);
    expect(terminal.escaped).toBe(1);
  });

  test("when NOT focused, isFocused() false falls through to the ordinary chordMachine/editorInputRouter pipeline untouched", () => {
    const terminal = fakeTerminal(false);
    let handled: string | undefined;
    const deps: KeyRoutingDeps = {
      chordMachine: {
        handleStroke: (s) => {
          handled = s;
          return "passthrough";
        },
      },
      editorInputRouter: { routeKeyEvent: () => true },
      terminal,
    };

    handleKeyEvent(deps, keyOf({ name: "b", sequence: "b" }));

    expect(handled).toBe("b");
    expect(terminal.written).toEqual([]);
    expect(terminal.escaped).toBe(0);
  });

  test("when deps.terminal is entirely omitted (pre-#98 callers/tests), behavior is unchanged", () => {
    let routed = false;
    const deps: KeyRoutingDeps = {
      chordMachine: { handleStroke: () => "passthrough" },
      editorInputRouter: { routeKeyEvent: () => (routed = true) },
    };

    handleKeyEvent(deps, keyOf({ name: "x", sequence: "x" }));

    expect(routed).toBe(true);
  });

  test("the escape stroke does nothing special when the terminal is NOT focused — ctrl+o falls through to the ordinary pipeline like any other unbound stroke", () => {
    const terminal = fakeTerminal(false);
    let handledStroke: string | undefined;
    const deps: KeyRoutingDeps = {
      chordMachine: { handleStroke: (s) => ((handledStroke = s), "passthrough") },
      editorInputRouter: { routeKeyEvent: () => true },
      terminal,
    };

    handleKeyEvent(deps, keyOf({ name: "o", ctrl: true }));

    expect(handledStroke).toBe("ctrl+o");
    expect(terminal.escaped).toBe(0);
  });
});

describe("handlePasteEvent (Issue #91's paste path)", () => {
  test("delegates the decoded text straight to editorInputRouter.insertText", () => {
    let received: string | undefined;
    const deps: PasteRoutingDeps = {
      editorInputRouter: { insertText: (text) => (received = text) },
    };

    handlePasteEvent(deps, "pasted\ntext");

    expect(received).toBe("pasted\ntext");
  });

  test("goes through no chord machine at all — an empty paste is still forwarded", () => {
    let calls = 0;
    const deps: PasteRoutingDeps = {
      editorInputRouter: { insertText: () => calls++ },
    };

    handlePasteEvent(deps, "");

    expect(calls).toBe(1);
  });
});

/**
 * End-to-end version of the same pipeline, wired against the REAL
 * `ChordStateMachine`/`BindingTable`/`createEditorInputRouter`/`CoreDocument`
 * (no fakes) — the most direct proof of design.md §6.1's contract: a stroke
 * with a matching, when-passing keybinding never reaches the buffer, and a
 * stroke with no binding does.
 */
describe("handleKeyEvent — end to end against real keymap + editor services", () => {
  function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
    return {
      defaults: partial.defaults ?? [],
      fallback: partial.fallback ?? [],
      extension: partial.extension ?? [],
      user: partial.user ?? [],
    };
  }

  test("a keybinding on 'a' consumes it — it never becomes an insert", () => {
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);
    const document = createDocument({
      uri: "file:///test.txt",
      languageId: "plaintext",
      text: "xyz",
      sink: createNoopStatusSink(),
      log,
    });

    let executed: string | undefined;
    const table = createBindingTable(layersOf({ user: [{ key: "a", command: "some.command" }] }), { log });
    const chordMachine = createChordStateMachine({
      table,
      execute: (id) => {
        executed = id;
      },
      getContext: (key) => context.get(key),
      log,
    });
    const editorInputRouter = createEditorInputRouter({
      context,
      editorSession: {
        getActiveDocument: () => document,
        getState: () => ({ documentUri: document.uri, selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
        ], scrollTop: 0 }),
        setState: () => {},
      },
    });

    handleKeyEvent({ chordMachine, editorInputRouter }, keyOf({ name: "a" }));

    expect(executed).toBe("some.command");
    expect(document.getLine(0)).toBe("xyz"); // unchanged — never reached the buffer
  });

  test("a key with no binding falls through and DOES become an insert", () => {
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);
    const document = createDocument({
      uri: "file:///test.txt",
      languageId: "plaintext",
      text: "xyz",
      sink: createNoopStatusSink(),
      log,
    });

    const table = createBindingTable(layersOf({}), { log });
    const chordMachine = createChordStateMachine({
      table,
      execute: () => {},
      getContext: (key) => context.get(key),
      log,
    });
    let sawSelections: unknown;
    const editorInputRouter = createEditorInputRouter({
      context,
      editorSession: {
        getActiveDocument: () => document,
        getState: () => ({ documentUri: document.uri, selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
        ], scrollTop: 0 }),
        setState: (_uri, state) => {
          sawSelections = state.selections;
        },
      },
    });

    handleKeyEvent({ chordMachine, editorInputRouter }, keyOf({ name: "b", sequence: "b" }));

    expect(document.getLine(0)).toBe("bxyz");
    expect(sawSelections).toEqual([
      { start: { line: 0, character: 1 }, end: { line: 0, character: 1 }, anchor: { line: 0, character: 1 }, active: { line: 0, character: 1 } },
    ]);
  });

  test("Issue #110: with the editor focused, a multi-character IME commit with no binding reaches editorInputRouter and inserts whole", () => {
    // Same shape as the single-character test above, but with a
    // `KeyEventLike.sequence` holding a whole IME-committed string —
    // proves `handleKeyEvent`'s own pipeline (chord machine → passthrough →
    // `editorInputRouter.routeKeyEvent`) needed NO change for Issue #110:
    // the fix is entirely `isPrintableSequence`'s, in `@tecode/core`.
    const log = createHostLog();
    const context = createContextService();
    context.set("editorTextFocus", true);
    const document = createDocument({
      uri: "file:///test.txt",
      languageId: "plaintext",
      text: "xyz",
      sink: createNoopStatusSink(),
      log,
    });

    const table = createBindingTable(layersOf({}), { log });
    const chordMachine = createChordStateMachine({
      table,
      execute: () => {},
      getContext: (key) => context.get(key),
      log,
    });
    let sawSelections: unknown;
    const editorInputRouter = createEditorInputRouter({
      context,
      editorSession: {
        getActiveDocument: () => document,
        getState: () => ({ documentUri: document.uri, selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
        ], scrollTop: 0 }),
        setState: (_uri, state) => {
          sawSelections = state.selections;
        },
      },
    });

    handleKeyEvent(
      { chordMachine, editorInputRouter },
      keyOf({ name: "日本語", sequence: "日本語" }),
    );

    expect(document.getLine(0)).toBe("日本語xyz");
    expect(sawSelections).toEqual([
      { start: { line: 0, character: 3 }, end: { line: 0, character: 3 }, anchor: { line: 0, character: 3 }, active: { line: 0, character: 3 } },
    ]);
  });
});
