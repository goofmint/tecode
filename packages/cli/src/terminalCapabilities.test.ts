import { afterEach, beforeEach, expect, test } from "bun:test";
import { detectTerminalCapabilities } from "./terminalCapabilities";

const ENV_KEYS = ["COLORTERM", "TERM"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as typeof saved;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(colorTerm: string | undefined, term: string | undefined): void {
  if (colorTerm === undefined) delete process.env["COLORTERM"];
  else process.env["COLORTERM"] = colorTerm;
  if (term === undefined) delete process.env["TERM"];
  else process.env["TERM"] = term;
}

test("kittyKeyboardProtocol is always the fixed conservative default (real detection is Task 4.2)", () => {
  setEnv(undefined, undefined);
  expect(detectTerminalCapabilities().kittyKeyboardProtocol).toBe(false);
});

test("COLORTERM=truecolor detects truecolor (Req 7.4)", () => {
  setEnv("truecolor", "xterm-256color");
  expect(detectTerminalCapabilities().colorDepth).toBe("truecolor");
});

test("COLORTERM=24bit also detects truecolor", () => {
  setEnv("24bit", undefined);
  expect(detectTerminalCapabilities().colorDepth).toBe("truecolor");
});

test("COLORTERM matching is case-insensitive", () => {
  setEnv("TrueColor", undefined);
  expect(detectTerminalCapabilities().colorDepth).toBe("truecolor");
});

test("no COLORTERM but TERM contains 256color detects 256", () => {
  setEnv(undefined, "xterm-256color");
  expect(detectTerminalCapabilities().colorDepth).toBe("256");
});

test("screen-256color under tmux also detects 256", () => {
  setEnv(undefined, "screen-256color");
  expect(detectTerminalCapabilities().colorDepth).toBe("256");
});

test("neither env var gives a truecolor/256 signal falls back to the conservative 256 default", () => {
  setEnv(undefined, "xterm");
  expect(detectTerminalCapabilities().colorDepth).toBe("256");
});

test("no env vars set at all falls back to 256", () => {
  setEnv(undefined, undefined);
  expect(detectTerminalCapabilities().colorDepth).toBe("256");
});

test("is a pure, side-effect-free, never-throwing call for a fixed environment", () => {
  setEnv("truecolor", "xterm-256color");
  expect(() => detectTerminalCapabilities()).not.toThrow();
  expect(detectTerminalCapabilities()).toEqual(detectTerminalCapabilities());
});
