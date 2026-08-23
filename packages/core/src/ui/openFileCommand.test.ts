/**
 * Tests for {@link createOpenFileCommandHandler}/{@link registerOpenFileCommand}
 * (Task 3.2, Req 11.3) against fake `documents`/`editorSession` narrowed to
 * exactly the methods `OpenFileCommandDeps` declares — no real
 * `DocumentManager`/`EditorSessionService` needed.
 */

import { describe, expect, test } from "bun:test";
import type { HostError, HostLog, HostLogLevel } from "../host/errors";
import {
  createOpenFileCommandHandler,
  HIDDEN_FROM_LISTINGS_WHEN,
  OPEN_FILE_COMMAND_ID,
  registerOpenFileCommand,
  type OpenFileCommandDeps,
} from "./openFileCommand";

function createFakeLog(): HostLog & { entries(): readonly { level: HostLogLevel; error: HostError }[] } {
  const records: { level: HostLogLevel; error: HostError }[] = [];
  return {
    append(level, error) {
      records.push({ level, error });
    },
    entries() {
      return records;
    },
  };
}

function createFakeDeps(): OpenFileCommandDeps & {
  opened: string[];
  activeUri: string | undefined;
  log: ReturnType<typeof createFakeLog>;
  failNextOpen?: Error;
} {
  const opened: string[] = [];
  let activeUri: string | undefined;
  const log = createFakeLog();
  const state = {
    opened,
    get activeUri() {
      return activeUri;
    },
    log,
    failNextOpen: undefined as Error | undefined,
    documents: {
      async openDocument(uri: string) {
        if (state.failNextOpen) {
          const err = state.failNextOpen;
          state.failNextOpen = undefined;
          throw err;
        }
        opened.push(uri);
        return { uri } as never;
      },
    },
    editorSession: {
      setActiveDocumentUri(uri: string | undefined) {
        activeUri = uri;
      },
    },
  };
  return state;
}

describe("createOpenFileCommandHandler (Task 3.2, Req 11.3)", () => {
  test("opens the document then sets it active, in that order", async () => {
    const deps = createFakeDeps();
    const handler = createOpenFileCommandHandler(deps);

    await handler("file:///a.ts");

    expect(deps.opened).toEqual(["file:///a.ts"]);
    expect(deps.activeUri).toBe("file:///a.ts");
  });

  test("sequential calls each open-and-activate their own uri", async () => {
    const deps = createFakeDeps();
    const handler = createOpenFileCommandHandler(deps);

    await handler("file:///a.ts");
    await handler("file:///b.ts");

    expect(deps.opened).toEqual(["file:///a.ts", "file:///b.ts"]);
    expect(deps.activeUri).toBe("file:///b.ts");
  });

  test("a rejecting openDocument is caught and logged, never thrown", async () => {
    const deps = createFakeDeps();
    deps.failNextOpen = new Error("ENOENT");
    const handler = createOpenFileCommandHandler(deps);

    await expect(handler("file:///missing.ts")).resolves.toBeUndefined();
    expect(deps.activeUri).toBeUndefined();
    const entries = deps.log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.error.message).toContain("ENOENT");
  });

  test("no arguments is a tolerated no-op", async () => {
    const deps = createFakeDeps();
    const handler = createOpenFileCommandHandler(deps);

    await expect(handler()).resolves.toBeUndefined();
    expect(deps.opened).toEqual([]);
    expect(deps.activeUri).toBeUndefined();
    expect(deps.log.entries()).toHaveLength(1);
    expect(deps.log.entries()[0]!.level).toBe("warning");
  });

  test("a non-string argument is a tolerated no-op", async () => {
    const deps = createFakeDeps();
    const handler = createOpenFileCommandHandler(deps);

    await expect(handler(42)).resolves.toBeUndefined();
    await expect(handler(null)).resolves.toBeUndefined();
    await expect(handler({ uri: "file:///a.ts" })).resolves.toBeUndefined();
    expect(deps.opened).toEqual([]);
  });

  test("an empty string argument is a tolerated no-op", async () => {
    const deps = createFakeDeps();
    const handler = createOpenFileCommandHandler(deps);

    await expect(handler("")).resolves.toBeUndefined();
    expect(deps.opened).toEqual([]);
  });

  test("works with no log supplied at all", async () => {
    const deps = createFakeDeps();
    const handlerNoLog = createOpenFileCommandHandler({
      documents: deps.documents,
      editorSession: deps.editorSession,
    });
    await expect(handlerNoLog()).resolves.toBeUndefined();
    await expect(handlerNoLog("file:///a.ts")).resolves.toBeUndefined();
  });
});

describe("registerOpenFileCommand (Task 3.2, Req 11.3)", () => {
  test(`registers "${OPEN_FILE_COMMAND_ID}" directly on the given command registry`, async () => {
    const deps = createFakeDeps();
    const registered: Record<string, (...args: unknown[]) => unknown> = {};
    const commands = {
      register(id: string, handler: (...args: unknown[]) => unknown) {
        registered[id] = handler;
        return { dispose() {} };
      },
    };

    registerOpenFileCommand(commands, deps);

    expect(registered[OPEN_FILE_COMMAND_ID]).toBeDefined();
    await registered[OPEN_FILE_COMMAND_ID]!("file:///a.ts");
    expect(deps.opened).toEqual(["file:///a.ts"]);
    expect(deps.activeUri).toBe("file:///a.ts");
  });

  test("registers with meta.when set to HIDDEN_FROM_LISTINGS_WHEN, so a when-filtered listing hides it", () => {
    const deps = createFakeDeps();
    let capturedMeta: { title?: string; category?: string; when?: string } | undefined;
    const commands = {
      register(
        _id: string,
        _handler: (...args: unknown[]) => unknown,
        meta?: { title?: string; category?: string; when?: string },
      ) {
        capturedMeta = meta;
        return { dispose() {} };
      },
    };

    registerOpenFileCommand(commands, deps);

    expect(capturedMeta?.when).toBe(HIDDEN_FROM_LISTINGS_WHEN);
    expect(capturedMeta?.title).toBeUndefined();
  });
});
