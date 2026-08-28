import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createClipboard } from "./clipboard";

describe("createClipboard (Issue #91)", () => {
  test("read() starts empty", async () => {
    const clipboard = createClipboard();
    expect(await clipboard.read()).toBe("");
  });

  test("write() then read() round-trips through the internal buffer, with no system writer wired", async () => {
    const clipboard = createClipboard();
    await clipboard.write("hello");
    expect(await clipboard.read()).toBe("hello");
  });

  test("write() calls the injected system writer with the same text when sync is enabled (the default)", async () => {
    const clipboard = createClipboard();
    const calls: string[] = [];
    clipboard.setSystemWriter((text) => {
      calls.push(text);
      return true;
    });

    await clipboard.write("copied text");

    expect(calls).toEqual(["copied text"]);
    expect(await clipboard.read()).toBe("copied text");
  });

  test("setSystemClipboardEnabled(false) updates the internal buffer but never calls the system writer", async () => {
    const clipboard = createClipboard();
    let calls = 0;
    clipboard.setSystemWriter(() => {
      calls++;
      return true;
    });
    clipboard.setSystemClipboardEnabled(false);

    await clipboard.write("still buffered");

    expect(calls).toBe(0);
    expect(await clipboard.read()).toBe("still buffered");
  });

  test("setSystemWriter(undefined) clears the writer — write() still resolves and updates the buffer", async () => {
    const clipboard = createClipboard();
    clipboard.setSystemWriter(() => true);
    clipboard.setSystemWriter(undefined);

    await expect(clipboard.write("x")).resolves.toBeUndefined();
    expect(await clipboard.read()).toBe("x");
  });

  test("an OSC 52 write that THROWS is logged, swallowed, and write() still resolves with the buffer updated", async () => {
    const log = createHostLog();
    const clipboard = createClipboard({ log });
    clipboard.setSystemWriter(() => {
      throw new Error("terminal escape sequence rejected");
    });

    await expect(clipboard.write("payload")).resolves.toBeUndefined();

    expect(await clipboard.read()).toBe("payload");
    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("warning");
    expect(entries[0]!.error.message).toContain("terminal escape sequence rejected");
  });

  test("an OSC 52 write that returns false (not thrown) is logged as a not-accepted warning, write() still resolves", async () => {
    const log = createHostLog();
    const clipboard = createClipboard({ log });
    clipboard.setSystemWriter(() => false);

    await expect(clipboard.write("payload")).resolves.toBeUndefined();

    expect(await clipboard.read()).toBe("payload");
    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("warning");
    expect(entries[0]!.error.message).toContain("not accepted");
  });

  test("with no `log` supplied, a throwing writer is still swallowed silently — write() never rejects", async () => {
    const clipboard = createClipboard();
    clipboard.setSystemWriter(() => {
      throw new Error("boom");
    });
    await expect(clipboard.write("x")).resolves.toBeUndefined();
    expect(await clipboard.read()).toBe("x");
  });

  test("later write()s update the buffer, always reflecting the most recent value", async () => {
    const clipboard = createClipboard();
    await clipboard.write("first");
    await clipboard.write("second");
    expect(await clipboard.read()).toBe("second");
  });
});
