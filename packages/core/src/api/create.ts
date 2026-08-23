/**
 * `createTecodeApi`: assembles the single frozen `tecode` object handed to
 * every extension (Req 10.1, 10.2; design.md §12; Task 1.13). Each
 * `tecode.*` namespace is either a thin, deliberately narrowed projection of
 * an already-built core service (`commands`, `workspace`, `config`,
 * `context`), a real implementation conditional on an optional dependency
 * (`window.activeEditor`, `editor` — real once `deps.editorSession` is
 * supplied, Task 2.3; the exact prior stub otherwise), or a documented
 * no-op/placeholder stub (`ui`, `languages`, `themes`, and `window`/`editor`
 * without `editorSession` — see `stubs.ts`'s TSDoc for why each is a stub
 * today).
 *
 * **Narrowing, not re-implementing** (design.md §12's "prevent accidental
 * monkey-patching across extensions" extends to the host itself): several
 * services expose more than their `tecode.*` projection —
 * `CommandRegistry.registerLazy` is host-internal (extensions never
 * manifest-declare lazy commands directly), and `ContextService.onDidChange`
 * is consumed by focus tracking/the keymap service, not by
 * `tecode.context`. Building each namespace object explicitly, naming only
 * the methods `@tecode/api` declares, is what keeps those extra surfaces
 * off the object extensions actually receive — a wildcard spread would leak
 * them.
 *
 * **Freezing**: every namespace object, and the aggregate object itself, is
 * `Object.freeze`d (shallowly — design.md §12) so no extension can
 * monkey-patch `tecode.commands.register` out from under another. Event/
 * method values are still the *same function references* the underlying
 * service owns, so delegation needs no wrapper closures beyond narrowing.
 */

import type {
  CommandsNamespace,
  ConfigNamespace,
  ContextNamespace,
  EditorNamespace,
  FileSystem,
  FindNamespace,
  LanguageContribution,
  LanguagesNamespace,
  Tecode,
  ThemeContribution,
  ThemesNamespace,
  UiNamespace,
  Uri,
  WindowNamespace,
  WorkspaceNamespace,
} from "@tecode/api";
import type { CommandRegistry } from "../commands/registry";
import type { DocumentManager } from "../buffer/documentManager";
import type { ConfigService } from "../config/service";
import type { ContextService } from "../keymap/context";
import type { StatusSink } from "../host/errors";
import type { EditorSessionService } from "../ui/editorSession";
import type { FindService } from "../ui/findService";
import { Input, List, Tabs, Tree } from "../ui/components";
import type { ModalService } from "../ui/modalService";
import { createSlotRegistry, type SlotRegistry } from "../ui/slotRegistry";
import type { ThemeRegistry } from "../ui/themeRegistry";
import type { ThemeService } from "../ui/themeService";
import type { WindowMessageService } from "../ui/windowMessageService";
import type { LanguageRegistry } from "../languages/languageRegistry";
import { cloneSelection, createEditorNamespace } from "./editorNamespace";
import {
  createEditorStub,
  createLanguagesStub,
  createThemesStub,
  createWindowStub,
} from "./stubs";

/** Dependencies {@link createTecodeApi} wires into the `tecode` object —
 * one already-built instance of each core service (design.md §12). */
