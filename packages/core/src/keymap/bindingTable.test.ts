import { describe, expect, test } from "bun:test";
import type { KeybindingContribution } from "@tecode/api";
import { createHostLog } from "../host/errors";
import { createBindingTable, type KeymapLayers } from "./bindingTable";

/** Build a context getter from a plain object, matching when.test.ts's
 * table-driven helper. */
function contextOf(values: Record<string, unknown> = {}): (key: string) => unknown {
  return (key) => values[key];
}

/** Build a full {@link KeymapLayers}, defaulting every layer to empty so
 * each test only spells out the layers it cares about. */
function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
  return {
    defaults: partial.defaults ?? [],
    fallback: partial.fallback ?? [],
    extension: partial.extension ?? [],
    user: partial.user ?? [],
  };
}

describe("createBindingTable — layer precedence", () => {
  test("user beats extension on the same key", () => {
    const layers = layersOf({
      extension: [{ key: "ctrl+p", command: "extension.command" }],
      user: [{ key: "ctrl+p", command: "user.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    const resolved = table.lookup("ctrl+p", contextOf());
    expect(resolved?.command).toBe("user.command");
    expect(resolved?.layer).toBe("user");
  });

  test("extension beats fallback on the same key", () => {
    const layers = layersOf({
      fallback: [{ key: "ctrl+p", command: "fallback.command" }],
      extension: [{ key: "ctrl+p", command: "extension.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    const resolved = table.lookup("ctrl+p", contextOf());
    expect(resolved?.command).toBe("extension.command");
    expect(resolved?.layer).toBe("extension");
  });

  test("fallback beats defaults on the same key", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "defaults.command" }],
      fallback: [{ key: "ctrl+p", command: "fallback.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    const resolved = table.lookup("ctrl+p", contextOf());
    expect(resolved?.command).toBe("fallback.command");
    expect(resolved?.layer).toBe("fallback");
  });

  test("full stack: user wins over extension, fallback, and defaults all on one key", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "defaults.command" }],
      fallback: [{ key: "ctrl+p", command: "fallback.command" }],
      extension: [{ key: "ctrl+p", command: "extension.command" }],
      user: [{ key: "ctrl+p", command: "user.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+p", contextOf())?.command).toBe("user.command");
  });

  test("an unbound key resolves to undefined", () => {
    const table = createBindingTable(layersOf({}), { log: createHostLog() });
    expect(table.lookup("ctrl+z", contextOf())).toBeUndefined();
  });
});

describe("createBindingTable — removal records (Req 4.3)", () => {
  test("a user removal masks a defaults binding of the same command on that key", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      user: [{ key: "ctrl+p", command: "-quickOpen.show" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+p", contextOf())).toBeUndefined();
  });

  test("a user removal masks an extension binding of the same command on that key", () => {
    const layers = layersOf({
      extension: [{ key: "ctrl+p", command: "quickOpen.show" }],
      user: [{ key: "ctrl+p", command: "-quickOpen.show" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+p", contextOf())).toBeUndefined();
  });

  test("a later (higher-precedence) rebinding of the removed command is NOT masked", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      user: [
        { key: "ctrl+p", command: "-quickOpen.show" },
        { key: "ctrl+p", command: "quickOpen.show" },
      ],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    const resolved = table.lookup("ctrl+p", contextOf());
    expect(resolved?.command).toBe("quickOpen.show");
    expect(resolved?.layer).toBe("user");
  });

  test("removing one command does not affect other commands on the same key", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      user: [
        { key: "ctrl+p", command: "-quickOpen.show" },
        { key: "ctrl+p", command: "other.command", when: "false" },
      ],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    // quickOpen.show is masked; other.command is present but its own
    // `when` fails, so lookup still yields undefined — proving the
    // removal didn't wipe the whole key, only its own command.
    expect(table.lookup("ctrl+p", contextOf())).toBeUndefined();
    const grouped = table.entries().get("ctrl+p");
    expect(grouped?.map((b) => b.command)).toEqual(["other.command"]);
  });

  test("a removal with no matching binding is simply inert", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+p", command: "-nothing.bound" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+p", contextOf())).toBeUndefined();
    expect(table.entries().get("ctrl+p")).toEqual([]);
  });
});

describe("createBindingTable — normalization equivalence", () => {
  test("Shift+Ctrl+P in one layer and ctrl+shift+p in another resolve to the same entry", () => {
    const layers = layersOf({
      defaults: [{ key: "Shift+Ctrl+P", command: "defaults.command" }],
      user: [{ key: "ctrl+shift+p", command: "user.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    // Both contributions collapsed onto one canonical key, so the
    // higher-precedence (user) one wins the lookup under that canonical
    // form.
    expect(table.lookup("ctrl+shift+p", contextOf())?.command).toBe("user.command");
    expect(table.entries().size).toBe(1);
    expect(table.entries().get("ctrl+shift+p")?.map((b) => b.command)).toEqual([
      "defaults.command",
      "user.command",
    ]);
  });
});

describe("createBindingTable — when filtering with the real compileWhen", () => {
  test("defaults binding without when vs. user binding gated on editorFocus", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "defaults.command" }],
      user: [{ key: "ctrl+p", command: "user.command", when: "editorFocus" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    // editorFocus true: the user binding's clause passes, and it is
    // highest precedence.
    expect(table.lookup("ctrl+p", contextOf({ editorFocus: true }))?.command).toBe(
      "user.command",
    );

    // editorFocus false: the user binding's clause fails, so lookup falls
    // through to the unconditional defaults binding.
    expect(table.lookup("ctrl+p", contextOf({ editorFocus: false }))?.command).toBe(
      "defaults.command",
    );
  });

  test("a binding's when is re-evaluated per lookup call, not cached from build time", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+p", command: "user.command", when: "editorFocus" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+p", contextOf({ editorFocus: false }))).toBeUndefined();
    expect(table.lookup("ctrl+p", contextOf({ editorFocus: true }))?.command).toBe(
      "user.command",
    );
  });

  test("a compound when clause (&&, ||, !) filters correctly", () => {
    const layers = layersOf({
      user: [
        {
          key: "ctrl+k",
          command: "user.command",
          when: "editorTextFocus && !explorerFocus",
        },
      ],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(
      table.lookup(
        "ctrl+k",
        contextOf({ editorTextFocus: true, explorerFocus: false }),
      )?.command,
    ).toBe("user.command");
    expect(
      table.lookup(
        "ctrl+k",
        contextOf({ editorTextFocus: true, explorerFocus: true }),
      ),
    ).toBeUndefined();
  });
});

describe("createBindingTable — invalid entries are skipped with a warning", () => {
  test("an empty key is skipped and logged, table still builds", () => {
    const log = createHostLog();
    const layers = layersOf({
      user: [
        { key: "", command: "user.broken" },
        { key: "ctrl+p", command: "user.fine" },
      ],
    });
    const table = createBindingTable(layers, { log });

    expect(table.lookup("ctrl+p", contextOf())?.command).toBe("user.fine");
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error.message).toContain("empty key");
  });

  test("an empty command is skipped and logged", () => {
    const log = createHostLog();
    const layers = layersOf({
      user: [{ key: "ctrl+p", command: "" }],
    });
    const table = createBindingTable(layers, { log });

    expect(table.lookup("ctrl+p", contextOf())).toBeUndefined();
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error.message).toContain("empty command");
  });

  test("a malformed when clause is skipped and logged, never throws", () => {
    const log = createHostLog();
    const layers = layersOf({
      user: [
        { key: "ctrl+p", command: "user.broken", when: "a &&" },
        { key: "ctrl+p", command: "user.fine" },
      ],
    });

    let table;
    expect(() => {
      table = createBindingTable(layers, { log });
    }).not.toThrow();

    expect(table!.lookup("ctrl+p", contextOf())?.command).toBe("user.fine");
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error.message).toContain("a &&");
  });

  test("multiple invalid entries across layers are all skipped without aborting the build", () => {
    const log = createHostLog();
    const layers = layersOf({
      defaults: [{ key: "", command: "defaults.broken" }],
      extension: [{ key: "ctrl+q", command: "" }],
      user: [{ key: "ctrl+z", command: "user.broken", when: "(((" }],
    });

    expect(() => createBindingTable(layers, { log })).not.toThrow();
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings).toHaveLength(3);
  });
});

describe("createBindingTable — entries()", () => {
  test("returns layer attribution for every visible binding, grouped by key", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "defaults.command" }],
      user: [{ key: "ctrl+p", command: "user.command" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    const grouped = table.entries().get("ctrl+p");
    expect(grouped).toEqual([
      { command: "defaults.command", key: "ctrl+p", layer: "defaults" },
      { command: "user.command", key: "ctrl+p", layer: "user" },
    ]);
  });

  test("removal records themselves never appear in entries()", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      user: [{ key: "ctrl+p", command: "-quickOpen.show" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.entries().get("ctrl+p")).toEqual([]);
  });

  test("entries() includes each binding's when clause source", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+p", command: "user.command", when: "editorFocus" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.entries().get("ctrl+p")).toEqual([
      { command: "user.command", key: "ctrl+p", layer: "user", when: "editorFocus" },
    ]);
  });

  test("an empty table's entries() is an empty map", () => {
    const table = createBindingTable(layersOf({}), { log: createHostLog() });
    expect(table.entries().size).toBe(0);
  });
});

