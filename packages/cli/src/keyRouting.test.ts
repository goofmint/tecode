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
import { handleKeyEvent, type KeyRoutingDeps, type RoutableKeyEvent } from "./keyRouting";

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
});
