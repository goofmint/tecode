import { expect, test } from "bun:test";
import { deliversSigwinch, supportsBunTerminal } from "./platform";

test("non-win32 platforms always support Bun.Terminal, regardless of bunVersion", () => {
  expect(supportsBunTerminal("linux", "0.0.1")).toBe(true);
  expect(supportsBunTerminal("darwin", "0.0.1")).toBe(true);
  expect(supportsBunTerminal("freebsd")).toBe(true);
  expect(supportsBunTerminal("openbsd")).toBe(true);
  expect(supportsBunTerminal("sunos")).toBe(true);
  expect(supportsBunTerminal("aix")).toBe(true);
  expect(supportsBunTerminal("android")).toBe(true);
});

test("win32 below the ConPTY threshold (Bun 1.3.14) is unsupported", () => {
  expect(supportsBunTerminal("win32", "1.3.13")).toBe(false);
  expect(supportsBunTerminal("win32", "1.2.99")).toBe(false);
  expect(supportsBunTerminal("win32", "0.9.9")).toBe(false);
});

test("win32 at or above the ConPTY threshold (Bun 1.3.14) is supported", () => {
  expect(supportsBunTerminal("win32", "1.3.14")).toBe(true);
  expect(supportsBunTerminal("win32", "1.4.0")).toBe(true);
  expect(supportsBunTerminal("win32", "2.0.0")).toBe(true);
});

test("win32 with a pre-release suffix parses the leading major.minor.patch", () => {
  expect(supportsBunTerminal("win32", "1.3.14-canary.3")).toBe(true);
  expect(supportsBunTerminal("win32", "1.3.13-canary.3")).toBe(false);
});

test("win32 with an unparseable version fails closed", () => {
  expect(supportsBunTerminal("win32", "not-a-version")).toBe(false);
});

test("defaults to the real process.platform/Bun.version when no argument is given", () => {
  expect(supportsBunTerminal()).toBe(supportsBunTerminal(process.platform, Bun.version));
});

test("deliversSigwinch: every POSIX platform can receive SIGWINCH", () => {
  expect(deliversSigwinch("linux")).toBe(true);
  expect(deliversSigwinch("darwin")).toBe(true);
  expect(deliversSigwinch("freebsd")).toBe(true);
});

test("deliversSigwinch: win32 cannot — the signal has no Windows equivalent", () => {
  // Independent of `supportsBunTerminal`: since Bun 1.3.14 a Windows host
  // CAN allocate a pty, and still cannot be sent SIGWINCH.
  expect(deliversSigwinch("win32")).toBe(false);
  expect(supportsBunTerminal("win32", "1.3.14")).toBe(true);
});

test("deliversSigwinch defaults to the real process.platform", () => {
  expect(deliversSigwinch()).toBe(process.platform !== "win32");
});
