import { expect, test } from "bun:test";
import { HOST_PLACEHOLDER } from "./index";

test("placeholder", () => {
  expect(HOST_PLACEHOLDER).toBe(true);
});
