import { expect, test } from "bun:test";
import { API_VERSION } from "./index";

test("API_VERSION is the current major.minor version", () => {
  // 1.0 -> 1.1 (Issue #103): UiNamespace.registerView's additive 4th
  // `options` parameter (index.ts's API_VERSION TSDoc explains why this is
  // a minor, not major, bump).
  expect(API_VERSION).toBe("1.1");
});

test("API_VERSION uses <major>.<minor> form", () => {
  expect(API_VERSION).toMatch(/^\d+\.\d+$/);
});
