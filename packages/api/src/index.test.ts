import { expect, test } from "bun:test";
import { API_VERSION } from "./index";

test("API_VERSION is the current major.minor version", () => {
  expect(API_VERSION).toBe("1.0");
});

test("API_VERSION uses <major>.<minor> form", () => {
  expect(API_VERSION).toMatch(/^\d+\.\d+$/);
});
