import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeEvent } from "@tecode/api";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import { createFileSystem } from "./fileSystem";
import { pathToUri } from "./uri";

/** Poll `predicate` until it is true or `timeoutMs` elapses (matches
 * `config/service.test.ts`'s `waitFor` — real `fs.watch` delivery is not
 * synchronous). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("createFileSystem", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("write then read round-trips bytes", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-fs-"));
    const fs = createFileSystem();
    const uri = pathToUri(join(dir, "hello.txt"));

    await fs.write(uri, new TextEncoder().encode("hello, tecode"));
    const bytes = await fs.read(uri);

    expect(new TextDecoder().decode(bytes)).toBe("hello, tecode");
  });

  test("stat reports type/size/mtime/ctime for a file", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-fs-"));
    const fs = createFileSystem();
    const filePath = join(dir, "file.txt");
    await nodeWriteFile(filePath, "0123456789", "utf8");

    const stat = await fs.stat(pathToUri(filePath));

    expect(stat.type).toBe("file");
    expect(stat.size).toBe(10);
    expect(typeof stat.mtime).toBe("number");
    expect(typeof stat.ctime).toBe("number");
  });

  test("stat reports type 'directory' for a directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-fs-"));
    const fs = createFileSystem();

    const stat = await fs.stat(pathToUri(dir));

    expect(stat.type).toBe("directory");
  });

  test("readdir lists entries with name and type", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-fs-"));
    await nodeWriteFile(join(dir, "a.txt"), "a", "utf8");
    await mkdir(join(dir, "sub"));
    const fs = createFileSystem();

    const entries = await fs.readdir(pathToUri(dir));

    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ name: "a.txt", type: "file" });
    expect(entries).toContainEqual({ name: "sub", type: "directory" });
  });

  test("read rejects for a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-fs-"));
    const fs = createFileSystem();

    await expect(fs.read(pathToUri(join(dir, "missing.txt")))).rejects.toThrow();
  });

  describe("watch — real fs.watch integration (design.md §16)", () => {
    test("reports a 'changed' event when a watched file is modified", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-fs-watch-"));
      const filePath = join(dir, "watched.txt");
      await nodeWriteFile(filePath, "v1", "utf8");
      const fs = createFileSystem();

      const events: FileChangeEvent[] = [];
      const sub = fs.watch(pathToUri(filePath), (e) => events.push(e));
      try {
        await nodeWriteFile(filePath, "v2", "utf8");
        await waitFor(() => events.length > 0);
        expect(events.some((e) => e.type === "changed" || e.type === "created")).toBe(true);
      } finally {
        sub.dispose();
      }
    }, 10_000);

    test("reports a 'created' event for a new file inside a watched directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-fs-watch-"));
      const fs = createFileSystem();
      const events: FileChangeEvent[] = [];
      const sub = fs.watch(pathToUri(dir), (e) => events.push(e));
      try {
        await nodeWriteFile(join(dir, "new.txt"), "hi", "utf8");
        await waitFor(() => events.some((e) => e.type === "created"));
        expect(events.some((e) => e.uri === pathToUri(join(dir, "new.txt")))).toBe(true);
      } finally {
        sub.dispose();
      }
    }, 10_000);

    test("reports a 'deleted' event for a removed file inside a watched directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-fs-watch-"));
      const filePath = join(dir, "doomed.txt");
      await nodeWriteFile(filePath, "bye", "utf8");
      const fs = createFileSystem();
      const events: FileChangeEvent[] = [];
      const sub = fs.watch(pathToUri(dir), (e) => events.push(e));
      try {
        await rm(filePath);
        await waitFor(() => events.some((e) => e.type === "deleted"));
      } finally {
        sub.dispose();
      }
    }, 10_000);

    test("dispose is idempotent and stops delivering events", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-fs-watch-"));
      const filePath = join(dir, "watched.txt");
      await nodeWriteFile(filePath, "v1", "utf8");
      const fs = createFileSystem();
      const events: FileChangeEvent[] = [];
      const sub = fs.watch(pathToUri(filePath), (e) => events.push(e));

      sub.dispose();
      sub.dispose(); // must not throw

      await nodeWriteFile(filePath, "v2", "utf8");
      // Give a real watcher a moment to (not) fire — there is nothing to
      // poll for on the "it never happens" side, so a short fixed wait is
      // the pragmatic choice here.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events).toHaveLength(0);
    });

    test("a throwing listener is caught and logged, not thrown", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-fs-watch-"));
      const filePath = join(dir, "watched.txt");
      await nodeWriteFile(filePath, "v1", "utf8");
      const log = createHostLog();
      const fs = createFileSystem({ log });

      const sub = fs.watch(pathToUri(filePath), () => {
        throw new Error("listener boom");
      });
      try {
        await nodeWriteFile(filePath, "v2", "utf8");
        await waitFor(() =>
          log.entries().some((e: { error: HostError }) => e.error.message.includes("listener boom")),
        );
      } finally {
        sub.dispose();
      }
    }, 10_000);

    test("watching a path that does not exist does not throw and returns a disposable no-op", () => {
      const fs = createFileSystem();
      const sub = fs.watch(pathToUri("/nonexistent/path/for/tecode/tests"), () => {});
      expect(() => sub.dispose()).not.toThrow();
    });
  });
});
