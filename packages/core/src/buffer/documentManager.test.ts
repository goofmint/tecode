import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import {
  createDocumentManager,
  LARGE_FILE_THRESHOLD_BYTES,
  type DocumentManagerFs,
} from "./documentManager";
import { pathToUri, uriToPath } from "./uri";

/** A {@link StatusSink} stub that records every error it receives, for
 * assertions (matches document.test.ts's `createRecordingSink`). */
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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tecode-doc-manager-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("uriToPath / pathToUri round-trip", () => {
  test("path -> uri -> path returns the original absolute path", () => {
    const path = join(dir, "a.txt");
    const uri = pathToUri(path);
    expect(uri.startsWith("file://")).toBe(true);
    expect(uriToPath(uri)).toBe(path);
  });

  test("uriToPath throws TypeError on a malformed URI (programmer error)", () => {
    expect(() => uriToPath("not-a-uri")).toThrow(TypeError);
    expect(() => uriToPath("http://example.com/a.txt")).toThrow(TypeError);
  });
});

describe("DocumentManager.openDocument (Req 5.5)", () => {
  test("opens a normal file writable, with resolved languageId and onLanguageActivation firing", async () => {
    const path = join(dir, "hello.ts");
    await writeFile(path, "const x = 1;\n", "utf8");
    const { log, sink } = baseDeps();
    const activated: string[] = [];
    const manager = createDocumentManager({
      log,
      sink,
      resolveLanguageId: () => "typescript",
      onLanguageActivation: (languageId) => activated.push(languageId),
    });

    const doc = await manager.openDocument(pathToUri(path));
    expect(doc.readonly).toBe(false);
    expect(doc.languageId).toBe("typescript");
    expect(doc.getText()).toBe("const x = 1;\n");
    expect(activated).toEqual(["typescript"]);
  });

  test("defaults resolveLanguageId to plaintext when none is injected (Req 8.3 stub)", async () => {
    const path = join(dir, "plain.txt");
    await writeFile(path, "hi", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const doc = await manager.openDocument(pathToUri(path));
    expect(doc.languageId).toBe("plaintext");
  });

  test("a file at or above the 10 MB threshold opens readonly", async () => {
    const path = join(dir, "big.txt");
    // Write just over the threshold quickly, without allocating a huge
    // string: a repeated small chunk.
    const chunk = "x".repeat(1024 * 1024); // 1 MB of 'x'
    const handle = await open(path, "w");
    try {
      for (let i = 0; i < 11; i++) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });
    const doc = await manager.openDocument(pathToUri(path));
    expect(doc.readonly).toBe(true);
  }, 20000);

  test("a file just under the threshold opens writable", async () => {
    const path = join(dir, "notbig.txt");
    const text = "y".repeat(LARGE_FILE_THRESHOLD_BYTES - 1024);
    await writeFile(path, text, "utf8");

    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });
    const doc = await manager.openDocument(pathToUri(path));
    expect(doc.readonly).toBe(false);
  }, 20000);

  test("opening the same uri twice returns the same instance (dedupe)", async () => {
    const path = join(dir, "dup.txt");
    await writeFile(path, "content", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const uri = pathToUri(path);
    const a = await manager.openDocument(uri);
    const b = await manager.openDocument(uri);
    expect(a).toBe(b);
    expect(manager.documents).toHaveLength(1);
  });

  test("opening a nonexistent file rejects the promise AND reports through log/sink", async () => {
    const path = join(dir, "missing.txt");
    const { log, sink, errors } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    await expect(manager.openDocument(pathToUri(path))).rejects.toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(pathToUri(path));
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries).toHaveLength(1);
    expect(manager.documents).toHaveLength(0);
  });

  test("a throwing onLanguageActivation callback does not break open", async () => {
    const path = join(dir, "ok.txt");
    await writeFile(path, "text", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({
      log,
      sink,
      onLanguageActivation: () => {
        throw new Error("activation boom");
      },
    });

    const doc = await manager.openDocument(pathToUri(path));
    expect(doc).toBeDefined();
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries.some((e) => e.error.message.includes("activation boom"))).toBe(true);
  });

  test("fires onDidOpen exactly once per new open", async () => {
    const path = join(dir, "events.txt");
    await writeFile(path, "text", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const opened: string[] = [];
    manager.onDidOpen((doc) => opened.push(doc.uri));

    const uri = pathToUri(path);
    await manager.openDocument(uri);
    await manager.openDocument(uri); // dedupe: no second event
    expect(opened).toEqual([uri]);
  });
});

