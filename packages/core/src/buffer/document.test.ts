import { describe, expect, test } from "bun:test";
import type { DocumentChangeEvent, Eol, TextEdit } from "@tecode/api";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import { createDocument } from "./document";

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

    expect(events[0]!.dirtyRange).toEqual({ startLine: 1, endLine: 1 });
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

    expect(events[0]!.dirtyRange).toEqual({ startLine: 1, endLine: 3 });
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
