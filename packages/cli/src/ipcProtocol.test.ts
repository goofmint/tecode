/**
 * Tests for `ipcProtocol.ts` (Issue #158) — the wire format of the
 * single-instance channel. Pure functions, so no socket, no filesystem and
 * no fakes are involved at all.
 *
 * The rejection cases matter more than the happy path here: this parser is
 * the security boundary between the editor and every program the user runs
 * in the integrated terminal (that module's TSDoc), so each "must be
 * refused" case is pinned individually rather than lumped into one
 * assertion.
 */

import { describe, expect, test } from "bun:test";
import {
  encodeIpcMessage,
  parseIpcRequest,
  parseIpcResponse,
  takeCompleteLines,
  IPC_PROTOCOL_VERSION,
} from "./ipcProtocol";

/** A well-formed request line, as the client would actually send it. */
function validRequestLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: IPC_PROTOCOL_VERSION,
    type: "open",
    path: "/abs/file.ts",
    cwd: "/abs",
    ...overrides,
  });
}

describe("parseIpcRequest — accepted", () => {
  test("a well-formed open request round-trips", () => {
    expect(parseIpcRequest(validRequestLine())).toEqual({
      v: IPC_PROTOCOL_VERSION,
      type: "open",
      path: "/abs/file.ts",
      cwd: "/abs",
      wait: false,
    });
  });

  test("wait: true survives", () => {
    expect(parseIpcRequest(validRequestLine({ wait: true }))?.wait).toBe(true);
  });

  test("unknown extra fields are ignored, not rejected — a newer client stays usable", () => {
    const parsed = parseIpcRequest(validRequestLine({ somethingNew: 1 }));
    expect(parsed?.path).toBe("/abs/file.ts");
  });

  test("what encodeIpcMessage writes is what parseIpcRequest reads", () => {
    const encoded = encodeIpcMessage({
      v: IPC_PROTOCOL_VERSION,
      type: "open",
      path: "/abs/file.ts",
      cwd: "/abs",
      wait: true,
    });
    expect(encoded.endsWith("\n")).toBe(true);
    const { lines } = takeCompleteLines(encoded);
    expect(parseIpcRequest(lines[0] ?? "")?.wait).toBe(true);
  });
});

describe("parseIpcRequest — refused", () => {
  test("a type other than 'open' is refused — the channel carries no commands", () => {
    // The whole security argument of Issue #158 rests on this line: an
    // accepted request can only ever mean "open this path".
    expect(parseIpcRequest(validRequestLine({ type: "exec" }))).toBeUndefined();
    expect(parseIpcRequest(validRequestLine({ type: "eval" }))).toBeUndefined();
    expect(parseIpcRequest(validRequestLine({ type: "spawn" }))).toBeUndefined();
  });

  test("a wrong or missing protocol version is refused", () => {
    expect(parseIpcRequest(validRequestLine({ v: 2 }))).toBeUndefined();
    expect(parseIpcRequest(JSON.stringify({ type: "open", path: "/a", cwd: "/" }))).toBeUndefined();
  });

  test("a relative or empty path is refused — the host resolves nothing itself", () => {
    expect(parseIpcRequest(validRequestLine({ path: "file.ts" }))).toBeUndefined();
    expect(parseIpcRequest(validRequestLine({ path: "" }))).toBeUndefined();
    expect(parseIpcRequest(validRequestLine({ path: 42 }))).toBeUndefined();
  });

  test("a non-string cwd or non-boolean wait is refused", () => {
    expect(parseIpcRequest(validRequestLine({ cwd: 7 }))).toBeUndefined();
    expect(parseIpcRequest(validRequestLine({ wait: "yes" }))).toBeUndefined();
  });

  test("malformed JSON, a non-object payload and an array are all refused without throwing", () => {
    expect(parseIpcRequest("{not json")).toBeUndefined();
    expect(parseIpcRequest('"a string"')).toBeUndefined();
    expect(parseIpcRequest("[1,2,3]")).toBeUndefined();
    expect(parseIpcRequest("null")).toBeUndefined();
    expect(parseIpcRequest("")).toBeUndefined();
  });

  test("the absolute-path rule is injectable, so the Windows shape can be checked on POSIX", () => {
    const windowsIsAbsolute = (path: string): boolean => /^[A-Za-z]:\\/.test(path);
    expect(parseIpcRequest(validRequestLine({ path: "C:\\\\src\\\\a.ts" }), windowsIsAbsolute)).toBeDefined();
    expect(parseIpcRequest(validRequestLine({ path: "/abs/file.ts" }), windowsIsAbsolute)).toBeUndefined();
  });
});

describe("parseIpcResponse", () => {
  test("reads ok and the optional error", () => {
    expect(parseIpcResponse(JSON.stringify({ v: 1, ok: true }))).toEqual({ v: 1, ok: true });
    expect(parseIpcResponse(JSON.stringify({ v: 1, ok: false, error: "nope" }))).toEqual({
      v: 1,
      ok: false,
      error: "nope",
    });
  });

  test("refuses a wrong version, a missing ok, and malformed JSON", () => {
    expect(parseIpcResponse(JSON.stringify({ v: 2, ok: true }))).toBeUndefined();
    expect(parseIpcResponse(JSON.stringify({ v: 1 }))).toBeUndefined();
    expect(parseIpcResponse("}{")).toBeUndefined();
  });
});

describe("takeCompleteLines", () => {
  test("returns only whole lines and keeps the partial tail for the next chunk", () => {
    expect(takeCompleteLines('{"a":1}\n{"b":2}\n{"c":')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c":',
    });
  });

  test("a chunk with no newline yields nothing yet", () => {
    expect(takeCompleteLines('{"a":')).toEqual({ lines: [], rest: '{"a":' });
  });

  test("blank lines and a trailing \\r are not mistaken for messages", () => {
    expect(takeCompleteLines('\n\n{"a":1}\r\n')).toEqual({ lines: ['{"a":1}'], rest: "" });
  });
});
