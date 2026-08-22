/**
 * Typed no-op/placeholder implementations of the `tecode.window`,
 * `tecode.editor`, `tecode.ui`, `tecode.languages`, and `tecode.themes`
 * namespaces (Req 10.1, design.md §12), for {@link createTecodeApi}
 * (`create.ts`) to wire in ahead of the tasks that give them real backing:
 *
 * - `window`/`editor` depend on the UI shell (Task 1.14) and active-editor
 *   tracking (a later editor task) — design.md §12 says as much for
 *   `window.showQuickPick`/`showInputBox` ("implemented on the shell's
 *   modal layer... since the palette and pickers must exist before any
 *   extension UI"). Until then, every read reports "nothing is active" and
 *   every action reports through the injected {@link StatusSink} rather
 *   than silently doing nothing (Req 10.1's contract stays observable even
 *   before there is a UI to observe).
 * - `languages`/`themes` registration is real (a `register` call returns a
 *   working, disposable registration extensions can rely on immediately),
 *   but nothing yet *consumes* the registry — grammar/theme resolution
 *   lands in later tasks (design.md §9, §8.2). `themes.current` returns a
 *   hardcoded base palette (design.md §12's own note that `ThemeProvider`
 *   starts with "a hardcoded base palette for now", Task 1.14) until a real
 *   theme loader can resolve one.
 * - `ui.registerView` is likewise a real, disposable registration with no
 *   renderer behind it yet (the UI shell's slot registry, Task 1.14);
 *   `List`/`Tree`/`Input`/`Tabs` are inert placeholder components (no
 *   dependency on React here — `@tecode/api`'s `ComponentType` is
 *   deliberately framework-agnostic, design.md §12).
 *
 * None of this throws: every method here follows the same never-throw
 * discipline as the rest of core (`registry.ts`, `documentManager.ts`,
 * `service.ts`) so a third-party extension calling into an unimplemented
 * corner of the API degrades gracefully instead of crashing the host.
 */

import type {
  ComponentType,
  Disposable,
  EditorNamespace,
  LanguageContribution,
  LanguagesNamespace,
  Position,
  ResolvedTheme,
  RGB,
  SlotId,
  StatusBarItem,
  ThemeContribution,
  ThemesNamespace,
  UiColorKey,
  UiNamespace,
  WindowNamespace,
} from "@tecode/api";
import type { StatusSink } from "../host/errors";

/**
 * The house "`Set` + guarded idempotent dispose" registration pattern
 * (mirrors `commands/registry.ts`'s `storeEntry`, `documentManager.ts`'s
 * `makeEvent`): `register` adds `entry` and returns a `Disposable` that
 * removes exactly that entry, safe to call more than once. Shared by every
 * stub registry below (`languages.register`, `themes.register`,
 * `ui.registerView`, `window.setStatusBarItem`) so register/dispose
 * symmetry is identical, and independently testable, across all of them.
 */
function createRegistrySet<T>(): {
  register(entry: T): Disposable;
  entries(): readonly T[];
} {
  const set = new Set<T>();
  return {
    register(entry: T): Disposable {
      set.add(entry);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          set.delete(entry);
        },
      };
    },
    entries() {
      return Array.from(set);
    },
  };
}

/** The primary cursor's placeholder position when there is no active
 * editor: the document origin (Req 10.1's `editor.cursor`). A fresh object
 * every call (not a shared singleton) — `Position` has no protection
 * against a caller mutating a returned instance, and a shared reference
 * would let one extension's accidental write leak into every subsequent
 * read across every extension. */
function originPosition(): Position {
  return { line: 0, character: 0 };
}

/**
 * A hardcoded base color palette (design.md §12, §9's "a theme that omits a
 * key falls back to the built-in base palette for it") — every
 * {@link UiColorKey} filled in with a plain dark-neutral scheme, standing in
 * until Task 1.14's `ThemeProvider`/a real theme loader (design.md §9)
 * resolves an actual theme. Not exported: `themes.current` is the only
 * sanctioned way to read it, so a future replacement of this value doesn't
 * ripple through other modules' imports.
 */
const BG: RGB = { r: 30, g: 30, b: 30 };
const FG: RGB = { r: 212, g: 212, b: 212 };
const ACCENT: RGB = { r: 0, g: 122, b: 204 };
const BORDER: RGB = { r: 60, g: 60, b: 60 };
const SELECTION: RGB = { r: 38, g: 79, b: 120 };
const MUTED: RGB = { r: 133, g: 133, b: 133 };
const WHITE: RGB = { r: 255, g: 255, b: 255 };

