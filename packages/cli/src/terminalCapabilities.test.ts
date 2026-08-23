import { expect, test } from "bun:test";
import { detectTerminalCapabilities } from "./terminalCapabilities";

test("returns fixed conservative defaults (real detection is Task 4.2)", () => {
  expect(detectTerminalCapabilities()).toEqual({
    kittyKeyboardProtocol: false,
    colorDepth: "truecolor",
  });
});

test("is a pure, side-effect-free, never-throwing call", () => {
  expect(() => detectTerminalCapabilities()).not.toThrow();
  // Same result on every call — nothing here reads process state (yet).
  expect(detectTerminalCapabilities()).toEqual(detectTerminalCapabilities());
});
