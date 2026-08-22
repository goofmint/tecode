import { describe, expect, test } from "bun:test";
import type { Manifest } from "@tecode/api";
import { checkApiVersionCompatibility, validateManifest } from "./validate";

/** A minimal, fully valid manifest to mutate/extend per test. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo.ext",
    version: "1.0.0",
    apiVersion: "1.0",
    activationEvents: ["onStartup"],
    contributes: {},
    ...overrides,
  };
}

describe("validateManifest — top-level shape", () => {
  test("accepts a minimal valid manifest", () => {
    const result = validateManifest(validManifest());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest).toEqual({
        id: "demo.ext",
        version: "1.0.0",
        apiVersion: "1.0",
        activationEvents: ["onStartup"],
        contributes: {},
      });
    }
  });

  test("rejects a non-object export", () => {
    for (const raw of [undefined, null, "a string", 42, ["array"]]) {
      const result = validateManifest(raw);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]).toContain("must export a default object");
      }
    }
  });

  test("reports missing id, version, apiVersion, activationEvents, and contributes together", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("id: required non-empty string");
      expect(result.errors).toContain("version: required non-empty string");
      expect(
        result.errors.some((e) => e.startsWith("apiVersion:")),
      ).toBe(true);
      expect(result.errors).toContain("activationEvents: required array");
      expect(result.errors).toContain("contributes: required object (may be empty {})");
    }
  });

  test("rejects a non-string id", () => {
    const result = validateManifest(validManifest({ id: 42 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain("id: required non-empty string");
  });

  test('rejects a non-SemVer version ("not-semver")', () => {
    const result = validateManifest(validManifest({ version: "not-semver" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.startsWith("version: must be a SemVer"))).toBe(true);
    }
  });

  test('rejects an incomplete version ("1.0" — SemVer needs all three parts)', () => {
    const result = validateManifest(validManifest({ version: "1.0" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.startsWith("version: must be a SemVer"))).toBe(true);
    }
  });

  test("accepts SemVer versions with pre-release and build parts", () => {
    expect(validateManifest(validManifest({ version: "1.2.3-beta.1" })).valid).toBe(true);
    expect(validateManifest(validManifest({ version: "1.2.3+build.5" })).valid).toBe(true);
  });

  test("rejects a sparse activationEvents array (holes are invalid entries, not skipped)", () => {
    const sparse: unknown[] = ["onStartup"];
    sparse.length = 3;
    sparse[2] = "onCommand:demo.run";
    const result = validateManifest(validManifest({ activationEvents: sparse }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.startsWith("activationEvents[1]:"))).toBe(true);
    }
  });

  test("rejects a sparse contributes.commands array (holes reported by index)", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const result = validateManifest(validManifest({ contributes: { commands: sparse } }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.startsWith("contributes.commands[0]:"))).toBe(true);
    }
  });

  test("a BigInt activation event is reported as an error, never thrown", () => {
    let result: ReturnType<typeof validateManifest> | undefined;
    expect(() => {
      result = validateManifest(validManifest({ activationEvents: [1n] }));
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    if (result && !result.valid) {
      expect(result.errors.some((e) => e.startsWith("activationEvents[0]:"))).toBe(true);
    }
  });

  test("rejects a sparse languages[].extensions array instead of passing holes through", () => {
    const sparseExtensions: unknown[] = [".ts"];
    sparseExtensions.length = 2;
    const result = validateManifest(
      validManifest({
        contributes: {
          languages: [
            {
              id: "demo",
              extensions: sparseExtensions,
              grammar: "g",
              highlights: "h",
            },
          ],
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.startsWith("contributes.languages[0].extensions:")),
      ).toBe(true);
    }
  });

  test("rejects an empty-string id", () => {
    const result = validateManifest(validManifest({ id: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain("id: required non-empty string");
  });

  test("rejects a malformed apiVersion", () => {
    for (const apiVersion of ["v1", "1.0.0", "one", ""]) {
      const result = validateManifest(validManifest({ apiVersion }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.startsWith("apiVersion:"))).toBe(true);
      }
    }
  });

  test("accepts apiVersion as '<major>' or '<major>.<minor>'", () => {
    for (const apiVersion of ["1", "1.0", "2.10"]) {
      const result = validateManifest(validManifest({ apiVersion }));
      expect(result.valid).toBe(true);
    }
  });

  test("rejects activationEvents entries that don't match onStartup/onCommand:/onLanguage:", () => {
    const result = validateManifest(
      validManifest({ activationEvents: ["onStartup", "onFoo:bar", 42] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e === 'activationEvents[1]: must be "onStartup", "onCommand:<id>", or "onLanguage:<id>" (got "onFoo:bar")')).toBe(true);
      expect(result.errors.some((e) => e.startsWith("activationEvents[2]:"))).toBe(true);
    }
  });

  test("accepts every documented activationEvent form", () => {
    const result = validateManifest(
      validManifest({
        activationEvents: ["onStartup", "onCommand:editor.action.save", "onLanguage:typescript"],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("rejects a non-object contributes", () => {
    const result = validateManifest(validManifest({ contributes: "nope" }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain("contributes: must be an object");
  });
});

describe("validateManifest — contributes.commands", () => {
  test("requires id (namespace.verb) and title, with exact field-path messages", () => {
    const result = validateManifest(
      validManifest({
        contributes: { commands: [{ title: "" }, { id: "not-namespaced", title: "Ok" }] },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("contributes.commands[0].id: required non-empty string");
      expect(result.errors).toContain("contributes.commands[0].title: required non-empty string");
      expect(result.errors).toContain(
        'contributes.commands[1].id: must be namespace.verb form (e.g. "editor.action.deleteLine")',
      );
    }
  });

  test("accepts a well-formed command contribution, with optional category/when", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          commands: [
            { id: "editor.action.deleteLine", title: "Delete Line", category: "Editor", when: "editorTextFocus" },
          ],
        },
      }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.contributes.commands).toEqual([
        { id: "editor.action.deleteLine", title: "Delete Line", category: "Editor", when: "editorTextFocus" },
      ]);
    }
  });

  test("rejects a non-array contributes.commands", () => {
    const result = validateManifest(validManifest({ contributes: { commands: {} } }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain("contributes.commands: must be an array");
  });
});

describe("validateManifest — contributes.keybindings", () => {
  test("requires key and command", () => {
    const result = validateManifest(
      validManifest({ contributes: { keybindings: [{ key: "" }] } }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("contributes.keybindings[0].key: required non-empty string");
      expect(result.errors).toContain(
        "contributes.keybindings[0].command: required non-empty string",
      );
    }
  });

  test("accepts a removal binding ('-command') — no namespace.verb requirement on keybindings.command", () => {
    const result = validateManifest(
      validManifest({
        contributes: { keybindings: [{ key: "ctrl+k ctrl+s", command: "-editor.action.save" }] },
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateManifest — contributes.views", () => {
  test("requires id, title, and a valid slot", () => {
    const result = validateManifest(
      validManifest({ contributes: { views: [{ id: "v", title: "V", slot: "toolbar" }] } }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('contributes.views[0].slot: must be "sidebar" or "panel"');
    }
  });

  test("accepts sidebar and panel slots", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          views: [
            { id: "a", title: "A", slot: "sidebar" },
            { id: "b", title: "B", slot: "panel", icon: "circle" },
          ],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateManifest — contributes.languages", () => {
  test("requires id, non-empty dot-prefixed extensions, grammar, and highlights", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          languages: [{ id: "ts", extensions: ["ts"], grammar: "", highlights: "" }],
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.startsWith("contributes.languages[0].extensions:")),
      ).toBe(true);
      expect(result.errors).toContain(
        "contributes.languages[0].grammar: required non-empty string",
      );
      expect(result.errors).toContain(
        "contributes.languages[0].highlights: required non-empty string",
      );
    }
  });

  test("accepts comments and brackets", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          languages: [
            {
              id: "ts",
              extensions: [".ts", ".tsx"],
              grammar: "tree-sitter-typescript.wasm",
              highlights: "highlights.scm",
              comments: { line: "//", block: ["/*", "*/"] },
              brackets: [{ open: "{", close: "}" }],
            },
          ],
        },
      }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.contributes.languages?.[0]?.comments).toEqual({
        line: "//",
        block: ["/*", "*/"],
      });
    }
  });

  test("rejects a malformed comments.block pair", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          languages: [
            {
              id: "ts",
              extensions: [".ts"],
              grammar: "g",
              highlights: "h",
              comments: { block: ["only-one"] },
            },
          ],
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e === "contributes.languages[0].comments.block: must be a [start, end] string pair"),
      ).toBe(true);
    }
  });
});

