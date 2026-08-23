import { describe, expect, test } from "bun:test";
import type { DocumentChangeEvent, Eol, Selection, TextEdit } from "@tecode/api";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import type { Clock } from "./clock";
import { TYPING_COALESCE_WINDOW_MS } from "./undoStack";
import { createDocument } from "./document";

/** A fake, manually advanceable {@link Clock} — deterministic coalescing
 * tests must never depend on real elapsed time (matches undoStack.test.ts's
 * fake clock). */
function createFakeClock(startAt = 0): Clock & { advance(ms: number): void } {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function cursorAt(line: number, character: number): Selection {
  const pos = { line, character };
  return { start: pos, end: pos, anchor: pos, active: pos };
}

/** A {@link StatusSink} stub that records every error it receives, for
 * assertions (matching registry.test.ts's `createRecordingSink`). */
function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

function baseDeps() {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  return { log, sink, errors };
}

describe("createDocument — EOL detection (Req 5.1)", () => {
  const cases: Array<{ name: string; text: string; expected: Eol }> = [
    { name: "\\n only", text: "a\nb\nc", expected: "\n" },
    { name: "\\r\\n only", text: "a\r\nb\r\nc", expected: "\r\n" },
    { name: "mixed, \\r\\n first", text: "a\r\nb\nc", expected: "\r\n" },
    { name: "mixed, \\n first", text: "a\nb\r\nc", expected: "\n" },
    { name: "no line breaks (default)", text: "single line, no breaks", expected: "\n" },
    { name: "empty text (default)", text: "", expected: "\n" },
  ];

  for (const { name, text, expected } of cases) {
    test(name, () => {
      const { log, sink } = baseDeps();
      const doc = createDocument({
        uri: "file:///test.txt",
        languageId: "plaintext",
        text,
        sink,
        log,
      });
      expect(doc.eol).toBe(expected);
    });
  }
});

describe("createDocument — applyEdits and onDidChange (Req 5.2, 5.3)", () => {
  test("fires onDidChange exactly once per applyEdits call, with incremented version", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello world",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    const edit: TextEdit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      newText: "HELLO",
    };
    doc.applyEdits([edit]);

    expect(events).toHaveLength(1);
    expect(events[0]!.version).toBe(1);
    expect(doc.version).toBe(1);
  });

  test("carries the correct dirtyRange for a single single-line edit", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "one\ntwo\nthree",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.applyEdits([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        newText: "TWO",
      },
    ]);

    expect(events[0]!.dirtyRange).toEqual({ startLine: 1, endLine: 1, lineCountDelta: 0 });
  });

  test("dirtyRange spans the min start line to max end line across a multi-edit batch", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "l0\nl1\nl2\nl3\nl4",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.applyEdits([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
        newText: "L1",
      },
      {
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } },
        newText: "L3",
      },
    ]);

    expect(events[0]!.dirtyRange).toEqual({ startLine: 1, endLine: 3, lineCountDelta: 0 });
  });

  test("dirtyRange reports the line-count delta for inserts and deletes that change line structure", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "one\ntwo\nthree",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    // Insert two extra lines inside line 0.
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
        newText: "\nalpha\nbeta",
      },
    ]);
    expect(events[0]!.dirtyRange).toEqual({ startLine: 0, endLine: 0, lineCountDelta: 2 });

    // Delete a whole line span (now 5 lines: one, alpha, beta, two, three).
    doc.applyEdits([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } },
        newText: "",
      },
    ]);
    expect(events[1]!.dirtyRange).toEqual({ startLine: 1, endLine: 2, lineCountDelta: -1 });
  });

  test("carries inverse edits that undo the change when applied back", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello world",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "HELLO",
      },
    ]);

    expect(events[0]!.inverseEdits).toHaveLength(1);
    expect(events[0]!.inverseEdits[0]!.newText).toBe("hello");

    doc.applyEdits(events[0]!.inverseEdits);
    // The document has no way to read its own text in this task (that's
    // LineBuffer's job internally), so we confirm indirectly: applying
    // the inverse produced a second, distinct change event and bumped
    // version again rather than throwing.
    expect(events).toHaveLength(2);
    expect(doc.version).toBe(2);
  });

  test("dirty flips to true after the first applyEdits call", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    expect(doc.dirty).toBe(false);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "x",
      },
    ]);
    expect(doc.dirty).toBe(true);
  });

  test("an empty edits array is a no-op: no event, no version bump", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.applyEdits([]);

    expect(events).toHaveLength(0);
    expect(doc.version).toBe(0);
    expect(doc.dirty).toBe(false);
  });

  test("an invalid edit propagates the thrown error and does not bump version or fire an event", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    const invalid: TextEdit = {
      range: { start: { line: 0, character: 99 }, end: { line: 0, character: 99 } },
      newText: "x",
    };
    expect(() => doc.applyEdits([invalid])).toThrow(RangeError);

    expect(events).toHaveLength(0);
    expect(doc.version).toBe(0);
    expect(doc.dirty).toBe(false);
  });
});

