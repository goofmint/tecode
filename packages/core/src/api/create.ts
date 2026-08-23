/**
 * `createTecodeApi`: assembles the single frozen `tecode` object handed to
 * every extension (Req 10.1, 10.2; design.md §12; Task 1.13). Each
 * `tecode.*` namespace is either a thin, deliberately narrowed projection of
 * an already-built core service (`commands`, `workspace`, `config`,
 * `context`) or a documented no-op/placeholder stub (`window`, `editor`,
 * `ui`, `languages`, `themes` — see `stubs.ts`'s TSDoc for why each is a
 * stub today).
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
  LanguagesNamespace,
  Tecode,
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
import { Input, List, Tabs, Tree } from "../ui/components";
import { createSlotRegistry, type SlotRegistry } from "../ui/slotRegistry";
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
  const themesNamespace: ThemesNamespace = Object.freeze({
    register: themesStub.register,
    get current() {
      return themesStub.current;
    },
  });

  const windowStub = createWindowStub();
  const windowNamespace: WindowNamespace = Object.freeze({
    get activeEditor() {
      return windowStub.activeEditor;
    },
    showMessage: windowStub.showMessage,
    showQuickPick: windowStub.showQuickPick,
    showInputBox: windowStub.showInputBox,
    setStatusBarItem: windowStub.setStatusBarItem,
  });

  const editorNamespace: EditorNamespace = Object.freeze(createEditorStub({ sink: deps.sink }));

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

  const languagesStub = createLanguagesStub();
  const languagesNamespace: LanguagesNamespace = Object.freeze({
    register: languagesStub.register,
    getLanguageId: languagesStub.getLanguageId,
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
