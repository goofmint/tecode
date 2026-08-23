/**
 * Tests for {@link evaluateWhen}/{@link filterByWhen} (Task 3.2, Req 11.3;
 * design.md §13, tasks.md's "Tests: ... when-filtered listing") — grammar
 * coverage matching `@tecode/core`'s `keymap/when.ts` semantics (this
 * module's TSDoc), plus the "no `when` -> always shown" /
 * "malformed -> hidden" command-list-filtering contract.
 */

import { describe, expect, test } from "bun:test";
import { evaluateWhen, filterByWhen } from "./whenFilter";

function ctx(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}

describe("evaluateWhen (Task 3.2, Req 11.3)", () => {
  test("undefined or empty clause is always true (no restriction)", () => {
    expect(evaluateWhen(undefined, ctx({}))).toBe(true);
    expect(evaluateWhen("", ctx({}))).toBe(true);
    expect(evaluateWhen("   ", ctx({}))).toBe(true);
  });

  test("bare key truthiness", () => {
    expect(evaluateWhen("editorTextFocus", ctx({ editorTextFocus: true }))).toBe(true);
    expect(evaluateWhen("editorTextFocus", ctx({ editorTextFocus: false }))).toBe(false);
    expect(evaluateWhen("editorTextFocus", ctx({}))).toBe(false); // unknown key -> falsy
  });

  test("negation", () => {
    expect(evaluateWhen("!explorerFocus", ctx({ explorerFocus: false }))).toBe(true);
    expect(evaluateWhen("!explorerFocus", ctx({ explorerFocus: true }))).toBe(false);
  });

  test("&& has higher precedence than ||", () => {
    // a || (b && c): a false, b true, c false -> false || false -> false
    expect(evaluateWhen("a || b && c", ctx({ a: false, b: true, c: false }))).toBe(false);
    // a || (b && c): a false, b true, c true -> false || true -> true
    expect(evaluateWhen("a || b && c", ctx({ a: false, b: true, c: true }))).toBe(true);
  });

  test("parentheses override precedence", () => {
    // (a || b) && c
    expect(evaluateWhen("(a || b) && c", ctx({ a: true, b: false, c: false }))).toBe(false);
    expect(evaluateWhen("(a || b) && c", ctx({ a: true, b: false, c: true }))).toBe(true);
  });

  test("== compares the string form of the context value", () => {
    expect(evaluateWhen("editorLangId == 'ts'", ctx({ editorLangId: "ts" }))).toBe(true);
    expect(evaluateWhen("editorLangId == 'ts'", ctx({ editorLangId: "js" }))).toBe(false);
    expect(evaluateWhen('editorLangId == "ts"', ctx({ editorLangId: "ts" }))).toBe(true);
  });

  test("== against an unknown (undefined) key is always false", () => {
    expect(evaluateWhen("editorLangId == 'undefined'", ctx({}))).toBe(false);
  });

  test("== against a symbol value is false, never throws", () => {
    expect(evaluateWhen("x == 'y'", ctx({ x: Symbol("y") }))).toBe(false);
  });

  test("combinators compose with negation and equality", () => {
    expect(
      evaluateWhen("editorTextFocus && !explorerFocus", ctx({ editorTextFocus: true, explorerFocus: false })),
    ).toBe(true);
    expect(
      evaluateWhen("editorTextFocus && !explorerFocus", ctx({ editorTextFocus: true, explorerFocus: true })),
    ).toBe(false);
    expect(
      evaluateWhen(
        "editorLangId == 'ts' || editorLangId == 'tsx'",
        ctx({ editorLangId: "tsx" }),
      ),
    ).toBe(true);
  });

  test("malformed clauses resolve false rather than throwing", () => {
    expect(evaluateWhen("(unclosed", ctx({}))).toBe(false);
    expect(evaluateWhen("a &&", ctx({}))).toBe(false);
    expect(evaluateWhen("a == ", ctx({}))).toBe(false);
    expect(evaluateWhen("'unterminated", ctx({}))).toBe(false);
    expect(evaluateWhen("a ~~ b", ctx({}))).toBe(false);
    expect(evaluateWhen("a == 'b' extra", ctx({}))).toBe(false);
    expect(() => evaluateWhen("(((", ctx({}))).not.toThrow();
  });
});

interface FakeCommand {
  id: string;
  when?: string;
}

describe("filterByWhen (Task 3.2, Req 11.3's command-palette listing)", () => {
  test("a command with no when clause is always shown", () => {
    const commands: FakeCommand[] = [{ id: "a" }, { id: "b", when: "" }];
    expect(filterByWhen(commands, ctx({}))).toEqual(commands);
  });

  test("a command is hidden when its when clause evaluates false against context", () => {
    const commands: FakeCommand[] = [
      { id: "editor.action.find", when: "editorTextFocus" },
      { id: "explorer.reveal", when: "explorerFocus" },
    ];
    const shown = filterByWhen(commands, ctx({ editorTextFocus: true, explorerFocus: false }));
    expect(shown.map((c) => c.id)).toEqual(["editor.action.find"]);
  });

  test("a command with a malformed when clause is hidden", () => {
    const commands: FakeCommand[] = [
      { id: "good", when: "editorTextFocus" },
      { id: "bad", when: "(unclosed" },
    ];
    const shown = filterByWhen(commands, ctx({ editorTextFocus: true }));
    expect(shown.map((c) => c.id)).toEqual(["good"]);
  });
});
