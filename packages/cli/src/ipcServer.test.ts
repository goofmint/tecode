/**
 * Tests for `ipcServer.ts` (Issue #158) against a REAL Unix domain socket
 * in a temp directory, with hand-rolled fakes for the two collaborators it
 * reaches into (the command registry and the document manager). A real
 * socket is the point here: the permission modes, the unlink-on-dispose and
 * the newline framing are all properties of the actual OS resource, and a
 * fake `Bun.listen` would prove none of them.
 *
 * The client half is the real `delegateOpen` (`ipcClient.ts`), so these
 * double as the end-to-end proof that the two sides agree on the wire
 * format.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable, Listener } from "@tecode/api";
import { createHostLog, pathToUri, type CoreDocument } from "@tecode/core";
import { createIpcServer, type IpcServer } from "./ipcServer";
import { delegateOpen } from "./ipcClient";
import { encodeIpcMessage, IPC_PROTOCOL_VERSION } from "./ipcProtocol";

/** Everything one test allocates, torn down by the shared `afterEach` so a
 * failing assertion can never leave a listener (and therefore a live
 * socket) behind. */
const openServers: IpcServer[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of openServers.splice(0)) server.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake document manager: `documents` is what the server consults to
 * decide whether a `wait` request has anything to wait FOR, and
 * `fireClose` is how a test plays the user closing the tab. */
function createFakeDocuments(): {
  documents: readonly CoreDocument[];
  onDidClose: (listener: Listener<CoreDocument>) => Disposable;
  open(uri: string): void;
  fireClose(uri: string): void;
  listenerCount(): number;
} {
  const open: string[] = [];
  const listeners = new Set<Listener<CoreDocument>>();
  return {
    get documents() {
      return open.map((uri) => ({ uri }) as CoreDocument);
    },
    onDidClose(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    open(uri) {
      open.push(uri);
    },
    fireClose(uri) {
      for (const listener of Array.from(listeners)) listener({ uri } as CoreDocument);
    },
    listenerCount: () => listeners.size,
  };
}

/** Build a live server on a fresh temp socket, plus the fakes a test
 * asserts against. `autoOpen` mirrors what the real
 * `workbench.action.files.openUri` does — it makes the requested document
 * actually open — so a `wait` request has something to wait for. */
function createHarness(options: { autoOpen?: boolean } = {}): {
  server: IpcServer;
  socketPath: string;
  executed: { id: string; args: unknown[] }[];
  documents: ReturnType<typeof createFakeDocuments>;
  log: ReturnType<typeof createHostLog>;
} {
  const dir = mkdtempSync(join(tmpdir(), "tecode-ipc-test-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "sockets", "1.sock");
  const executed: { id: string; args: unknown[] }[] = [];
  const documents = createFakeDocuments();
  const log = createHostLog();
  const server = createIpcServer({
    socketPath,
    commands: {
      execute(id, ...args) {
        executed.push({ id, args });
        if (options.autoOpen === true && typeof args[0] === "string") documents.open(args[0]);
        return Promise.resolve(undefined);
      },
    },
    documents,
    log,
  });
  openServers.push(server);
  return { server, socketPath, executed, documents, log };
}

/** Talk to `socketPath` at the raw-bytes level — for the cases
 * `delegateOpen` would never produce (a hostile or simply wrong peer).
 * Resolves the first line the server wrote back within `graceMs`, or
 * `undefined` if it said nothing at all.
 *
 * Deliberately decided by a short grace period rather than by the socket's
 * own `close` event: Bun's client-socket callbacks are not reliably ordered
 * for a connection this short-lived (`ipcClient.ts`'s `bunConnect` TSDoc
 * covers the same quirk), and a raw probe that gave up the moment `close`
 * arrived would report "no answer" for an answer that had in fact already
 * been written. */
async function sendRaw(socketPath: string, payload: string, graceMs = 300): Promise<string | undefined> {
  let received = "";
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open() {
        // Declared for the event-ordering reason above.
      },
      data(_socket, chunk) {
        received += chunk.toString();
      },
      close() {
        // Handled by the grace period below.
      },
      error() {
        // Likewise — an error just means no answer arrives.
      },
    },
  });
  socket.write(payload);
  await Bun.sleep(graceMs);
  socket.end();
  const trimmed = received.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

describe("createIpcServer — lifecycle and permissions", () => {
  test("listens on the requested path and reports it", () => {
    const { server, socketPath } = createHarness();
    expect(server.socketPath).toBe(socketPath);
  });

  test("the socket is 0600 and its directory 0700 — nobody else on the box can connect", () => {
    // The whole security argument of Issue #158's socket half: this channel
    // can open arbitrary files in the user's editor, so it must not be
    // reachable by another account.
    const { socketPath } = createHarness();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(socketPath, "..")).mode & 0o777).toBe(0o700);
  });

  test("dispose() unlinks the socket and is idempotent", () => {
    const { server, socketPath } = createHarness();
    server.dispose();
    expect(() => statSync(socketPath)).toThrow();
    expect(() => server.dispose()).not.toThrow();
  });

  test("a path that cannot be listened on degrades to socketPath: undefined instead of throwing", () => {
    const log = createHostLog();
    const documents = createFakeDocuments();
    const server = createIpcServer({
      // A directory component that is not a directory — `mkdir` fails, so
      // the whole channel must fail-safe rather than abort startup.
      socketPath: join("/dev/null", "nested", "1.sock"),
      commands: { execute: () => Promise.resolve(undefined) },
      documents,
      log,
    });
    expect(server.socketPath).toBeUndefined();
    expect(log.entries().some((entry) => entry.error.message.includes("could not listen"))).toBe(true);
    expect(() => server.dispose()).not.toThrow();
  });

  test("a leftover socket file at the same path (a recycled pid) does not block startup", () => {
    const { server, socketPath, documents, log } = createHarness();
    // The first server is still holding the file; a second one at the same
    // path must reclaim it rather than fail.
    const second = createIpcServer({
      socketPath,
      commands: { execute: () => Promise.resolve(undefined) },
      documents,
      log,
    });
    openServers.push(second);
    expect(second.socketPath).toBe(socketPath);
    server.dispose();
  });
});

