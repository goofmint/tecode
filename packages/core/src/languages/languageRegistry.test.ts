/**
 * Tests for {@link createLanguageRegistry} (Req 8.1-8.3, design.md §10).
 */

import { describe, expect, test } from "bun:test";
import type { LanguageContribution } from "@tecode/api";
import type { PendingLanguageContribution } from "../host/registration";
import { createLanguageRegistry, PLAINTEXT_LANGUAGE_ID } from "./languageRegistry";

function ts(): LanguageContribution {
  return { id: "typescript", extensions: [".ts", ".tsx"], grammar: "ts.wasm", highlights: "ts.scm" };
}

function json(): LanguageContribution {
  return { id: "json", extensions: [".json"], grammar: "json.wasm", highlights: "json.scm" };
}

describe("createLanguageRegistry — resolveLanguageId (Req 8.3)", () => {
  test("a single-extension language resolves by its extension", () => {
    const registry = createLanguageRegistry();
    registry.register(json());
    expect(registry.resolveLanguageId("file:///a/b.json")).toBe("json");
  });

  test("a multi-extension language maps every extension to the same id", () => {
    const registry = createLanguageRegistry();
    registry.register(ts());
    expect(registry.resolveLanguageId("file:///a/b.ts")).toBe("typescript");
    expect(registry.resolveLanguageId("file:///a/b.tsx")).toBe("typescript");
  });

  test("an unmatched extension resolves to plaintext", () => {
    const registry = createLanguageRegistry();
    registry.register(json());
    expect(registry.resolveLanguageId("file:///a/b.rs")).toBe(PLAINTEXT_LANGUAGE_ID);
  });

  test("a file with no extension resolves to plaintext", () => {
    const registry = createLanguageRegistry();
    registry.register(json());
    expect(registry.resolveLanguageId("file:///a/Makefile")).toBe(PLAINTEXT_LANGUAGE_ID);
  });

  test("a fresh registry with zero registrations always resolves to plaintext", () => {
    const registry = createLanguageRegistry();
    expect(registry.resolveLanguageId("file:///a/b.ts")).toBe(PLAINTEXT_LANGUAGE_ID);
  });

  test("extension matching is case-insensitive", () => {
    const registry = createLanguageRegistry();
    registry.register(json());
    expect(registry.resolveLanguageId("file:///a/B.JSON")).toBe("json");
  });

  test("a malformed uri resolves to plaintext rather than throwing", () => {
    const registry = createLanguageRegistry();
    registry.register(json());
    expect(registry.resolveLanguageId("not a uri")).toBe(PLAINTEXT_LANGUAGE_ID);
  });
});

describe("createLanguageRegistry — register/getLanguage/getBaseDir (Req 8.1, 8.2)", () => {
  test("register is synchronous — getLanguage/resolveLanguageId see it immediately", () => {
    const registry = createLanguageRegistry();
    registry.register(ts());
    expect(registry.getLanguage("typescript")).toEqual(ts());
    expect(registry.resolveLanguageId("file:///x.ts")).toBe("typescript");
  });

  test("an unregistered id returns undefined", () => {
    const registry = createLanguageRegistry();
    expect(registry.getLanguage("nope")).toBeUndefined();
    expect(registry.getBaseDir("nope")).toBeUndefined();
  });

  test("getBaseDir returns the extension directory a manifest registration was given", () => {
    const registry = createLanguageRegistry();
    registry.register(ts(), "/ext/languages-basic");
    expect(registry.getBaseDir("typescript")).toBe("/ext/languages-basic");
  });

  test("a runtime registration with no baseDir reports undefined", () => {
    const registry = createLanguageRegistry();
    registry.register(ts());
    expect(registry.getBaseDir("typescript")).toBeUndefined();
  });

  test("re-registering the same id replaces its extension claims entirely", () => {
    const registry = createLanguageRegistry();
    registry.register({ id: "x", extensions: [".x"], grammar: "g", highlights: "h" });
    registry.register({ id: "x", extensions: [".y"], grammar: "g2", highlights: "h2" });
    expect(registry.resolveLanguageId("file:///a.x")).toBe(PLAINTEXT_LANGUAGE_ID);
    expect(registry.resolveLanguageId("file:///a.y")).toBe("x");
    expect(registry.getLanguage("x")?.grammar).toBe("g2");
  });

  test("list() enumerates every registered contribution", () => {
    const registry = createLanguageRegistry();
    registry.register(ts());
    registry.register(json());
    expect(registry.list().map((c) => c.id).sort()).toEqual(["json", "typescript"]);
  });
});

