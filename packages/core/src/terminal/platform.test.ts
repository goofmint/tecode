import { expect, test } from "bun:test";
import { isPosixPlatform } from "./platform";

test("win32 is not POSIX", () => {
  expect(isPosixPlatform("win32")).toBe(false);
});

test("linux, darwin, and other non-win32 platforms are POSIX", () => {
  expect(isPosixPlatform("linux")).toBe(true);
  expect(isPosixPlatform("darwin")).toBe(true);
  expect(isPosixPlatform("freebsd")).toBe(true);
  expect(isPosixPlatform("openbsd")).toBe(true);
  expect(isPosixPlatform("sunos")).toBe(true);
  expect(isPosixPlatform("aix")).toBe(true);
  expect(isPosixPlatform("android")).toBe(true);
});

test("defaults to the real process.platform when no argument is given", () => {
  expect(isPosixPlatform()).toBe(process.platform !== "win32");
});
