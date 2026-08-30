import { describe, expect, test } from "bun:test";
import { rootFolderName } from "./rootTitle";

describe("rootFolderName (Issue #103)", () => {
  test("returns the decoded last segment of a plain file:// root", () => {
    expect(rootFolderName("file:///home/user/tecode")).toBe("tecode");
  });

  test("percent-decodes a space in the folder name (the easiest mistake to make, per the issue)", () => {
    // encodeURIComponent("my project") -> "my%20project" — exactly what
    // `pathToFileURL(...).href` would produce for a folder literally named
    // "my project". Skipping the decode step would surface this as the
    // still-encoded "my%20project" instead.
    expect(rootFolderName("file:///home/user/my%20project")).toBe("my project");
  });

  test("strips a trailing slash before taking the last segment", () => {
    expect(rootFolderName("file:///home/user/my-project/")).toBe("my-project");
  });

  test("does not crash on a Windows drive root, and returns its one non-empty segment", () => {
    expect(rootFolderName("file:///C:/")).toBe("C:");
    expect(rootFolderName("file:///C:/Users/x/my%20project")).toBe("my project");
  });

  test("fallback 1: no workspace root at all (undefined) yields undefined", () => {
    expect(rootFolderName(undefined)).toBeUndefined();
  });

  test("fallback 2: a filesystem root's basename is empty (file:///) yields undefined", () => {
    expect(rootFolderName("file:///")).toBeUndefined();
  });

  test("fallback 3: a rootUri that does not parse as a URL yields undefined, never throws", () => {
    expect(rootFolderName("not a uri at all")).toBeUndefined();
    expect(() => rootFolderName("not a uri at all")).not.toThrow();
  });

  test("a malformed percent-escape in the last segment yields undefined, never throws", () => {
    // decodeURIComponent("100%") throws (a lone "%" is not a valid escape)
    // — folded into the same "could not parse" outcome as an unparseable
    // URL, per this module's TSDoc, rather than propagating.
    expect(() => rootFolderName("file:///home/user/100%")).not.toThrow();
    expect(rootFolderName("file:///home/user/100%")).toBeUndefined();
  });
});