describe("createDocument — readonly (Req 5.5)", () => {
  test("applyEdits is a no-op, notifies the sink, fires no event, leaves version/dirty unchanged", () => {
    const { log, sink, errors } = baseDeps();
    const doc = createDocument({
      uri: "file:///big.txt",
      languageId: "plaintext",
      text: "hello world",
      readonly: true,
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "HELLO",
      },
    ]);

    expect(events).toHaveLength(0);
    expect(doc.version).toBe(0);
    expect(doc.dirty).toBe(false);
    expect(doc.readonly).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("read-only");
    expect(errors[0]!.path).toBe("file:///big.txt");
  });

  test("readonly defaults to false when not specified", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });
    expect(doc.readonly).toBe(false);
  });

  test("a broken sink does not make applyEdits throw on a readonly document", () => {
    const log = createHostLog();
    const throwingSink = {
      error() {
        throw new Error("sink is broken");
      },
    };
    const doc = createDocument({
      uri: "file:///big.txt",
      languageId: "plaintext",
      text: "hello",
      readonly: true,
      sink: throwingSink,
      log,
    });

    expect(() =>
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "H",
        },
      ]),
    ).not.toThrow();
  });
});

describe("createDocument — onDidChange listener isolation", () => {
  test("a throwing listener does not stop later listeners from firing", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    const calls: string[] = [];
    doc.onDidChange(() => {
      calls.push("first");
      throw new Error("listener boom");
    });
    doc.onDidChange(() => {
      calls.push("second");
    });

    expect(() =>
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "x",
        },
      ]),
    ).not.toThrow();

    expect(calls).toEqual(["first", "second"]);
    // The throwing listener's failure is recorded rather than silently
    // dropped.
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries[0]!.error.message).toContain("listener boom");
  });

  test("dispose removes a listener so it no longer receives events", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    let calls = 0;
    const registration = doc.onDidChange(() => {
      calls++;
    });
    registration.dispose();

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "x",
      },
    ]);

    expect(calls).toBe(0);
  });

  test("double-dispose is a no-op", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });
    const registration = doc.onDidChange(() => undefined);
    registration.dispose();
    expect(() => registration.dispose()).not.toThrow();
  });
});

describe("createDocument — transaction (minimal passthrough for this task)", () => {
  test("transaction simply invokes fn, and edits inside it still fire their own events", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "ab",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    doc.transaction(() => {
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "A",
        },
      ]);
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
          newText: "B",
        },
      ]);
    });

    expect(events).toHaveLength(2);
    expect(doc.version).toBe(2);
  });
});

