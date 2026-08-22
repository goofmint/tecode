import { expect, test } from "bun:test";
import { createContextService } from "./context";

test("set then get round-trips the value", () => {
  const context = createContextService();

  context.set("editorLangId", "ts");

  expect(context.get<string>("editorLangId")).toBe("ts");
});

test("get on an unset key returns undefined", () => {
  const context = createContextService();

  expect(context.get("neverSet")).toBeUndefined();
});

test("set fires onDidChange with the changed key", () => {
  const context = createContextService();
  const seen: string[] = [];
  context.onDidChange((key) => seen.push(key));

  context.set("editorFocus", true);

  expect(seen).toEqual(["editorFocus"]);
});

test("setting a genuinely different value fires again with the same key", () => {
  const context = createContextService();
  const seen: string[] = [];
  context.onDidChange((key) => seen.push(key));

  context.set("editorLangId", "ts");
  context.set("editorLangId", "js");

  expect(seen).toEqual(["editorLangId", "editorLangId"]);
  expect(context.get<string>("editorLangId")).toBe("js");
});

test("setting an identical value does not fire onDidChange", () => {
  const context = createContextService();
  context.set("editorFocus", true);

  const seen: string[] = [];
  context.onDidChange((key) => seen.push(key));
  context.set("editorFocus", true);

  expect(seen).toEqual([]);
});

test("setting the same NaN value twice does not fire (Object.is semantics)", () => {
  const context = createContextService();
  context.set("metric", NaN);

  const seen: string[] = [];
  context.onDidChange((key) => seen.push(key));
  context.set("metric", NaN);

  expect(seen).toEqual([]);
});

test("dispose stops the listener from receiving further changes", () => {
  const context = createContextService();
  const seen: string[] = [];
  const subscription = context.onDidChange((key) => seen.push(key));

  context.set("a", 1);
  subscription.dispose();
  context.set("a", 2);

  expect(seen).toEqual(["a"]);
  expect(context.get<number>("a")).toBe(2);
});

test("double-dispose is a no-op", () => {
  const context = createContextService();
  const subscription = context.onDidChange(() => undefined);

  subscription.dispose();
  expect(() => subscription.dispose()).not.toThrow();
});

test("multiple listeners each receive the change", () => {
  const context = createContextService();
  const seenA: string[] = [];
  const seenB: string[] = [];
  context.onDidChange((key) => seenA.push(key));
  context.onDidChange((key) => seenB.push(key));

  context.set("explorerFocus", true);

  expect(seenA).toEqual(["explorerFocus"]);
  expect(seenB).toEqual(["explorerFocus"]);
});

test("distinct keys are stored independently", () => {
  const context = createContextService();

  context.set("editorFocus", true);
  context.set("explorerFocus", false);

  expect(context.get<boolean>("editorFocus")).toBe(true);
  expect(context.get<boolean>("explorerFocus")).toBe(false);
});