describe("createLanguageRegistry — dispose symmetry", () => {
  test("disposing a registration removes it from the extension map and getLanguage", () => {
    const registry = createLanguageRegistry();
    const sub = registry.register(json());
    expect(registry.resolveLanguageId("file:///a.json")).toBe("json");
    sub.dispose();
    expect(registry.resolveLanguageId("file:///a.json")).toBe(PLAINTEXT_LANGUAGE_ID);
    expect(registry.getLanguage("json")).toBeUndefined();
  });

  test("dispose is idempotent", () => {
    const registry = createLanguageRegistry();
    const sub = registry.register(json());
    sub.dispose();
    expect(() => sub.dispose()).not.toThrow();
  });

  test("disposing a SUPERSEDED registration is a no-op (later registrations win)", () => {
    const registry = createLanguageRegistry();
    const first = registry.register(json());
    registry.register(json()); // Re-register the same id.
    first.dispose();
    // Still registered — `first`'s dispose must not have torn down the
    // second (current) registration.
    expect(registry.getLanguage("json")).toBeDefined();
    expect(registry.resolveLanguageId("file:///a.json")).toBe("json");
  });
});

describe("createLanguageRegistry — onDidChange", () => {
  test("fires on register and on dispose", () => {
    const registry = createLanguageRegistry();
    let count = 0;
    registry.onDidChange(() => {
      count += 1;
    });
    const sub = registry.register(json());
    expect(count).toBe(1);
    sub.dispose();
    expect(count).toBe(2);
  });

  test("a throwing listener does not break other listeners", () => {
    const registry = createLanguageRegistry();
    let secondCalled = false;
    registry.onDidChange(() => {
      throw new Error("boom");
    });
    registry.onDidChange(() => {
      secondCalled = true;
    });
    expect(() => registry.register(json())).not.toThrow();
    expect(secondCalled).toBe(true);
  });

  test("registry.dispose() clears listeners without erasing registered entries", () => {
    const registry = createLanguageRegistry();
    let count = 0;
    registry.onDidChange(() => {
      count += 1;
    });
    registry.register(json());
    expect(count).toBe(1);
    registry.dispose();
    registry.register(ts());
    expect(count).toBe(1); // No further firing after dispose().
    expect(registry.getLanguage("json")).toBeDefined(); // Still registered.
  });
});

describe("createLanguageRegistry — loadContributions (Req 8.2)", () => {
  test("registers every pending entry against its extension's directory and fires onDidChange", async () => {
    const registry = createLanguageRegistry();
    let changeCount = 0;
    registry.onDidChange(() => {
      changeCount += 1;
    });

    const pending: PendingLanguageContribution[] = [
      { extensionId: "languages-basic", language: ts() },
      { extensionId: "languages-basic", language: json() },
    ];
    await registry.loadContributions(pending, { "languages-basic": "<builtin>/languages-basic" });

    expect(registry.getLanguage("typescript")).toEqual(ts());
    expect(registry.getBaseDir("typescript")).toBe("<builtin>/languages-basic");
    expect(registry.getBaseDir("json")).toBe("<builtin>/languages-basic");
    expect(registry.resolveLanguageId("file:///a.tsx")).toBe("typescript");
    expect(changeCount).toBe(2);
  });

  test("an extensionId with no directory entry registers with an undefined baseDir", async () => {
    const registry = createLanguageRegistry();
    await registry.loadContributions([{ extensionId: "unknown-ext", language: json() }], {});
    expect(registry.getBaseDir("json")).toBeUndefined();
    expect(registry.getLanguage("json")).toEqual(json());
  });

  test("an empty pending list resolves without registering anything", async () => {
    const registry = createLanguageRegistry();
    await registry.loadContributions([], {});
    expect(registry.list()).toEqual([]);
  });
});
