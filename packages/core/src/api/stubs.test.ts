import { expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import {
  createBaseTheme,
  createEditorStub,
  createLanguagesStub,
  createThemesStub,
  createUiStub,
  createWindowStub,
} from "./stubs";

/** A `StatusSink` stub that records every error it receives (matches
 * `registry.test.ts`'s `createRecordingSink`). */
function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

test("createBaseTheme fills in every UiColorKey and is frozen", () => {
  const theme = createBaseTheme();

  // A representative sample of Req 7.2's six explicitly named keys, plus
  // the count check below for the full 55-key set (theme.ts's TSDoc).
  expect(theme.colors["editor.background"]).toBeDefined();
  expect(theme.colors["editor.foreground"]).toBeDefined();
  expect(theme.colors["sideBar.background"]).toBeDefined();
  expect(theme.colors["statusBar.background"]).toBeDefined();
  expect(theme.colors["tab.activeBackground"]).toBeDefined();
  expect(theme.colors["list.activeSelectionBackground"]).toBeDefined();
  expect(Object.keys(theme.colors)).toHaveLength(55);

  expect(Object.isFrozen(theme)).toBe(true);
  expect(Object.isFrozen(theme.colors)).toBe(true);
});

test("createBaseTheme returns a fresh, independently-frozen object each call", () => {
  const a = createBaseTheme();
  const b = createBaseTheme();

  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

test("window.setStatusBarItem: register/dispose symmetry", () => {
  const window = createWindowStub();
  const item = { id: "test.item", text: "hello", side: "left" as const, priority: 0 };

  const sub = window.setStatusBarItem(item);
  expect(window.registeredStatusBarItems()).toEqual([item]);

  sub.dispose();
  expect(window.registeredStatusBarItems()).toEqual([]);

  // Idempotent: a second dispose() must not throw or double-remove.
  expect(() => sub.dispose()).not.toThrow();
});

test("window stub: no active editor, inert actions, resolved-undefined pickers", async () => {
  const window = createWindowStub();

  expect(window.activeEditor).toBeUndefined();
  expect(() => window.showMessage("hi")).not.toThrow();
  await expect(window.showQuickPick([])).resolves.toBeUndefined();
  await expect(window.showInputBox()).resolves.toBeUndefined();
});

test("editor stub: no-active-editor reads and guarded sink notifications", () => {
  const { errors, sink } = createRecordingSink();
  const editor = createEditorStub({ sink });

  expect(editor.selections).toEqual([]);
  expect(editor.cursor).toEqual({ line: 0, character: 0 });

  editor.revealLine(5);
  editor.insertSnippet("foo");
  editor.applyEdits([]);

  expect(errors).toHaveLength(3);
  expect(errors.every((e) => e.message.startsWith("No active editor"))).toBe(true);
});

test("editor stub: cursor returns a fresh object each call (no shared mutable singleton)", () => {
  const { sink } = createRecordingSink();
  const editor = createEditorStub({ sink });

  const first = editor.cursor;
  first.line = 99;

  expect(editor.cursor).toEqual({ line: 0, character: 0 });
});

test("editor stub: a throwing sink does not make revealLine/insertSnippet/applyEdits throw", () => {
  const throwingSink = {
    error() {
      throw new Error("sink boom");
    },
  };
  const editor = createEditorStub({ sink: throwingSink });

  expect(() => editor.revealLine(1)).not.toThrow();
  expect(() => editor.insertSnippet("x")).not.toThrow();
  expect(() => editor.applyEdits([])).not.toThrow();
});

test("ui.registerView: register/dispose symmetry", () => {
  const ui = createUiStub({ getTheme: createBaseTheme });
  const component = () => undefined;

  const sub = ui.registerView("sidebar.view", "test.view", component);
  expect(ui.registeredViews()).toEqual([{ slot: "sidebar.view", id: "test.view", component }]);

  sub.dispose();
  expect(ui.registeredViews()).toEqual([]);
  expect(() => sub.dispose()).not.toThrow();
});

test("ui.useTheme delegates to the injected getTheme", () => {
  const theme = createBaseTheme();
  const ui = createUiStub({ getTheme: () => theme });

  expect(ui.useTheme()).toBe(theme);
});

test("ui stub's List/Tree/Input/Tabs are inert placeholder components", () => {
  const ui = createUiStub({ getTheme: createBaseTheme });

  expect(ui.List({})).toBeUndefined();
  expect(ui.Tree({})).toBeUndefined();
  expect(ui.Input({})).toBeUndefined();
  expect(ui.Tabs({})).toBeUndefined();
});

test("languages.register: register/dispose symmetry, getLanguageId always 'plaintext'", () => {
  const languages = createLanguagesStub();
  const contribution = {
    id: "fixture-lang",
    extensions: [".fx"],
    grammar: "g.wasm",
    highlights: "h.scm",
  };

  const sub = languages.register(contribution);
  expect(languages.registeredContributions()).toEqual([contribution]);

  expect(languages.getLanguageId("file:///a.fx")).toBe("plaintext");

  sub.dispose();
  expect(languages.registeredContributions()).toEqual([]);
  expect(() => sub.dispose()).not.toThrow();
});

test("themes.register: register/dispose symmetry; current is unaffected by registration", () => {
  const themes = createThemesStub();
  const contribution = { id: "fixture-theme", label: "Fixture", path: "theme.json" };
  const beforeCurrent = themes.current;

  const sub = themes.register(contribution);
  expect(themes.registeredContributions()).toEqual([contribution]);
  expect(themes.current).toBe(beforeCurrent);

  sub.dispose();
  expect(themes.registeredContributions()).toEqual([]);
  expect(() => sub.dispose()).not.toThrow();
});