describe("DocumentManager.save (Req 5.5)", () => {
  test("writes atomically and clears dirty, firing onDidSave", async () => {
    const path = join(dir, "save.txt");
    await writeFile(path, "original", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "changed",
      },
    ]);
    expect(doc.dirty).toBe(true);

    const saved: string[] = [];
    manager.onDidSave((d) => saved.push(d.uri));

    const ok = await manager.save(uri);
    expect(ok).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(saved).toEqual([uri]);

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("changed");

    // No stray temp file left behind.
    const entries = await readdir(dir);
    expect(entries).toEqual(["save.txt"]);
  });

  test("saving an unopened uri is a no-op reported through the sink, no event", async () => {
    const path = join(dir, "never-opened.txt");
    const { log, sink, errors } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const saved: string[] = [];
    manager.onDidSave(() => saved.push("fired"));

    const ok = await manager.save(pathToUri(path));
    expect(ok).toBe(false);
    expect(saved).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test("saving a readonly document is a no-op reported through the sink, no event", async () => {
    const path = join(dir, "big-readonly.txt");
    const text = "z".repeat(LARGE_FILE_THRESHOLD_BYTES + 1024);
    await writeFile(path, text, "utf8");
    const { log, sink, errors } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    expect(doc.readonly).toBe(true);

    const saved: string[] = [];
    manager.onDidSave(() => saved.push("fired"));

    const ok = await manager.save(uri);
    expect(ok).toBe(false);
    expect(saved).toHaveLength(0);
    expect(errors).toHaveLength(1);
  }, 20000);

  test("a rename failure leaves no partial file, reports to the sink, and keeps dirty true", async () => {
    const path = join(dir, "willfail.txt");
    await writeFile(path, "original", "utf8");
    const { log, sink, errors } = baseDeps();

    const realFs: DocumentManagerFs = {
      stat: (p) => fsStat(p),
      readFile: (p, enc) => readFile(p, enc),
      writeFile: (p, data, enc) => fsWriteFile(p, data, enc),
      rename: async () => {
        throw new Error("simulated rename failure");
      },
      unlink: (p) => fsUnlink(p),
    };

    const manager = createDocumentManager({ log, sink, fs: realFs });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "modified",
      },
    ]);

    const saved: string[] = [];
    manager.onDidSave(() => saved.push("fired"));

    const ok = await manager.save(uri);
    expect(ok).toBe(false);
    expect(doc.dirty).toBe(true);
    expect(saved).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.at(-1)!.message).toContain("simulated rename failure");
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);

    // No temp file left behind, and the original file is untouched.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["willfail.txt"]);
    expect(await readFile(path, "utf8")).toBe("original");
  });
});

describe("DocumentManager.close", () => {
  test("removes the document and fires onDidClose", async () => {
    const path = join(dir, "close.txt");
    await writeFile(path, "text", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const uri = pathToUri(path);
    await manager.openDocument(uri);
    expect(manager.documents).toHaveLength(1);

    const closed: string[] = [];
    manager.onDidClose((d) => closed.push(d.uri));

    manager.close(uri);
    expect(manager.documents).toHaveLength(0);
    expect(closed).toEqual([uri]);
  });

  test("closing an unknown uri is a safe no-op", () => {
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });
    expect(() => manager.close("file:///nowhere.txt")).not.toThrow();
  });
});

describe("DocumentManager — open -> change -> save -> close event ordering", () => {
  test("events fire in the expected order with the expected payload", async () => {
    const path = join(dir, "lifecycle.txt");
    await writeFile(path, "start", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const order: string[] = [];
    manager.onDidOpen(() => order.push("open"));
    manager.onDidSave(() => order.push("save"));
    manager.onDidClose(() => order.push("close"));

    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "changed",
      },
    ]);
    await manager.save(uri);
    manager.close(uri);

    expect(order).toEqual(["open", "save", "close"]);
  });
});
