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
 *   extension UI"). Until a `ModalService`/`WindowMessageService` dep is
 *   supplied (Task 3.1, `create.ts`'s `CreateTecodeApiDeps.modalService`/
 *   `windowMessageService`), every read here reports "nothing is
 *   active/no picker" and every action reports through the injected
 *   {@link StatusSink} rather than silently doing nothing (Req 10.1's
 *   contract stays observable even before there is a UI to observe) — this
 *   is `create.ts`'s pre-Task-3.1 fallback path, still exercised by any
 *   caller/test that omits those deps.
 * - `languages`/`themes` registration is real (a `register` call returns a
 *   working, disposable registration extensions can rely on immediately),
 *   but nothing yet *consumes* the registry — grammar/theme resolution
 *   lands in later tasks (design.md §9, §8.2). `themes.current` returns a
 *   hardcoded base palette (design.md §12's own note that `ThemeProvider`
 *   starts with "a hardcoded base palette for now", Task 1.14) until a real
 *   theme loader can resolve one.
 * - `ui` is no longer stubbed here as of Task 1.14: `tecode.ui.registerView`
 *   delegates to the real `ui/slotRegistry.ts` (a live, rendered slot
 *   registry, not just a disposable-returning placeholder), and `List`/
 *   `Tree`/`Input`/`Tabs` are the real OpenTUI/React components in
 *   `ui/components.ts` — see `create.ts` for the wiring.
 *
 * None of this throws: every method here follows the same never-throw
 * discipline as the rest of core (`registry.ts`, `documentManager.ts`,
 * `service.ts`) so a third-party extension calling into an unimplemented
 * corner of the API degrades gracefully instead of crashing the host.
 */

