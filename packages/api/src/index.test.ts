import { expect, test } from "bun:test";
import { API_VERSION } from "./index";

test("API_VERSION is the current major.minor version", () => {
  // 1.1 -> 1.2 (Issue #139, CodeRabbit PR #141): WorkspaceNamespace.save's
  // Promise<void> -> Promise<SaveOutcome> change, plus the new SaveOptions
  // parameter (index.ts's API_VERSION TSDoc explains why this is a minor,
  // not major, bump).
  expect(API_VERSION).toBe("1.2");
});

test("API_VERSION uses <major>.<minor> form", () => {
  expect(API_VERSION).toMatch(/^\d+\.\d+$/);
});