describe("createBindingTable — sanity against the KeybindingContribution shape", () => {
  test("accepts real KeybindingContribution objects end to end", () => {
    const binding: KeybindingContribution = {
      key: "ctrl+k ctrl+s",
      command: "keybindings.open",
    };
    const table = createBindingTable(layersOf({ user: [binding] }), {
      log: createHostLog(),
    });

    // Chord sequences aren't resolved by this table (Task 1.6); the raw
    // string still normalizes and registers as a single (multi-token) key
    // without throwing.
    expect(() => table.entries()).not.toThrow();
  });
});

test("non-string key or command entries are skipped with a warning, never thrown on", () => {
  const log = createHostLog();
  const malformed = [
    { key: "ctrl+p" } as unknown as KeybindingContribution,
    { key: "ctrl+p", command: null } as unknown as KeybindingContribution,
    { key: "ctrl+p", command: 42 } as unknown as KeybindingContribution,
    { command: "editor.action.ok" } as unknown as KeybindingContribution,
    { key: 7, command: "editor.action.ok" } as unknown as KeybindingContribution,
  ];

  const table = createBindingTable(
    {
      defaults: malformed,
      fallback: [],
      extension: [],
      user: [{ key: "ctrl+p", command: "quickOpen.show" }],
    },
    { log },
  );

  expect(table.lookup("ctrl+p", () => undefined)?.command).toBe("quickOpen.show");
  expect(log.entries().length).toBe(malformed.length);
  for (const entry of log.entries()) {
    expect(entry.level).toBe("warning");
  }
});

