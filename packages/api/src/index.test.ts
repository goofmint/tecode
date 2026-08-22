import { expect, test } from "bun:test";
import { API_PLACEHOLDER } from "./index";

test("placeholder", () => {
  expect(API_PLACEHOLDER).toBe(true);
});