describe("validateManifest — contributes.themes", () => {
  test("requires id, label, and path", () => {
    const result = validateManifest(
      validManifest({ contributes: { themes: [{ id: "t" }] } }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("contributes.themes[0].label: required non-empty string");
      expect(result.errors).toContain("contributes.themes[0].path: required non-empty string");
    }
  });

  test("accepts a well-formed theme contribution", () => {
    const result = validateManifest(
      validManifest({
        contributes: { themes: [{ id: "dark", label: "Dark", path: "./themes/dark.json" }] },
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateManifest — contributes.configuration", () => {
  test("requires properties, and each property's type", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          configuration: { properties: { "editor.tabSize": { type: "not-a-type" } } },
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) =>
          e.startsWith('contributes.configuration.properties["editor.tabSize"].type:'),
        ),
      ).toBe(true);
    }
  });

  test("accepts a well-formed configuration contribution with defaults/enum/description", () => {
    const result = validateManifest(
      validManifest({
        contributes: {
          configuration: {
            title: "Demo",
            properties: {
              "demo.mode": {
                type: "string",
                default: "fast",
                description: "The mode",
                enum: ["fast", "slow"],
              },
            },
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.contributes.configuration).toEqual({
        title: "Demo",
        properties: {
          "demo.mode": {
            type: "string",
            default: "fast",
            description: "The mode",
            enum: ["fast", "slow"],
          },
        },
      });
    }
  });

  test("requires contributes.configuration.properties itself", () => {
    const result = validateManifest(
      validManifest({ contributes: { configuration: { title: "Demo" } } }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain("contributes.configuration.properties: required object");
    }
  });
});

describe("validateManifest — multiple problems reported together", () => {
  test("does not fail fast: every problem across every contribution surfaces in one pass", () => {
    const result = validateManifest({
      // no id, no version
      apiVersion: "not-a-version",
      activationEvents: "not-an-array",
      contributes: {
        commands: [{}],
        views: [{}],
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("checkApiVersionCompatibility — matrix (Req 2.7, design.md §4.3)", () => {
  test("same major and minor is compatible", () => {
    expect(checkApiVersionCompatibility("1.0", "1.0").compatible).toBe(true);
  });

  test("same major, older requested minor is compatible (host newer)", () => {
    expect(checkApiVersionCompatibility("1.0", "1.5").compatible).toBe(true);
  });

  test("same major, newer requested minor than host is incompatible", () => {
    const result = checkApiVersionCompatibility("1.5", "1.0");
    expect(result.compatible).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("different major is incompatible regardless of minor", () => {
    expect(checkApiVersionCompatibility("2.0", "1.9").compatible).toBe(false);
    expect(checkApiVersionCompatibility("0.9", "1.0").compatible).toBe(false);
  });

  test("an omitted minor is treated as 0", () => {
    expect(checkApiVersionCompatibility("1", "1.0").compatible).toBe(true);
    expect(checkApiVersionCompatibility("1", "0.9").compatible).toBe(false);
  });

  test("an unparsable version is incompatible, not thrown", () => {
    const result = checkApiVersionCompatibility("not-a-version", "1.0");
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("could not parse");
  });

  test("defaults hostVersion to the real API_VERSION when omitted", () => {
    // @tecode/api's API_VERSION is "1.0" today; a manifest requesting "1.0"
    // must be compatible against whatever the real host actually exports,
    // not a hardcoded copy of the version string.
    const result = checkApiVersionCompatibility("1.0");
    expect(result.compatible).toBe(true);
  });
});

describe("validateManifest — a realistic full manifest round-trips", () => {
  test("validates and reconstructs a manifest with every contribution kind", () => {
    const raw: Manifest = {
      id: "demo.everything",
      version: "2.3.1",
      apiVersion: "1.0",
      activationEvents: ["onStartup", "onCommand:demo.run", "onLanguage:typescript"],
      contributes: {
        commands: [{ id: "demo.run", title: "Run Demo" }],
        keybindings: [{ key: "ctrl+shift+r", command: "demo.run" }],
        views: [{ id: "demo.view", title: "Demo", slot: "sidebar" }],
        languages: [
          { id: "demo-lang", extensions: [".demo"], grammar: "g.wasm", highlights: "h.scm" },
        ],
        themes: [{ id: "demo-theme", label: "Demo Theme", path: "theme.json" }],
        configuration: { properties: { "demo.enabled": { type: "boolean", default: true } } },
      },
    };

    const result = validateManifest(raw);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest).toEqual(raw);
    }
  });
});
