import { afterEach, beforeEach, expect, test } from "bun:test";
import { detectTerminalCapabilities, resolveKittyKeyboardSupport } from "./terminalCapabilities";

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

// --- resolveKittyKeyboardSupport (Req 4.7, 13.3; design.md §6.5; Task 4.2) ---
//
// Mocked-terminal-response cases, per this task's completion requirement
// "Detection unit-tested with mocked terminal responses (supported /
// unsupported / tmux)": `capabilitiesValue` stands in for whatever
// `@opentui/core`'s `CliRenderer.capabilities` held at the moment
// `renderShell.tsx` called through — a plain object literal here plays
// exactly the same role a synthetic Kitty CSI-u response plays in
// `editor-core/manifest.ts`'s/`keyRouting.test.ts`'s "verified against the
// real vendored parser" methodology, just one layer further downstream
// (this function never touches the parser at all — it only reads the
// ALREADY-DECODED `kitty_keyboard` field OpenTUI's native
// `getTerminalCapabilities()` produces from that lower-level protocol
// exchange, per `terminalCapabilities.ts`'s own TSDoc).

test("supported: kitty_keyboard true and no tmux signal resolves to Kitty-capable", () => {
  expect(resolveKittyKeyboardSupport({ kitty_keyboard: true }, {})).toBe(true);
  expect(
    resolveKittyKeyboardSupport({ kitty_keyboard: true }, { TERM: "xterm-kitty" }),
  ).toBe(true);
});

test("unsupported: kitty_keyboard false resolves to NOT Kitty-capable", () => {
  expect(resolveKittyKeyboardSupport({ kitty_keyboard: false }, {})).toBe(false);
});

test("unsupported: a realistic non-Kitty capabilities object (every OTHER flag true, kitty_keyboard false) still resolves to false", () => {
  expect(
    resolveKittyKeyboardSupport(
      { kitty_keyboard: false, kitty_graphics: false, rgb: true, ansi256: true, unicode: true },
      { TERM: "xterm-256color" },
    ),
  ).toBe(false);
});

test("tmux: kitty_keyboard true but $TERM contains tmux is corrected to NOT Kitty-capable (passthrough is untrustworthy)", () => {
  expect(
    resolveKittyKeyboardSupport({ kitty_keyboard: true }, { TERM: "tmux-256color" }),
  ).toBe(false);
});

test("tmux: kitty_keyboard true but $TERM is screen-256color (tmux's other conventional TERM) is also corrected to false", () => {
  expect(
    resolveKittyKeyboardSupport({ kitty_keyboard: true }, { TERM: "screen-256color" }),
  ).toBe(false);
});

test("tmux: kitty_keyboard true but $TERM_PROGRAM is tmux is also corrected to false", () => {
  expect(
    resolveKittyKeyboardSupport(
      { kitty_keyboard: true },
      { TERM: "xterm-256color", TERM_PROGRAM: "tmux" },
    ),
  ).toBe(false);
});

test("tmux detection is case-insensitive", () => {
  expect(
    resolveKittyKeyboardSupport({ kitty_keyboard: true }, { TERM_PROGRAM: "TMUX" }),
  ).toBe(false);
});

test("conservative default: a timed-out/absent query (capabilities is null) resolves to NOT Kitty-capable", () => {
  expect(resolveKittyKeyboardSupport(null, {})).toBe(false);
});

test("conservative default: capabilities present but missing kitty_keyboard entirely resolves to NOT Kitty-capable", () => {
  expect(resolveKittyKeyboardSupport({ rgb: true }, {})).toBe(false);
});

test("conservative default: a malformed kitty_keyboard (not a boolean) is treated as absent, not truthy-coerced", () => {
  expect(resolveKittyKeyboardSupport({ kitty_keyboard: 1 }, {})).toBe(false);
  expect(resolveKittyKeyboardSupport({ kitty_keyboard: "true" }, {})).toBe(false);
});

test("conservative default: a non-object capabilitiesValue never throws and resolves to false", () => {
  expect(() => resolveKittyKeyboardSupport(undefined, {})).not.toThrow();
  expect(resolveKittyKeyboardSupport(undefined, {})).toBe(false);
  expect(resolveKittyKeyboardSupport("garbage", {})).toBe(false);
  expect(resolveKittyKeyboardSupport(42, {})).toBe(false);
});

test("is a pure, side-effect-free call — same inputs, same output, every time", () => {
  const caps = { kitty_keyboard: true };
  const env = { TERM: "xterm-kitty" };
  expect(resolveKittyKeyboardSupport(caps, env)).toBe(
    resolveKittyKeyboardSupport(caps, env),
  );
});