describe("createBindingTable — chord sequence keys (Req 4.4, design.md §6.3)", () => {
  test("lookup resolves a 2-stroke sequence key exactly like any other key", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.lookup("ctrl+k ctrl+s", contextOf())?.command).toBe("keybindings.open");
    // The bare prefix is not itself a bound key.
    expect(table.lookup("ctrl+k", contextOf())).toBeUndefined();
  });

  test("hasSequencePrefix is true for a real prefix of a bound sequence", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.hasSequencePrefix("ctrl+k", contextOf())).toBe(true);
  });

  test("hasSequencePrefix is false for a stroke that is not a prefix of anything", () => {
    const layers = layersOf({
      user: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.hasSequencePrefix("ctrl+z", contextOf())).toBe(false);
    // The full sequence itself is not a "prefix of something longer".
    expect(table.hasSequencePrefix("ctrl+k ctrl+s", contextOf())).toBe(false);
  });

  test("a prefix whose only continuation's when clause fails is not reported as a prefix", () => {
    const layers = layersOf({
      user: [
        {
          key: "ctrl+k ctrl+s",
          command: "keybindings.open",
          when: "editorTextFocus",
        },
      ],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.hasSequencePrefix("ctrl+k", contextOf({ editorTextFocus: false }))).toBe(
      false,
    );
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ editorTextFocus: true }))).toBe(
      true,
    );
  });

  test("hasSequencePrefix is true if ANY continuation of the prefix passes when, even if others don't", () => {
    const layers = layersOf({
      user: [
        {
          key: "ctrl+k ctrl+s",
          command: "editor.action.save",
          when: "false",
        },
        { key: "ctrl+k ctrl+d", command: "editor.action.deleteLine" },
      ],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.hasSequencePrefix("ctrl+k", contextOf())).toBe(true);
  });

  test("masked (removed) continuations do not count as a live prefix", () => {
    const layers = layersOf({
      defaults: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }],
      user: [{ key: "ctrl+k ctrl+s", command: "-keybindings.open" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    expect(table.hasSequencePrefix("ctrl+k", contextOf())).toBe(false);
  });

  test("normalization applies before sequence matching (mixed-case, unsorted modifiers)", () => {
    const layers = layersOf({
      user: [{ key: "Ctrl+K Shift+Ctrl+S", command: "keybindings.open" }],
    });
    const table = createBindingTable(layers, { log: createHostLog() });

    // normalizeKey operates per-stroke; each space-separated token is
    // normalized independently before joining, matching normalize.ts's
    // documented contract for chord splitting.
    expect(table.hasSequencePrefix("ctrl+k", contextOf())).toBe(true);
    expect(table.lookup("ctrl+k ctrl+shift+s", contextOf())?.command).toBe(
      "keybindings.open",
    );
  });
});

test("a removal entry with a when clause is skipped with a warning, leaving lower bindings intact", () => {
  const log = createHostLog();
  const table = createBindingTable(
    {
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      fallback: [],
      extension: [],
      user: [
        { key: "ctrl+p", command: "-quickOpen.show", when: "editorFocus" },
      ],
    },
    { log },
  );

  // The conditional removal is unsupported: the defaults binding survives
  // whether or not the clause would pass.
  expect(table.lookup("ctrl+p", () => true)?.command).toBe("quickOpen.show");
  expect(table.lookup("ctrl+p", () => false)?.command).toBe("quickOpen.show");
  expect(log.entries().some((e) => e.error.message.includes("conditional removals"))).toBe(true);
});