export interface CreateTecodeApiDeps {
  /** Backs `tecode.commands`. Only `register`/`execute`/`list` are
   * exposed — `registerLazy` stays host-internal (see this module's
   * TSDoc). */
  commands: CommandRegistry;
  /** Backs `tecode.workspace.openDocument`/`documents`/`onDidOpen`/
   * `onDidClose`/`onDidSave`. */
  documents: DocumentManager;
  /** Backs `tecode.workspace.fs`. */
  fs: FileSystem;
  /** The open workspace's root, or `undefined` for a single-file session
   * with no enclosing workspace (`tecode.workspace.rootUri`, Req 10.1). */
  rootUri?: Uri;
  /** Backs `tecode.config.get`/`onDidChange` — `registerConfiguration` and
   * `getKeybindingEntries` stay host-internal. */
  config: ConfigService;
  /** Backs `tecode.context.set`/`get` — `onDidChange` stays host-internal
   * (consumed by focus tracking and the keymap service, not extensions). */
  context: ContextService;
  /** Where the `window`/`editor` stubs report user-facing errors (Req
   * 10.1, design.md §12's "no-active-editor no-ops with a status-bar
   * notice"). */
  sink: StatusSink;
  /**
   * Backs `tecode.ui.registerView` (Req 6.3, 10.1; design.md §8.2; Task
   * 1.14) — the live slot registry the Shell's regions render from.
   * Optional: a caller that has not wired discovery/activation yet (every
   * existing test in this suite, and any future caller that only needs the
   * namespace's shape) gets a registry built with no pending manifest
   * views and no activation hook — `registerView`'s register/dispose
   * symmetry still holds fully; only lazy-view activation
   * (`ui/slotRegistry.ts`'s `requestActivation`) has nothing to do. `cli`'s
   * real startup wiring (Task 1.15) passes the registry built alongside
   * `host/registration.ts`'s `LoadExtensionsResult.pendingViews` and
   * `host/activation.ts`'s `activateExtension`.
   */
  slotRegistry?: SlotRegistry;
  /**
   * Backs the REAL `tecode.editor` (Task 2.3's `editorNamespace.ts`) and
   * `tecode.window.activeEditor` — the active-document/selection seam Task
   * 2.2 built for the editor input router (`ui/editorSession.ts`).
   * Optional, narrowed to a `Pick` (`editorNamespace.ts`'s own dependency
   * shape): every caller that predates Task 2.3 (and any future caller
   * with genuinely no editor UI to back it) omits this and gets the exact
   * same "always no active editor" `editor`/`window.activeEditor` behavior
   * as before (`stubs.ts`'s `createEditorStub`/`createWindowStub`) — Task
   * 2.3 adds a real backing, not a breaking change to the stub contract.
   */
  editorSession?: Pick<EditorSessionService, "getActiveDocument" | "getState" | "setState">;
  /**
   * Backs `tecode.editor.find` (Req 11.1, design.md §13's "pure command
   * handlers... Find/replace state is per-editor, rendered as a...
   * inline widget"). Narrowed to the 9 actions `FindNamespace` declares —
   * `editor-core`'s find/replace commands delegate straight through them.
   * Optional, and ALSO requires `editorSession` above to be supplied AND
   * to be the very session this service is bound to (`create.ts`'s
   * `findNamespace` construction compares `findService.session` against
   * `editorSession` by identity) — a `FindService` is built around its own
   * `editorSession` reference (`findService.ts`'s
   * `FindServiceDeps.editorSession`), and one bound to a DIFFERENT session
   * would let `api.editor.find.replaceAll()` mutate documents
   * `window.activeEditor` never reports. A caller that omits either, or
   * passes a mismatched pair (every test that predates this task, and any
   * future caller with genuinely no find/replace UI to back it), gets
   * `createFindStub()`'s inert no-op surface instead of a breaking change
   * to the namespace shape.
   */
  findService?: Pick<
    FindService,
    | "session"
    | "open"
    | "close"
    | "setQuery"
    | "setReplaceQuery"
    | "toggleCaseSensitive"
    | "next"
    | "previous"
    | "replaceCurrent"
    | "replaceAll"
  >;
  /**
   * Backs the REAL `tecode.themes` (Task 2.6, `ui/themeRegistry.ts`) —
   * `register` delegates straight to `ThemeRegistry.register` (no
   * `baseDir`: a runtime `tecode.themes.register` call carries no
   * manifest/extension attribution, `themeRegistry.ts`'s own TSDoc on that
   * trade-off). Optional, and — like `findService` above — only takes
   * effect when {@link CreateTecodeApiDeps.themeService} is ALSO supplied
   * (`themesNamespace`'s own construction below): a caller that predates
   * Task 2.6 (every existing test) omits both and keeps `stubs.ts`'s
   * `createThemesStub` exactly as before — a real, disposable-returning
   * `register` with no consumer behind it, and `current` always the
   * hardcoded base palette.
   */
  themeRegistry?: Pick<ThemeRegistry, "register">;
  /** Backs `tecode.themes.current` (Task 2.6, `ui/themeService.ts`) — see
   * {@link CreateTecodeApiDeps.themeRegistry}'s TSDoc for the pairing
   * requirement. */
  themeService?: Pick<ThemeService, "get">;
  /**
   * Backs the REAL `tecode.languages` (Task 2.8, `languages/
   * languageRegistry.ts`) — `register`/`getLanguage` delegate straight to
   * the registry, and `getLanguageId` delegates to its
   * `resolveLanguageId` (Req 8.3). Optional, single-dependency gating
   * (unlike `themeRegistry`/`themeService`'s pairing — a `LanguageRegistry`
   * needs no separate "current selection" service the way themes do): a
   * caller that omits this (every test that predates this task) keeps
   * `stubs.ts`'s `createLanguagesStub` exactly as before.
   */
  languageRegistry?: Pick<LanguageRegistry, "register" | "getLanguage" | "resolveLanguageId">;
  /**
   * Backs the REAL `tecode.window.showQuickPick`/`showInputBox` (Task 3.1,
   * Req 10.1, design.md §12's "implemented on the shell's modal layer").
   * `ModalService.openQuickPick`/`openInputBox` already match
   * `WindowNamespace.showQuickPick`/`showInputBox`'s exact signatures, so
   * they are wired straight through with no wrapper closures (this module's
   * TSDoc's "narrowing, not re-implementing" — same "same function
   * references" freezing as `commandsNamespace`). Optional: a caller that
   * omits this (every test that predates Task 3.1) keeps `stubs.ts`'s
   * `createWindowStub()` pickers — both always resolve `undefined`
   * immediately, exactly as before.
   */
  modalService?: Pick<ModalService, "openQuickPick" | "openInputBox">;
  /**
   * Backs the REAL `tecode.window.showMessage`/`setStatusBarItem` (Task
   * 3.1, Req 10.1) — a real, disposable `statusBar.item` registration
   * against the SAME `slotRegistry` the rendered `Shell`'s `StatusBar`
   * reads from (`windowMessageService.ts`'s TSDoc), rather than
   * `stubs.ts`'s `createWindowStub()`'s own internal, never-rendered `Set`.
   * Optional, same fallback shape as every other real-backing dependency
   * above: a caller that omits this keeps the stub's inert `showMessage`
   * and disposable-but-unrendered `setStatusBarItem`.
   */
  windowMessageService?: Pick<WindowMessageService, "showMessage" | "setStatusBarItem">;
}