describe("createIpcServer — open requests", () => {
  test("an open request runs workbench.action.files.openUri with the path's uri", async () => {
    const { socketPath, executed } = createHarness();
    const delegated = await delegateOpen(
      { socketPath, path: "/abs/file.ts", wait: false },
      { cwd: "/abs" },
    );
    expect(delegated).toBe(true);
    expect(executed).toEqual([
      { id: "workbench.action.files.openUri", args: [pathToUri("/abs/file.ts")] },
    ]);
  });

  test("two requests on one connection are both handled (newline framing)", async () => {
    const { socketPath, executed } = createHarness();
    const line = (path: string): string =>
      encodeIpcMessage({ v: IPC_PROTOCOL_VERSION, type: "open", path, cwd: "/abs" });
    await sendRaw(socketPath, line("/abs/a.ts") + line("/abs/b.ts"));
    // The first answer arrives as soon as the first request is handled; the
    // second may land after `sendRaw` has already closed, so poll.
    const deadline = Date.now() + 1_000;
    while (executed.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(executed.map((call) => call.args[0])).toEqual([
      pathToUri("/abs/a.ts"),
      pathToUri("/abs/b.ts"),
    ]);
  });

  test("a request for any type other than 'open' executes nothing and is refused", async () => {
    const { socketPath, executed } = createHarness();
    const answer = await sendRaw(
      socketPath,
      `${JSON.stringify({ v: 1, type: "exec", path: "/abs/x", cwd: "/abs", cmd: "rm -rf /" })}\n`,
    );
    expect(answer).toBe(JSON.stringify({ v: 1, ok: false, error: "unsupported request" }));
    expect(executed).toEqual([]);
  });

  test("malformed JSON executes nothing, is refused, and does not kill the server", async () => {
    const { socketPath, executed, server } = createHarness();
    expect(await sendRaw(socketPath, "{ this is not json\n")).toContain('"ok":false');
    expect(executed).toEqual([]);
    expect(server.socketPath).toBe(socketPath);
    // Still usable afterwards — one bad peer must not take the channel down.
    expect(await delegateOpen({ socketPath, path: "/abs/file.ts", wait: false })).toBe(true);
    expect(executed).toHaveLength(1);
  });
});

describe("createIpcServer — wait: true", () => {
  test("holds the response until the opened document is closed again", async () => {
    const { socketPath, documents } = createHarness({ autoOpen: true });
    const pending = delegateOpen({ socketPath, path: "/abs/file.ts", wait: true }, { cwd: "/abs" });

    // Give the request time to be handled; it must NOT have answered yet.
    await Bun.sleep(50);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    documents.fireClose(pathToUri("/abs/file.ts"));
    expect(await pending).toBe(true);
    // The subscription is released once it has fired — no listener leak.
    expect(documents.listenerCount()).toBe(0);
  });

  test("closing a DIFFERENT document does not release the waiting client", async () => {
    const { socketPath, documents } = createHarness({ autoOpen: true });
    const pending = delegateOpen({ socketPath, path: "/abs/file.ts", wait: true });
    await Bun.sleep(50);

    documents.fireClose(pathToUri("/abs/other.ts"));
    await Bun.sleep(20);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    documents.fireClose(pathToUri("/abs/file.ts"));
    expect(await pending).toBe(true);
  });

  test("answers immediately when the document never actually opened — a client must never hang", async () => {
    // `autoOpen` is off, so the (faked) open command changed nothing: there
    // is no document whose close could ever arrive.
    const { socketPath, documents } = createHarness();
    expect(await delegateOpen({ socketPath, path: "/abs/file.ts", wait: true })).toBe(true);
    expect(documents.listenerCount()).toBe(0);
  });

  test("dispose() releases every still-pending waiter instead of leaving it hanging", async () => {
    const { socketPath, server } = createHarness({ autoOpen: true });
    const pending = delegateOpen({ socketPath, path: "/abs/file.ts", wait: true });
    await Bun.sleep(50);
    server.dispose();
    expect(await pending).toBe(true);
  });
});