const BASE_COLORS: Record<UiColorKey, RGB> = {
  focusBorder: ACCENT,
  foreground: FG,
  "editor.background": BG,
  "editor.foreground": FG,
  "editor.lineHighlightBackground": { r: 40, g: 40, b: 40 },
  "editor.selectionBackground": SELECTION,
  "editor.selectionForeground": FG,
  "editor.inactiveSelectionBackground": { r: 38, g: 53, b: 71 },
  "editorLineNumber.foreground": MUTED,
  "editorLineNumber.activeForeground": FG,
  "editorCursor.foreground": FG,
  "editorIndentGuide.background": BORDER,
  "editorIndentGuide.activeBackground": { r: 99, g: 99, b: 99 },
  "editorWhitespace.foreground": { r: 99, g: 99, b: 99 },
  "activityBar.background": { r: 51, g: 51, b: 51 },
  "activityBar.foreground": FG,
  "activityBar.inactiveForeground": MUTED,
  "activityBar.border": BORDER,
  "activityBarBadge.background": ACCENT,
  "activityBarBadge.foreground": WHITE,
  "sideBar.background": { r: 37, g: 37, b: 38 },
  "sideBar.foreground": FG,
  "sideBar.border": BORDER,
  "sideBarTitle.foreground": FG,
  "sideBarSectionHeader.background": { r: 51, g: 51, b: 51 },
  "statusBar.background": ACCENT,
  "statusBar.foreground": WHITE,
  "statusBar.border": BORDER,
  "statusBar.debuggingBackground": { r: 205, g: 98, b: 14 },
  "statusBarItem.hoverBackground": { r: 0, g: 99, b: 166 },
  "tab.activeBackground": BG,
  "tab.activeForeground": FG,
  "tab.inactiveBackground": { r: 45, g: 45, b: 45 },
  "tab.inactiveForeground": MUTED,
  "tab.border": BORDER,
  "tab.activeBorder": ACCENT,
  "panel.background": BG,
  "panel.border": BORDER,
  "panelTitle.activeForeground": FG,
  "panelTitle.inactiveForeground": MUTED,
  "input.background": { r: 60, g: 60, b: 60 },
  "input.foreground": FG,
  "input.border": BORDER,
  "input.placeholderForeground": MUTED,
  "list.activeSelectionBackground": SELECTION,
  "list.activeSelectionForeground": FG,
  "list.inactiveSelectionBackground": { r: 55, g: 55, b: 55 },
  "list.hoverBackground": { r: 44, g: 44, b: 44 },
  "list.focusBackground": SELECTION,
  "scrollbarSlider.background": { r: 100, g: 100, b: 100 },
  "scrollbarSlider.hoverBackground": { r: 120, g: 120, b: 120 },
  "badge.background": ACCENT,
  "badge.foreground": WHITE,
  "button.background": ACCENT,
  "button.foreground": WHITE,
};

/** The placeholder {@link ResolvedTheme} `themes.current` returns until a
 * real theme loader lands (see this module's TSDoc). No syntax-highlight
 * `tokens` are populated — `Partial` means an empty object already
 * satisfies the type, and no consumer resolves capture styles yet. Frozen
 * (both the theme object and its `colors` map) so a caller mutating the
 * value it read back cannot corrupt every other extension's later read of
 * the same singleton `themes.current` reference. */
export function createBaseTheme(): ResolvedTheme {
  return Object.freeze({ colors: Object.freeze({ ...BASE_COLORS }), tokens: {} });
}

/**
 * {@link createWindowStub}'s return type: `WindowNamespace` plus
 * `registeredStatusBarItems`, a test-only introspection hook proving
 * `setStatusBarItem`'s register/dispose symmetry (there is no renderer yet
 * to observe it through, design.md §12) — `create.ts` narrows this away
 * when assembling the public, frozen `tecode.window` namespace, matching
 * its own "narrowing, not re-implementing" design (`create.ts`'s TSDoc).
 */
export interface WindowStub extends WindowNamespace {
  /** Every currently-registered status bar item; an item's entry is gone
   * once its `Disposable` has been disposed. */
  registeredStatusBarItems(): readonly StatusBarItem[];
}

/**
 * Build the `tecode.window` stub (Req 10.1). No UI shell exists yet (Task
 * 1.14) so every read reports "nothing active/no picker" and every action
 * is inert; `setStatusBarItem` is a real, disposable registration with no
 * renderer behind it yet.
 */
export function createWindowStub(): WindowStub {
  const statusBarItems = createRegistrySet<StatusBarItem>();
  return {
    get activeEditor() {
      return undefined;
    },
    showMessage() {
      // No UI shell yet (Task 1.14) — inert until the shell's notification
      // area exists. Never throws.
    },
    showQuickPick() {
      return Promise.resolve(undefined);
    },
    showInputBox() {
      return Promise.resolve(undefined);
    },
    setStatusBarItem(item: StatusBarItem) {
      return statusBarItems.register(item);
    },
    registeredStatusBarItems: statusBarItems.entries,
  };
}