import type {
  ClipboardNamespace,
  Disposable,
  EditorNamespace,
  FindNamespace,
  LanguageContribution,
  LanguagesNamespace,
  Listener,
  Position,
  PtyExitEvent,
  PtySession,
  ResolvedTheme,
  RGB,
  StatusBarItem,
  TerminalNamespace,
  ThemeContribution,
  ThemesNamespace,
  UiColorKey,
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
 * A real, register/dispose-symmetric `Event<void>` that never fires (Task
 * 3.4) — the shared shape for every stub `onDidChange` in this module
 * (`createEditorStub`'s, `createThemesStub`'s): there is nothing yet that
 * could change (no active editor; a stub theme registry has no live
 * "current theme" concept), but a caller subscribing must still get back a
 * working `Disposable`, not `undefined` or a throw, matching every other
 * inert-but-real surface in this file (`createFindStub`).
 */
function createInertEvent<T>(): { on: (listener: Listener<T>) => Disposable } {
  const listeners = new Set<Listener<T>>();
  return {
    on(listener: Listener<T>): Disposable {
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
        },
      };
    },
  };
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
  // Distinct from `editor.selectionBackground`/`editor.inactiveSelectionBackground`
  // (Req 11.1, `theme.ts`'s TSDoc): a warm amber for the CURRENT match, a
  // dimmer olive for every OTHER match — both read unambiguously as "a
  // search hit", not "a selection".
  "editor.findMatchBackground": { r: 148, g: 116, b: 25 },
  "editor.findMatchHighlightBackground": { r: 90, g: 85, b: 40 },
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
  // Deep-freeze via per-key RGB COPIES: the spread above only copies the
  // map, so freezing it alone would still hand out the mutable shared
  // BG/FG/... module constants — `theme.colors["editor.background"].r = 0`
  // would then corrupt every alias of that constant (panel.background,
  // tab.activeBackground) and every later createBaseTheme() result.
  const colors = Object.fromEntries(
    Object.entries(BASE_COLORS).map(([key, rgb]) => [key, Object.freeze({ ...rgb })]),
  ) as Record<UiColorKey, RGB>;
  return Object.freeze({ colors: Object.freeze(colors), tokens: Object.freeze({}) });
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
 * Build the `tecode.window` stub (Req 10.1) — `create.ts`'s fallback for
 * whichever of `showQuickPick`/`showInputBox` (no `modalService` dep) or
 * `showMessage`/`setStatusBarItem` (no `windowMessageService` dep) has no
 * real backing supplied (Task 3.1's TSDoc on both). Every read reports
 * "nothing active/no picker" and every action is inert;
 * `setStatusBarItem` here is a disposable registration into this stub's
 * OWN internal `Set` — NOT the real, rendered `SlotRegistry`
 * (`windowMessageService.ts`'s TSDoc explains why that distinction
 * matters).
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
 * Build the inert `tecode.editor.find` stub (Req 11.1, design.md §13) —
 * every one of `FindNamespace`'s 9 actions is a documented no-op. Used
 * whenever `create.ts` has no `FindService` to back `tecode.editor.find`
 * with: the no-`editorSession`-at-all case (`createEditorStub` below) and
 * any caller of `createEditorNamespace` (`editorNamespace.ts`) that omits
 * `find` (matching `EditorNamespaceDeps.find`'s own TSDoc). Never throws,
 * matching every other stub in this module.
 */
export function createFindStub(): FindNamespace {
  // Frozen (design.md §12's "every namespace object... is Object.freeze'd
  // shallowly") — `tecode.editor` itself is frozen by `create.ts`, but
  // `editor.find` is its own nested namespace-shaped object and needs the
  // same protection independently; the real, `FindService`-backed
  // `FindNamespace` `create.ts` builds gets the identical treatment.
  return Object.freeze({
    open() {},
    close() {},
    setQuery() {},
    setReplaceQuery() {},
    toggleCaseSensitive() {},
    next() {},
    previous() {},
    replaceCurrent() {},
    replaceAll() {},
  });
}

/**
 * Build the `tecode.editor` stub (Req 10.1, design.md §12: "calls made with
 * no active editor no-op with a status-bar notice"). There is no
 * active-editor tracking yet, so this is *always* the no-active-editor
 * case — `selections` is empty, `cursor` is the document origin, and every
 * mutating call reports through `sink` rather than doing anything.
 * `find` defaults to {@link createFindStub} — a caller with no
 * `FindService` at all (there is no active editor here in the first place)
 * gets the same inert no-op surface as the rest of this namespace.
 */
export function createEditorStub(deps: { sink: StatusSink; find?: FindNamespace }): EditorNamespace {
  const { sink } = deps;
  const onDidChangeEvent = createInertEvent<void>();

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
    getLine() {
      // No active editor: "" (Req 11.1's documented no-active-editor
      // default — `@tecode/api`'s `EditorNamespace.getLine` TSDoc), same
      // "report the harmless empty/zero default, never throw" policy as
      // every other read here.
      return "";
    },
    get lineCount() {
      return 0;
    },
    setSelections() {
      // No active editor: a documented no-op (`@tecode/api`'s
      // `EditorNamespace.setSelections` TSDoc) — there is nothing to write
      // back to, and unlike `revealLine`/`insertSnippet`/`applyEdits` this
      // is not itself an action that failed, so it does not notify.
    },
    find: deps.find ?? createFindStub(),
    // No active editor ever exists here (this function's TSDoc) — nothing
    // this stub owns can change, so `onDidChange` is a real, inert
    // Event<void> (`createInertEvent`'s TSDoc), never fired.
    onDidChange: onDidChangeEvent.on,
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
 * registered contributions needs the real language registry's extension
 * map (`languages/languageRegistry.ts`'s `LanguageRegistry`, Task 2.8) —
 * this stub stays in play only for a caller that does not supply
 * `CreateTecodeApiDeps.languageRegistry` (`create.ts`'s gating), same as
 * `DocumentManager.resolveLanguageId`'s own default
 * (`buffer/documentManager.ts`). `getLanguage` IS a real lookup by id over
 * whatever has been registered so far (Task 2.4) — unlike `getLanguageId`,
 * matching a already-known id against the registry needs no
 * file-extension resolution logic, so there is nothing here left to stub
 * out.
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
    getLanguage(id: string) {
      return registrations.entries().find((contribution) => contribution.id === id);
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
/**
 * Build the `tecode.clipboard` stub (Issue #91) — `create.ts`'s fallback
 * for a caller that supplies no `Clipboard` dependency at all (every test
 * that predates this task). Unlike `createFileSystem`'s real backing
 * (always constructed, never stubbed — `main.ts` builds one
 * unconditionally), a clipboard genuinely has nothing useful to do with no
 * backing buffer: `read()` always resolves `""`, and `write()` is a
 * documented no-op that never throws (this module's TSDoc's never-throw
 * discipline) — no extension can observe anything it "wrote" surviving
 * past this stub, exactly as if no clipboard existed at all.
 */
export function createClipboardStub(): ClipboardNamespace {
  return Object.freeze({
    read() {
      return Promise.resolve("");
    },
    write() {
      return Promise.resolve();
    },
  });
}

/**
 * Build the `tecode.terminal` stub (Issue #98) — `create.ts`'s fallback
 * for a caller that supplies no `TerminalService` at all (every test that
 * predates this issue, and `main.ts`'s own pre-Phase-5 startup wiring).
 * `isSupported()` always reports `false` (there is no real pty backing
 * this stub, so there is nothing to support) and `spawn()` always returns
 * the same inert-but-real session shape the REAL service degrades to on
 * an unsupported platform (`ptyService.ts`'s `createInertSession`): `write`/
 * `resize` are no-ops, `onData` never fires (a real, register/dispose-
 * symmetric `Event` that just never has anything to report — this file's
 * `createInertEvent` precedent), and `onExit` fires exactly once, shortly
 * after `spawn()` returns, with a negative sentinel exit code (matching
 * `PtySession.onExit`'s own documented "always observes it" guarantee for
 * a caller that subscribes right away). Never throws, matching every
 * other stub in this module.
 */
export function createTerminalStub(): TerminalNamespace {
  return Object.freeze({
    isSupported() {
      return false;
    },
    spawn(): PtySession {
      // `onExit` must actually fire once (`PtySession.onExit`'s own
      // documented "spawn on an unsupported platform fires once shortly
      // after this call returns" guarantee) — unlike this file's other
      // `createInertEvent`-based stubs (`onDidChange`s that never have
      // anything to report), this one manages its own listener set
      // directly so it can fire it.
      const exitListeners = new Set<Listener<PtyExitEvent>>();
      queueMicrotask(() => {
        for (const listener of Array.from(exitListeners)) {
          listener({ exitCode: -1 });
        }
      });
      return {
        write() {},
        resize() {},
        onData: createInertEvent<Uint8Array>().on,
        onExit(listener) {
          exitListeners.add(listener);
          let disposed = false;
          return {
            dispose() {
              if (disposed) return;
              disposed = true;
              exitListeners.delete(listener);
            },
          };
        },
        dispose() {},
      };
    },
  });
}

export function createThemesStub(): ThemesStub {
  const registrations = createRegistrySet<ThemeContribution>();
  const baseTheme = createBaseTheme();
  const onDidChangeEvent = createInertEvent<void>();
  return {
    register(contribution: ThemeContribution) {
      return registrations.register(contribution);
    },
    get current() {
      return baseTheme;
    },
    // Duplicated literal, not imported from `themeRegistry.ts`'s
    // `BASE_THEME_LABEL`: that module already imports `createBaseTheme`
    // FROM this one (this file's own TSDoc precedent for small
    // cross-module string duplication, matching `command-palette/index.ts`'s
    // `OPEN_FILE_COMMAND_ID`) — importing it back here would be circular.
    // Must stay in sync with `themeRegistry.ts`'s `BASE_THEME_LABEL`.
    get currentLabel() {
      return "Base (Built-in)";
    },
    registeredContributions: registrations.entries,
    // `current`/`currentLabel` never change here (this stub has no live
    // theme service behind it) — a real, inert `Event<void>` (this
    // module's TSDoc), matching `createEditorStub`'s own `onDidChange`.
    onDidChange: onDidChangeEvent.on,
  };
}