describe("createDocument — transaction undo grouping (Req 5.4)", () => {
  test("a transaction's multiple applyEdits calls undo as a single step", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "ab",
      sink,
      log,
    });

    doc.transaction(() => {
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "A",
        },
      ]);
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
          newText: "B",
        },
      ]);
    });
    expect(doc.version).toBe(2);

    // One undo() call reverts both edits at once.
    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));
    doc.undo();

    expect(events).toHaveLength(1);
    expect(events[0]!.inverseEdits).toHaveLength(2);
    expect(doc.version).toBe(3);

    // A second undo() call finds nothing further to undo (returns
    // undefined and fires no additional event).
    expect(doc.undo()).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  test("nested transaction() calls share the outer transaction's group", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "abc",
      sink,
      log,
    });

    doc.transaction(() => {
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "A",
        },
      ]);
      doc.transaction(() => {
        doc.applyEdits([
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
            newText: "B",
          },
        ]);
      });
      doc.applyEdits([
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
          newText: "C",
        },
      ]);
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));
    doc.undo();

    expect(events).toHaveLength(1);
    expect(events[0]!.inverseEdits).toHaveLength(3);
    expect(doc.undo()).toBeUndefined();
  });

  test("the transaction group is closed even when fn throws, so later edits are not swept in", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "ab",
      sink,
      log,
    });

    expect(() =>
      doc.transaction(() => {
        doc.applyEdits([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: "A",
          },
        ]);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // A later, unrelated edit must not merge into the aborted
    // transaction's group.
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        newText: "B",
      },
    ]);

    doc.undo();
    doc.undo();
    // Two independent undo steps existed (no third to pop).
    expect(doc.undo()).toBeUndefined();
  });
});

describe("createDocument — undo/redo round-trip (Req 5.4)", () => {
  test("undo -> redo -> undo round-trips buffer content and selection payloads exactly", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello world",
      sink,
      log,
    });

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));

    const before = [cursorAt(0, 0)];
    const after = [cursorAt(0, 5)];
    doc.applyEdits(
      [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          newText: "HELLO",
        },
      ],
      { selectionsBefore: before, selectionsAfter: after },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.inverseEdits[0]!.newText).toBe("hello");

    // undo: restores "hello", returns selectionsBefore.
    const undoneSelections = doc.undo();
    expect(undoneSelections).toEqual(before);
    expect(events).toHaveLength(2);
    expect(events[1]!.inverseEdits[0]!.newText).toBe("HELLO"); // redo batch

    // redo: restores "HELLO", returns selectionsAfter.
    const redoneSelections = doc.redo();
    expect(redoneSelections).toEqual(after);
    expect(events).toHaveLength(3);
    expect(events[2]!.inverseEdits[0]!.newText).toBe("hello"); // undo batch again

    // undo again: back to "hello", exact same payload as the first undo.
    const undoneAgain = doc.undo();
    expect(undoneAgain).toEqual(before);
    expect(events).toHaveLength(4);
    expect(events[3]!.inverseEdits[0]!.newText).toBe("HELLO");
    expect(doc.version).toBe(4);
  });

  test("a new edit after undo clears the redo stack", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "x",
      },
    ]);
    doc.undo();
    expect(doc.redo()).toBeDefined(); // sanity: redo is available before the new edit

    // Undo again to restore the redo entry we just consumed, then verify
    // a fresh edit clears it.
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "y",
      },
    ]);
    doc.undo();
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "z",
      },
    ]);
    expect(doc.redo()).toBeUndefined();
  });

  // `@tecode/api`'s `Document.undo`/`redo` TSDoc: `undefined` means "nothing
  // to undo/redo" (empty stack), while an empty (but defined) array means
  // "an entry WAS undone/redone, but it carries no selection snapshot" —
  // exactly what every entry recorded through the public, single-argument
  // `applyEdits` gets, since there is no `opts` on that signature to supply
  // `selectionsBefore`/`selectionsAfter` through. The two must stay
  // distinguishable so a caller (`editor-core`'s undo/redo command
  // handlers) can tell "leave the caret, nothing happened" apart from
  // "leave the caret, something happened but there's nothing to restore".
  test("undo()/redo() return [] (not undefined) for an entry recorded via the public single-arg applyEdits", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    // No `opts` — the only signature `@tecode/api`'s `Document` exposes.
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" },
    ]);

    const undone = doc.undo();
    expect(undone).toEqual([]);
    expect(undone).not.toBeUndefined();

    const redone = doc.redo();
    expect(redone).toEqual([]);
    expect(redone).not.toBeUndefined();

    // Once the stack is actually empty, the return value goes back to
    // `undefined` — the two states never collapse into each other.
    doc.undo();
    expect(doc.undo()).toBeUndefined();
  });

  test("undo()/redo() are silent no-ops on empty stacks", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "hello",
      sink,
      log,
    });

    expect(() => doc.undo()).not.toThrow();
    expect(doc.undo()).toBeUndefined();
    expect(() => doc.redo()).not.toThrow();
    expect(doc.redo()).toBeUndefined();
    expect(doc.version).toBe(0);
  });
});

