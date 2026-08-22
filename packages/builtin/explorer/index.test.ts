import { expect, test } from "bun:test";
import { EXPLORER_PLACEHOLDER } from "./index";

test("placeholder", () => {
  expect(EXPLORER_PLACEHOLDER).toBe(true);
});