/**
 * Build the complete `tecode` API object (Req 10.1, 10.2; design.md §12).
 * The result — and each of its nine namespace objects — is shallowly
 * frozen; assigning to (or deleting) any property on either throws in
 * strict mode and is a silent no-op otherwise.
 */
export function createTecodeApi(deps: CreateTecodeApiDeps): Tecode {
  const commandsNamespace: CommandsNamespace = Object.freeze({
    register: deps.commands.register,
    execute: deps.commands.execute,
    list: deps.commands.list,
  });

  const workspaceNamespace: WorkspaceNamespace = Object.freeze({
    get rootUri() {
      return deps.rootUri;
    },
    openDocument: deps.documents.openDocument,
    get documents() {
      return deps.documents.documents;
    },
    fs: deps.fs,
    onDidOpen: deps.documents.onDidOpen,
    onDidClose: deps.documents.onDidClose,
    onDidSave: deps.documents.onDidSave,
    // `DocumentManager.save` resolves `boolean` (success/no-op both report
    // through `sink` already — see its own TSDoc) — `tecode.workspace.save`
    // narrows that to `Promise<void>` per its documented "always resolves,
    // never throws" contract (Req 11.1's save command doesn't need the
    // boolean; it would just be another thing every caller has to ignore).
    save: (uri: Uri) => deps.documents.save(uri).then(() => undefined),
  });

  const configNamespace: ConfigNamespace = Object.freeze({
    get: deps.config.get,
    onDidChange: deps.config.onDidChange,
  });

  const contextNamespace: ContextNamespace = Object.freeze({
    set: deps.context.set,
    get: deps.context.get,
  });

  // The window/editor/ui/languages/themes stubs each return more than
  // their `@tecode/api` namespace shape — a test-only introspection method
  // proving register/dispose symmetry with nothing yet consuming the
  // registration (`stubs.ts`'s `WindowStub`/`UiStub`/`LanguagesStub`/
  // `ThemesStub` TSDoc) — so, as with the delegated namespaces above, only
  // the namespace's own declared members are copied into the frozen object
  // extensions actually receive.
  const themesStub = createThemesStub();
  // Real backing (Task 2.6) only when BOTH a registry and a service are
  // supplied (`CreateTecodeApiDeps.themeRegistry`'s TSDoc) — a caller with
  // just one (should not happen in practice, but every other paired-deps
  // gate in this file — `findNamespace`'s `editorSession`+`findService` —
  // treats a partial pairing as "not wired yet" rather than guessing) gets
  // the stub instead.
  const realThemes =
    deps.themeRegistry && deps.themeService
      ? { registry: deps.themeRegistry, service: deps.themeService }
      : undefined;
  const themesNamespace: ThemesNamespace = Object.freeze({
    register: realThemes
      ? (contribution: ThemeContribution) => realThemes.registry.register(contribution)
      : themesStub.register,
    get current() {
      return realThemes ? realThemes.service.get() : themesStub.current;
    },
  });

  const windowStub = createWindowStub();
  const windowNamespace: WindowNamespace = Object.freeze({
    get activeEditor() {
      // Real backing (Task 2.3) when an `editorSession` was supplied;
      // otherwise the exact same "nothing is active" stub as before
      // (`windowStub.activeEditor`'s TSDoc) — see `CreateTecodeApiDeps.
      // editorSession`'s TSDoc for why both paths coexist. `document` here
      // is a `CoreDocument`, which structurally satisfies `@tecode/api`'s
      // `Document` (it only ADDS members — `document.ts`'s own TSDoc), so
      // no cast is needed to hand it back as `Editor.document`.
      if (!deps.editorSession) return windowStub.activeEditor;
      const document = deps.editorSession.getActiveDocument();
      if (!document) return undefined;
      // Deep-copied (Finding 2) — same reasoning as `editorNamespace.ts`'s
      // `cloneSelection` TSDoc: this reads through the same
      // `EditorSessionService` state `tecode.editor.selections` does, and
      // must not hand out the same mutable objects either.
      return {
        document,
        selections: deps.editorSession.getState(document.uri).selections.map(cloneSelection),
      };
    },
    // Task 3.1: real backing when the corresponding dep is supplied, else
    // the exact pre-Task-3.1 stub (`CreateTecodeApiDeps.modalService`/
    // `windowMessageService`'s own TSDoc) — same real function references,
    // no wrapper closures, matching every other delegated namespace here.
    showMessage: deps.windowMessageService ? deps.windowMessageService.showMessage : windowStub.showMessage,
    showQuickPick: deps.modalService ? deps.modalService.openQuickPick : windowStub.showQuickPick,
    showInputBox: deps.modalService ? deps.modalService.openInputBox : windowStub.showInputBox,
    setStatusBarItem: deps.windowMessageService
      ? deps.windowMessageService.setStatusBarItem
      : windowStub.setStatusBarItem,
  });

  // `tecode.editor.find` (Req 11.1, design.md §13): a ready-made
  // `FindNamespace` delegating straight to `deps.findService`'s methods
  // when supplied, so freezing it below has no wrapper closures to make —
  // `undefined` otherwise, which both `createEditorNamespace`/
  // `createEditorStub` default to `createFindStub()`'s inert surface
  // (`CreateTecodeApiDeps.findService`'s TSDoc). Gated on `deps.
  // editorSession`, `deps.findService`, AND their sessions being the SAME
  // instance (CodeRabbit findings on PR #59) — a `FindService` is built
  // around its OWN `editorSession` reference (`findService.ts`'s
  // `FindServiceDeps.editorSession`, surfaced as `findService.session`
  // exactly for this identity check). Wiring the real find methods
  // through against a different (or absent) session would let
  // `api.editor.find.replaceAll()` mutate a document via that other
  // session while `window.activeEditor`/`tecode.editor` (both driven only
  // by `deps.editorSession`) report a different active document or none
  // at all — breaking the no-active-editor no-op contract
  // `createEditorStub`'s TSDoc documents. On any mismatch, `findNamespace`
  // stays `undefined` and the editor namespace falls back to
  // `createFindStub()`'s fully inert surface.
  const findNamespace: FindNamespace | undefined =
    deps.editorSession && deps.findService && deps.findService.session === deps.editorSession
    ? Object.freeze({
        open: deps.findService.open,
        close: deps.findService.close,
        setQuery: deps.findService.setQuery,
        setReplaceQuery: deps.findService.setReplaceQuery,
        toggleCaseSensitive: deps.findService.toggleCaseSensitive,
        next: deps.findService.next,
        previous: deps.findService.previous,
        replaceCurrent: deps.findService.replaceCurrent,
        replaceAll: deps.findService.replaceAll,
      })
    : undefined;

  // Real backing (Task 2.3's `editorNamespace.ts`) when an `editorSession`
  // was supplied; otherwise the exact same stub as before (this module's
  // TSDoc, `CreateTecodeApiDeps.editorSession`'s TSDoc).
  const editorNamespace: EditorNamespace = Object.freeze(
    deps.editorSession
      ? createEditorNamespace({ sink: deps.sink, editorSession: deps.editorSession, find: findNamespace })
      : createEditorStub({ sink: deps.sink, find: findNamespace }),
  );

  // No slot registry injected (see CreateTecodeApiDeps.slotRegistry's
  // TSDoc) — build one with no pending manifest views and no activation
  // hook rather than falling back to a disposable-only stub; registerView
  // still round-trips correctly, and callers that DO need lazy-view
  // activation (the real CLI startup, Task 1.15) pass their own.
  const slotRegistry = deps.slotRegistry ?? createSlotRegistry({});
  const uiNamespace: UiNamespace = Object.freeze({
    registerView: slotRegistry.registerView,
    // A plain, non-hook getter (Req 10.1) — NOT the real React hook
    // `ui/theme.ts` exports under the same conceptual name. See
    // `ui/theme.ts`'s TSDoc ("Two different useThemes, deliberately") for
    // why `tecode.ui.useTheme()` must stay callable from plain extension
    // code (the contract test's fixture extension calls it from
    // `activate(ctx)`, outside any React render).
    useTheme: () => themesNamespace.current,
    List,
    Tree,
    Input,
    Tabs,
  });

  // Real backing (Task 2.8) when a `LanguageRegistry` is supplied;
  // otherwise the exact same stub as before (`CreateTecodeApiDeps.
  // languageRegistry`'s TSDoc).
  const languagesStub = createLanguagesStub();
  const languageRegistry = deps.languageRegistry;
  const languagesNamespace: LanguagesNamespace = Object.freeze({
    // Wrapped in a one-argument closure (matches `themesNamespace.register`
    // just above) — `LanguageRegistry.register`'s raw function accepts an
    // extra `baseDir` parameter at runtime (core-internal, for the
    // discovery/manifest path) that `LanguagesNamespace.register`'s
    // single-argument signature never declares; passing the bound method
    // straight through would let un-typechecked extension code supply it.
    register: languageRegistry
      ? (contribution: LanguageContribution) => languageRegistry.register(contribution)
      : languagesStub.register,
    getLanguageId: languageRegistry ? languageRegistry.resolveLanguageId : languagesStub.getLanguageId,
    getLanguage: languageRegistry ? languageRegistry.getLanguage : languagesStub.getLanguage,
  });

  return Object.freeze({
    commands: commandsNamespace,
    workspace: workspaceNamespace,
    window: windowNamespace,
    editor: editorNamespace,
    ui: uiNamespace,
    config: configNamespace,
    context: contextNamespace,
    languages: languagesNamespace,
    themes: themesNamespace,
  });
}
