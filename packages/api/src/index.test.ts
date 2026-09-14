import { expect, test } from "bun:test";
import { API_VERSION } from "./index";

test("API_VERSION is the current major.minor version", () => {
  // 1.3 -> 1.4 (Issue #158): single-instance IPC added the optional
  // ExtensionContext.ipcSocketPath — purely additive, so the bump exists
  // to stop an extension that READS `ctx.ipcSocketPath` from registering
  // against a 1.3 host, where nothing ever sets it and the value would
  // silently always be undefined (index.ts's API_VERSION TSDoc explains
  // why this is a minor, not major, bump).
  expect(API_VERSION).toBe("1.4");
});

test("API_VERSION uses <major>.<minor> form", () => {
  expect(API_VERSION).toMatch(/^\d+\.\d+$/);
});
