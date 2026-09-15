/**
 * Tests for `findFilePath.ts`'s pure path-input helpers (Issue #164) — no
 * filesystem, no service, no renderer: every case below is a plain string
 * transformation.
 */

import { describe, expect, test } from "bun:test";
import {
  appendTrailingSeparator,
  expandTilde,
  longestCommonPrefix,
  resolvePathInput,
  spliceCompletion,
  splitPathInput,
} from "./findFilePath";

const HOME = "/home/tester";
const BASE = "/work/project";

describe("expandTilde (Issue #164)", () => {
  test("a bare ~ becomes the home directory", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
  });

  test("~/x becomes home's x", () => {
    expect(expandTilde("~/Code/te", HOME)).toBe(`${HOME}/Code/te`);
  });

  test("~/ alone becomes the home directory itself", () => {
    expect(expandTilde("~/", HOME)).toBe(HOME);
  });

  test("~user is NOT expanded — another user's home is deliberately unsupported", () => {
    expect(expandTilde("~other/x", HOME)).toBe("~other/x");
  });

  test("anything without a leading ~ is returned unchanged", () => {
    expect(expandTilde("packages/core", HOME)).toBe("packages/core");
    expect(expandTilde("/etc/hosts", HOME)).toBe("/etc/hosts");
    expect(expandTilde("", HOME)).toBe("");
  });
});

describe("resolvePathInput (Issue #164)", () => {
  test("a relative path resolves against the base directory", () => {
    expect(resolvePathInput("src/index.ts", BASE, HOME)).toBe(`${BASE}/src/index.ts`);
  });

  test("an absolute path ignores the base directory", () => {
    expect(resolvePathInput("/etc/hosts", BASE, HOME)).toBe("/etc/hosts");
  });

  test(".. walks up from the base directory", () => {
    expect(resolvePathInput("../other/file.md", BASE, HOME)).toBe("/work/other/file.md");
  });

  test("~ is expanded before resolution", () => {
    expect(resolvePathInput("~/notes.md", BASE, HOME)).toBe(`${HOME}/notes.md`);
  });

  test("an empty input resolves to the base directory itself", () => {
    expect(resolvePathInput("", BASE, HOME)).toBe(BASE);
  });
});

describe("splitPathInput (Issue #164)", () => {
  test("a trailing separator means the whole input is the directory", () => {
    expect(splitPathInput("packages/", BASE, HOME)).toEqual({
      dirPath: `${BASE}/packages`,
      partial: "",
    });
  });

  test("a half-typed entry splits into its parent directory and the typed prefix", () => {
    expect(splitPathInput("packages/co", BASE, HOME)).toEqual({
      dirPath: `${BASE}/packages`,
      partial: "co",
    });
  });

  test("a bare name splits against the base directory", () => {
    expect(splitPathInput("READ", BASE, HOME)).toEqual({ dirPath: BASE, partial: "READ" });
  });

  test("an empty input is the base directory with nothing typed", () => {
    expect(splitPathInput("", BASE, HOME)).toEqual({ dirPath: BASE, partial: "" });
  });

  test("a bare ~ is the home directory, NOT a prefix of its own basename", () => {
    expect(splitPathInput("~", BASE, HOME)).toEqual({ dirPath: HOME, partial: "" });
  });

  test("~/ plus a prefix splits inside the home directory", () => {
    expect(splitPathInput("~/Co", BASE, HOME)).toEqual({ dirPath: HOME, partial: "Co" });
  });

  test("an absolute input splits without consulting the base directory", () => {
    expect(splitPathInput("/etc/host", BASE, HOME)).toEqual({ dirPath: "/etc", partial: "host" });
  });

  test("the root directory splits to itself with nothing typed", () => {
    expect(splitPathInput("/", BASE, HOME)).toEqual({ dirPath: "/", partial: "" });
  });

  test(".. is resolved in the directory half", () => {
    expect(splitPathInput("../other/fi", BASE, HOME)).toEqual({
      dirPath: "/work/other",
      partial: "fi",
    });
  });

  test("the partial is always the literal tail of the ORIGINAL input", () => {
    const input = "~/Code/tec";
    const { partial } = splitPathInput(input, BASE, HOME);
    expect(input.endsWith(partial)).toBe(true);
  });
});

describe("appendTrailingSeparator (Issue #164)", () => {
  test("adds a separator to a bare name", () => {
    expect(appendTrailingSeparator("packages")).toBe("packages/");
  });

  test("leaves an already-separated path alone", () => {
    expect(appendTrailingSeparator("packages/")).toBe("packages/");
  });
});

describe("longestCommonPrefix (Issue #164)", () => {
  test("empty for no values", () => {
    expect(longestCommonPrefix([])).toBe("");
  });

  test("the value itself for a single candidate", () => {
    expect(longestCommonPrefix(["core"])).toBe("core");
  });

  test("the shared prefix for several candidates", () => {
    expect(longestCommonPrefix(["core", "corex", "cormorant"])).toBe("cor");
  });

  test("empty when the very first character disagrees", () => {
    expect(longestCommonPrefix(["api", "core"])).toBe("");
  });

  test("a candidate that IS the prefix caps the answer", () => {
    expect(longestCommonPrefix(["core", "core.test", "core"])).toBe("core");
  });
});

describe("spliceCompletion (Issue #164)", () => {
  test("replaces exactly the typed partial, preserving the directory the user typed", () => {
    expect(spliceCompletion("~/Code/te", "te", "tecode/")).toBe("~/Code/tecode/");
  });

  test("an empty partial appends", () => {
    expect(spliceCompletion("~/Code/", "", "tecode/")).toBe("~/Code/tecode/");
  });
});