describe("createDocument — readonly and undo/redo (Req 5.5)", () => {
  test("a readonly document never records undo entries, so undo() stays a no-op", () => {
    const { log, sink, errors } = baseDeps();
    const doc = createDocument({
      uri: "file:///big.txt",
      languageId: "plaintext",
      text: "hello world",
      readonly: true,
      sink,
      log,
    });

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "HELLO",
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(doc.undo()).toBeUndefined();
    expect(doc.redo()).toBeUndefined();
  });
});

describe("createDocument — typing coalescing end-to-end (Req 5.4)", () => {
  function typeChar(
    doc: ReturnType<typeof createDocument>,
    char: string,
    at: number,
  ): void {
    doc.applyEdits([
      {
        range: { start: { line: 0, character: at }, end: { line: 0, character: at } },
        newText: char,
      },
    ]);
  }

  test("consecutive keystrokes within 750 ms undo together as one entry", () => {
    const { log, sink } = baseDeps();
    const clock = createFakeClock();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "",
      sink,
      log,
      clock,
    });

    typeChar(doc, "a", 0);
    clock.advance(10);
    typeChar(doc, "b", 1);
    clock.advance(10);
    typeChar(doc, "c", 2);
    expect(doc.version).toBe(3);

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));
    doc.undo();

    // All three keystrokes undone in a single step.
    expect(events).toHaveLength(1);
    expect(events[0]!.inverseEdits).toHaveLength(3);
    expect(doc.undo()).toBeUndefined();
  });

  test("a keystroke more than 750 ms after the last one starts a new undo entry", () => {
    const { log, sink } = baseDeps();
    const clock = createFakeClock();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "",
      sink,
      log,
      clock,
    });

    typeChar(doc, "a", 0);
    clock.advance(TYPING_COALESCE_WINDOW_MS + 1);
    typeChar(doc, "b", 1);

    const events: DocumentChangeEvent[] = [];
    doc.onDidChange((e) => events.push(e));
    doc.undo();
    expect(events[0]!.inverseEdits).toHaveLength(1);
    doc.undo();
    expect(events[1]!.inverseEdits).toHaveLength(1);
    expect(doc.undo()).toBeUndefined();
  });

  test("defaults to a real system clock when none is injected", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "",
      sink,
      log,
    });
    typeChar(doc, "a", 0);
    expect(() => doc.undo()).not.toThrow();
  });
});

describe("createDocument — lineCount/getLine (core-internal, EditorView Req 6.5, 6.6)", () => {
  test("lineCount and getLine delegate to the internal LineBuffer", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "one\ntwo\nthree",
      sink,
      log,
    });
    expect(doc.lineCount).toBe(3);
    expect(doc.getLine(0)).toBe("one");
    expect(doc.getLine(1)).toBe("two");
    expect(doc.getLine(2)).toBe("three");
    expect(() => doc.getLine(3)).toThrow(RangeError);
  });

  test("lineCount and getLine reflect edits applied through applyEdits", () => {
    const { log, sink } = baseDeps();
    const doc = createDocument({
      uri: "file:///a.txt",
      languageId: "plaintext",
      text: "one\ntwo",
      sink,
      log,
    });
    doc.applyEdits([
      { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: "\nnew" },
    ]);
    expect(doc.lineCount).toBe(3);
    expect(doc.getLine(0)).toBe("one");
    expect(doc.getLine(1)).toBe("new");
    expect(doc.getLine(2)).toBe("two");
  });
});
