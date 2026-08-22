import { describe, expect, spyOn, test } from "bun:test";
import { compileWhen, WhenParseError, __whenTestHooks } from "./when";

/** Build a context getter from a plain object, for table-driven tests. */
function contextOf(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}

describe("compileWhen — valid clauses", () => {
  const cases: {
    name: string;
    clause: string;
    context: Record<string, unknown>;
    expected: boolean;
  }[] = [
    { name: "bare truthy key", clause: "editorFocus", context: { editorFocus: true }, expected: true },
    { name: "bare falsy key", clause: "editorFocus", context: { editorFocus: false }, expected: false },
    {
      name: "bare key, unknown → falsy",
      clause: "editorFocus",
      context: {},
      expected: false,
    },
    {
      name: "string equality, match",
      clause: "editorLangId == 'ts'",
      context: { editorLangId: "ts" },
      expected: true,
    },
    {
      name: "string equality, mismatch",
      clause: "editorLangId == 'ts'",
      context: { editorLangId: "js" },
      expected: false,
    },
    {
      name: "string equality, double-quoted literal",
      clause: 'editorLangId == "ts"',
      context: { editorLangId: "ts" },
      expected: true,
    },
    {
      name: "string equality against unknown key",
      clause: "editorLangId == 'ts'",
      context: {},
      expected: false,
    },
    {
      name: "negation",
      clause: "!editorFocus",
      context: { editorFocus: false },
      expected: true,
    },
    {
      name: "double negation",
      clause: "!!editorFocus",
      context: { editorFocus: true },
      expected: true,
    },
    {
      name: "&& both true",
      clause: "a && b",
      context: { a: true, b: true },
      expected: true,
    },
    {
      name: "&& one false",
      clause: "a && b",
      context: { a: true, b: false },
      expected: false,
    },
    {
      name: "|| one true",
      clause: "a || b",
      context: { a: false, b: true },
      expected: true,
    },
    {
      name: "|| both false",
      clause: "a || b",
      context: { a: false, b: false },
      expected: false,
    },
    {
      name: "&& binds tighter than || (a || b && c), a true short-circuits",
      clause: "a || b && c",
      context: { a: true, b: false, c: false },
      expected: true,
    },
    {
      name: "&& binds tighter than || (a || b && c), a false needs b&&c",
      clause: "a || b && c",
      context: { a: false, b: true, c: false },
      expected: false,
    },
    {
      name: "&& binds tighter than || (a || b && c), a false, b&&c true",
      clause: "a || b && c",
      context: { a: false, b: true, c: true },
      expected: true,
    },
    {
      name: "parentheses override precedence: (a || b) && c, false",
      clause: "(a || b) && c",
      context: { a: true, b: false, c: false },
      expected: false,
    },
    {
      name: "parentheses override precedence: (a || b) && c, true",
      clause: "(a || b) && c",
      context: { a: true, b: false, c: true },
      expected: true,
    },
    {
      name: "negated group",
      clause: "!(a && b)",
      context: { a: true, b: true },
      expected: false,
    },
    {
      name: "whitespace tolerance: tabs/newlines/extra spaces",
      clause: "  a\t&&\n( b   ||c )  ",
      context: { a: true, b: false, c: true },
      expected: true,
    },
    {
      name: "combined equality and negation",
      clause: "editorTextFocus && !explorerFocus && editorLangId == 'ts'",
      context: { editorTextFocus: true, explorerFocus: false, editorLangId: "ts" },
      expected: true,
    },
  ];

  for (const { name, clause, context, expected } of cases) {
    test(`${name}: ${JSON.stringify(clause)}`, () => {
      const compiled = compileWhen(clause);
      expect(compiled.evaluate(contextOf(context))).toBe(expected);
      expect(compiled.source).toBe(clause);
    });
  }
});

describe("compileWhen — malformed clauses throw WhenParseError", () => {
  const badClauses = [
    "(a && b",
    "a && b)",
    "a &&",
    "&& a",
    "a ||",
    "a == 'ts'  extra",
    "a #b",
    "== 'ts'",
    "",
    "   ",
    "a =='unterminated",
    "a == ts",
    "!",
    "a && !",
  ];

  for (const clause of badClauses) {
    test(`throws on: ${JSON.stringify(clause)}`, () => {
      expect(() => compileWhen(clause)).toThrow(WhenParseError);
    });
  }

  test("WhenParseError message includes the offending clause", () => {
    try {
      compileWhen("a &&");
      throw new Error("expected compileWhen to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhenParseError);
      expect((err as WhenParseError).clause).toBe("a &&");
      expect((err as WhenParseError).message).toContain("a &&");
    }
  });
});

describe("compileWhen — AST-cache guarantee", () => {
  test("parses the clause exactly once, regardless of how many times evaluate is called", () => {
    const parseSpy = spyOn(__whenTestHooks, "parse");
    const before = parseSpy.mock.calls.length;

    const compiled = compileWhen("editorTextFocus && editorLangId == 'ts'");
    expect(parseSpy.mock.calls.length).toBe(before + 1);

    for (let i = 0; i < 5; i++) {
      compiled.evaluate(contextOf({ editorTextFocus: true, editorLangId: "ts" }));
    }

    expect(parseSpy.mock.calls.length).toBe(before + 1);
    parseSpy.mockRestore();
  });

  test("two separate compileWhen calls each parse once, independently", () => {
    const parseSpy = spyOn(__whenTestHooks, "parse");
    const before = parseSpy.mock.calls.length;

    compileWhen("a");
    compileWhen("b");

    expect(parseSpy.mock.calls.length).toBe(before + 2);
    parseSpy.mockRestore();
  });
});

test("eq against a Symbol context value is false rather than throwing", () => {
  const compiled = compileWhen("editorLangId == 'ts'");
  const get = (key: string) =>
    key === "editorLangId" ? Symbol("ts") : undefined;

  expect(compiled.evaluate(get)).toBe(false);
});
