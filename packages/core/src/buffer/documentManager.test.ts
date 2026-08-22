import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod as fsChmod,
  mkdtemp,
  symlink,
  open,
  readdir,
  readFile,
  rename as fsRename,
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
      writeFile: (p, data, opts) => fsWriteFile(p, data, opts),
      chmod: (p, mode) => fsChmod(p, mode),
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
    doc.onDidChange(() => order.push("change"));
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "changed",
      },
    ]);
    await manager.save(uri);
    manager.close(uri);

    expect(order).toEqual(["open", "change", "save", "close"]);
  });
});

describe("DocumentManager — concurrency (review regressions)", () => {
  test("two concurrent opens of the same uri share one instance and fire onDidOpen once", async () => {
    const path = join(dir, "concurrent.txt");
    await writeFile(path, "text", "utf8");
    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });

    const opened: string[] = [];
    manager.onDidOpen((d) => opened.push(d.uri));

    const uri = pathToUri(path);
    const [a, b] = await Promise.all([
      manager.openDocument(uri),
      manager.openDocument(uri),
    ]);

    expect(a).toBe(b);
    expect(opened).toEqual([uri]);
    expect(manager.documents).toHaveLength(1);
  });

  test("an edit landing during an in-flight save keeps the document dirty", async () => {
    const path = join(dir, "race.txt");
    await writeFile(path, "original", "utf8");
    const { log, sink } = baseDeps();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeReached!: () => void;
    const reachedWrite = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const gatedFs: DocumentManagerFs = {
      stat: (p) => fsStat(p),
      readFile: (p, enc) => readFile(p, enc),
      writeFile: async (p, data, opts) => {
        writeReached();
        await writeGate;
        await fsWriteFile(p, data, opts);
      },
      chmod: (p, mode) => fsChmod(p, mode),
      rename: (from, to) => fsRename(from, to),
      unlink: (p) => fsUnlink(p),
    };

    const manager = createDocumentManager({ log, sink, fs: gatedFs });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "first",
      },
    ]);

    // The save snapshots "first" and stalls inside writeFile — wait
    // deterministically for it to reach the gate, then land a second edit
    // while the bytes are in flight.
    const pendingSave = manager.save(uri);
    await reachedWrite;
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
        newText: "!",
      },
    ]);
    releaseWrite();
    const ok = await pendingSave;

    expect(ok).toBe(true);
    // The newest edit is not in the saved bytes, so the document must
    // still read as unsaved.
    expect(doc.dirty).toBe(true);
    expect(doc.getText()).toBe("first!");
    expect(await readFile(path, "utf8")).toBe("first");
  });
});

describe("DocumentManager.save — permission preservation (review nitpick)", () => {
  test("save preserves the target file's mode across the atomic rename", async () => {
    const path = join(dir, "script.sh");
    await writeFile(path, "echo hi", "utf8");
    await fsChmod(path, 0o755);

    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        newText: "echo bye",
      },
    ]);

    expect(await manager.save(uri)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("echo bye");
    // The executable bit survives the temp-file rename.
    expect((await fsStat(path)).mode & 0o777).toBe(0o755);
  });
});

describe("DocumentManager.save — hardening (review regressions)", () => {
  test("a stat failure other than ENOENT aborts the save, reports, and keeps dirty", async () => {
    const path = join(dir, "iofail.txt");
    await writeFile(path, "original", "utf8");
    const { log, sink, errors } = baseDeps();

    let failStat = false;
    const ioFs: DocumentManagerFs = {
      stat: async (p) => {
        if (failStat) {
          throw Object.assign(new Error("disk read failure"), { code: "EIO" });
        }
        return fsStat(p);
      },
      readFile: (p, enc) => readFile(p, enc),
      writeFile: (p, data, opts) => fsWriteFile(p, data, opts),
      chmod: (p, mode) => fsChmod(p, mode),
      rename: (from, to) => fsRename(from, to),
      unlink: (p) => fsUnlink(p),
    };

    const manager = createDocumentManager({ log, sink, fs: ioFs });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "modified",
      },
    ]);

    failStat = true;
    const saved: string[] = [];
    manager.onDidSave(() => saved.push("fired"));

    expect(await manager.save(uri)).toBe(false);
    expect(doc.dirty).toBe(true);
    expect(saved).toHaveLength(0);
    expect(errors.at(-1)!.message).toContain("disk read failure");
    expect(await readFile(path, "utf8")).toBe("original");
  });

  test("a symlink squatting the predictable temp name cannot redirect the write", async () => {
    const path = join(dir, "target.txt");
    await writeFile(path, "original", "utf8");
    const victimPath = join(dir, "victim.txt");
    await writeFile(victimPath, "untouched", "utf8");

    // Squat the first temp name a fresh manager would use with a symlink
    // to the victim: exclusive creation must refuse it and retry under a
    // different name instead of writing through the link.
    const squattedTemp = join(dir, `.target.txt.tmp-${process.pid}-0`);
    await symlink(victimPath, squattedTemp);

    const { log, sink } = baseDeps();
    const manager = createDocumentManager({ log, sink });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "modified",
      },
    ]);

    expect(await manager.save(uri)).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(await readFile(path, "utf8")).toBe("modified");
    expect(await readFile(victimPath, "utf8")).toBe("untouched");
  });

  test("saves of the same uri are serialized: an older snapshot can never clobber a newer one", async () => {
    const path = join(dir, "serial.txt");
    await writeFile(path, "original", "utf8");
    const { log, sink } = baseDeps();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeReached!: () => void;
    const reachedWrite = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    let gateArmed = true;
    const gatedFs: DocumentManagerFs = {
      stat: (p) => fsStat(p),
      readFile: (p, enc) => readFile(p, enc),
      writeFile: async (p, data, opts) => {
        if (gateArmed) {
          gateArmed = false;
          writeReached();
          await writeGate;
        }
        await fsWriteFile(p, data, opts);
      },
      chmod: (p, mode) => fsChmod(p, mode),
      rename: (from, to) => fsRename(from, to),
      unlink: (p) => fsUnlink(p),
    };

    const manager = createDocumentManager({ log, sink, fs: gatedFs });
    const uri = pathToUri(path);
    const doc = await manager.openDocument(uri);

    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "first",
      },
    ]);
    // save #1 stalls inside writeFile with snapshot "first" — wait
    // deterministically for it to reach the gate; a newer edit and save
    // #2 arrive while it is in flight.
    const p1 = manager.save(uri);
    await reachedWrite;
    doc.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "second",
      },
    ]);
    const p2 = manager.save(uri);
    releaseWrite();

    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    // save #2 ran strictly after save #1 finished, snapshotting the newest
    // text — the older snapshot can never end up as the final disk state.
    expect(await readFile(path, "utf8")).toBe("second");
    expect(doc.dirty).toBe(false);
  });
});