/**
 * Build the `tecode.editor` stub (Req 10.1, design.md §12: "calls made with
 * no active editor no-op with a status-bar notice"). There is no
 * active-editor tracking yet, so this is *always* the no-active-editor
 * case — `selections` is empty, `cursor` is the document origin, and every
 * mutating call reports through `sink` rather than doing anything.
 */
export function createEditorStub(deps: { sink: StatusSink }): EditorNamespace {
  const { sink } = deps;

  function notifyNoActiveEditor(action: string): void {
    // Guarded: a broken/throwing sink must not make an editor call throw
    // (matches registry.ts's/documentManager.ts's notifySafely).
    try {
      sink.error({ message: `No active editor to ${action}.` });
    } catch {
      // Swallowed — see this module's TSDoc on the never-throw discipline.
    }
  }

  return {
    get selections() {
      return [];
    },
    get cursor() {
      return originPosition();
    },
    revealLine(line: number) {
      notifyNoActiveEditor(`reveal line ${line}`);
    },
    insertSnippet() {
      notifyNoActiveEditor("insert a snippet");
    },
    applyEdits() {
      notifyNoActiveEditor("apply edits");
    },
  };
}

/** An inert placeholder `ComponentType` — `@tecode/api` has no dependency
 * on React (or any UI framework, design.md §12), and no renderer exists
 * yet to give `List`/`Tree`/`Input`/`Tabs` real behavior. */
const notImplementedComponent: ComponentType = () => undefined;

/** One registered `ui.registerView` call. */
export interface RegisteredView {
  slot: SlotId;
  id: string;
  component: ComponentType;
}

/** {@link createUiStub}'s return type — see {@link WindowStub}'s TSDoc for
 * why a stub factory returns more than its `@tecode/api` namespace type. */
export interface UiStub extends UiNamespace {
  /** Every currently-registered view; an entry is gone once its
   * `Disposable` has been disposed. */
  registeredViews(): readonly RegisteredView[];
}

/**
 * Build the `tecode.ui` stub (Req 10.1, 6.3). `registerView` is a real,
 * disposable registration (the UI shell's slot registry, Task 1.14, is the
 * eventual consumer); `useTheme` reads whatever `getTheme` currently
 * returns, so it stays in sync with `tecode.themes.current` without this
 * module depending on `themes.ts` directly (the two are wired together in
 * `create.ts`).
 */
export function createUiStub(deps: { getTheme: () => ResolvedTheme }): UiStub {
  const views = createRegistrySet<RegisteredView>();
  return {
    registerView(slot: SlotId, id: string, component: ComponentType) {
      return views.register({ slot, id, component });
    },
    useTheme() {
      return deps.getTheme();
    },
    List: notImplementedComponent,
    Tree: notImplementedComponent,
    Input: notImplementedComponent,
    Tabs: notImplementedComponent,
    registeredViews: views.entries,
  };
}

/** {@link createLanguagesStub}'s return type — see {@link WindowStub}'s
 * TSDoc for why a stub factory returns more than its `@tecode/api`
 * namespace type. */
export interface LanguagesStub extends LanguagesNamespace {
  /** Every currently-registered contribution; an entry is gone once its
   * `Disposable` has been disposed. */
  registeredContributions(): readonly LanguageContribution[];
}

/**
 * Build the `tecode.languages` stub (Req 8.2, 10.1). `register` is a real,
 * disposable registration; `getLanguageId` always reports `"plaintext"`
 * (Req 8.3's documented fallback) since matching a `Uri` against
 * registered contributions is the real language registry's job (Task
 * 2.8) — `DocumentManager.resolveLanguageId` already returns the same
 * stub value independently (`buffer/documentManager.ts`) until that lands.
 */
export function createLanguagesStub(): LanguagesStub {
  const registrations = createRegistrySet<LanguageContribution>();
  return {
    register(contribution: LanguageContribution) {
      return registrations.register(contribution);
    },
    getLanguageId() {
      return "plaintext";
    },
    registeredContributions: registrations.entries,
  };
}

/** {@link createThemesStub}'s return type — see {@link WindowStub}'s TSDoc
 * for why a stub factory returns more than its `@tecode/api` namespace
 * type. */
export interface ThemesStub extends ThemesNamespace {
  /** Every currently-registered contribution; an entry is gone once its
   * `Disposable` has been disposed. */
  registeredContributions(): readonly ThemeContribution[];
}

/**
 * Build the `tecode.themes` stub (Req 7, 10.1). `register` is a real,
 * disposable registration; `current` always returns the hardcoded
 * {@link createBaseTheme} palette until a real theme loader (design.md §9)
 * can resolve a registered theme and track the active selection.
 */
export function createThemesStub(): ThemesStub {
  const registrations = createRegistrySet<ThemeContribution>();
  const baseTheme = createBaseTheme();
  return {
    register(contribution: ThemeContribution) {
      return registrations.register(contribution);
    },
    get current() {
      return baseTheme;
    },
    registeredContributions: registrations.entries,
  };
}
