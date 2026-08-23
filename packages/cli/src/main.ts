import pkg from "../package.json";
import type { Disposable, FileSystem, Manifest, ResolvedTheme, Tecode } from "@tecode/api";
import {
  applyConfiguredTheme,
  BASE_THEME_ID,
  createAssetResolver,
  createChordStateMachine,
  createCommandRegistry,
  createConfigService,
  createContextService,
  createDocumentManager,
  createEditorInputRouter,
  createEditorSessionService,
  createExtensionHost,
  createFileSystem,
  createFindService,
  createHighlightService,
  createHostLog,
  createLanguageRegistry,
  createLayoutStateService,
  createNoopStatusSink,
  createSlotRegistry,
  createTecodeApi,
  createThemeRegistry,
  createThemeService,
  createThemeSettingsWriter,
  loadExtensions,
  pathToUri,
  registerCoreConfiguration,
  registerTecodeAlias,
  registerThemeSelectCommand,
  wireEditorLangIdContext,
  wireThemeConfigSync,
  type BindingTable,
  type ChordStateMachine,
  type CommandRegistry,
  type ConfigService,
  type ContextService,
  type DiscoveryFs,
  type DocumentManager,
  type EditorInputRouter,
  type EditorSessionService,
  type ExtensionHost,
  type FindService,
  type HighlightService,
  type HostLog,
  type LanguageRegistry,
  type LayoutStateService,
  type LoadExtensionsResult,
  type PendingThemeContribution,
  type SlotRegistry,
  type StatusSink,
  type ThemeRegistry,
  type ThemeService,
} from "@tecode/core";
import {
  builtinLanguageGrammarAssets,
  builtinLanguageQueryAssets,
  builtinManifests,
  builtinThemeAssets,
} from "@tecode/builtin";
import { resolveStartupTarget, type StartupTarget } from "./argv";
import { buildExtensionDirMap, buildExtensionRecords } from "./extensionRecords";
import { createKeymapState, type KeymapState } from "./keymapState";
import { createBuiltinLanguageAssetsFs } from "./languageAssetsFs";
import { renderShellHeadless, renderShellToTerminal, type RenderShell } from "./renderShell";
import { createBuiltinThemeAssetsFs } from "./themeAssetsFs";
import { detectTerminalCapabilities } from "./terminalCapabilities";

/**
 * Every built-in manifest's own `<builtin>/<id>` synthetic directory (Req
 * 11.4, design.md §3) — matches `discovery.ts`'s
 * `sourcePath: \`<builtin>/${extensionId}\`` for `extensionId ===
 * manifest.id` (`extensionRecords.ts`'s `resolveExtensionDir` derives the
 * SAME string once discovery has actually run; this helper exists because
 * {@link buildAssemblyRoot}'s sync-phase built-in theme pre-load, below,
 * runs strictly BEFORE discovery does, so it has no `LoadedExtension` to
 * derive that directory from yet).
 */
export function builtinExtensionDir(manifestId: string): string {
  return `<builtin>/${manifestId}`;
}

/**
 * Build the `PendingThemeContribution[]`/`extensionId -> directory` pair
 * {@link ThemeRegistry.loadContributions} needs to pre-load every built-in
 * manifest's `contributes.themes` entries SYNCHRONOUSLY, ahead of
 * discovery (Req 11.4, design.md §3's "build the theme from the
 * configured theme's cached JSON... themes-default's JSON files are
 * embedded assets, so no extension activation is needed to paint").
 * `loadExtensions`'s own `pendingThemes` (the deferred-phase equivalent,
 * `host/registration.ts`) covers the exact same entries again once
 * discovery has actually run — a harmless re-registration
 * (`themeRegistry.ts`'s per-id generation guard: "later registrations
 * win", never a duplicate `list()` entry) that also picks up any
 * `user`/`workspace` theme extension this sync-phase pass cannot see yet.
 */
export function collectBuiltinPendingThemes(manifests: readonly Manifest[]): {
  pending: PendingThemeContribution[];
  extensionDirs: Record<string, string>;
} {
  const pending: PendingThemeContribution[] = [];
  const extensionDirs: Record<string, string> = {};
  for (const manifest of manifests) {
    const themes = manifest.contributes.themes ?? [];
    if (themes.length === 0) continue;
    extensionDirs[manifest.id] = builtinExtensionDir(manifest.id);
    for (const theme of themes) {
      pending.push({ extensionId: manifest.id, theme });
    }
  }
  return { pending, extensionDirs };
}

/**
 * Every core service {@link buildAssemblyRoot} wires together, plus the
 * assembled `tecode` object itself (Req 10.1, 10.2; design.md §12, §17;
 * Task 1.13's "Bun module alias registration" note, extended by Task
 * 1.15's full startup sequence below).
 */
export interface AssemblyRoot {
  log: HostLog;
  sink: StatusSink;
  commands: CommandRegistry;
  documents: DocumentManager;
  fs: FileSystem;
  config: ConfigService;
  context: ContextService;
  api: Tecode;
  /** The live slot registry backing both `tecode.ui.registerView` (via
   * `api`) and the rendered Shell — see this module's TSDoc on why both
   * must share the exact same instance. */
  slotRegistry: SlotRegistry;
  layoutState: LayoutStateService;
  /** The sync-phase FIRST-FRAME theme (Req 7.4, design.md §3): a snapshot
   * of `themeRegistry`'s always-present base theme, already quantized for
   * the detected color depth — `renderShell.tsx`'s `ShellRenderDeps.theme`
   * fallback for a render that has no `themeService` at all. Once
   * `themeService` exists (below), `ThemeProvider` uses it instead from the
   * very first render (`ui/theme.tsx`'s TSDoc) — this field stays for
   * every other caller/test that only wires the static `theme` prop. */
  theme: ResolvedTheme;
  /** The theme registry (Task 2.6, Req 7.1, 7.4, `ui/themeRegistry.ts`):
   * seeded synchronously with the built-in base theme (already quantized
   * for the terminal's detected color depth) before this function returns;
   * {@link runDeferredPhase} feeds `loadExtensions`'s `pendingThemes` into
   * it once discovery has run. */
  themeRegistry: ThemeRegistry;
  /**
   * Settles once every BUILT-IN manifest's `contributes.themes` entries
   * (Task 2.7, Req 11.4) — today, `themes-default`'s Dark Modern/Light
   * Modern — have finished loading into {@link themeRegistry} (this
   * function's `collectBuiltinPendingThemes`/`ThemeRegistry.
   * loadContributions`, served from `@tecode/builtin`'s embedded
   * `builtinThemeAssets` rather than a real file read — `themeAssetsFs.ts`'s
   * TSDoc). `runTecode` awaits this, strictly BEFORE `applyConfiguredTheme`
   * and `renderShell`, so the configured `workbench.colorTheme` default
   * (`config/coreDefaults.ts`'s `DEFAULT_COLOR_THEME_ID`) is genuinely
   * active for the very first frame — with zero extensions discovered,
   * registered, or activated yet (design.md §3's "no extension activation
   * is needed to paint"). Never rejects: `ThemeRegistry.loadContributions`
   * itself never throws (a failed individual load just falls back to the
   * base palette for that theme and reports through `log`/`sink`).
   */
  themesReadyPromise: Promise<void>;
  /** The live theme service (Task 2.6, Req 7.3, 7.5, `ui/themeService.ts`)
   * — `theme.select`'s preview/commit/revert target, `tecode.themes`'s real
   * backing (`api` above), and `renderShell.tsx`'s `ShellRenderDeps.
   * themeService` (live `useTheme()` re-renders). Starts on
   * {@link BASE_THEME_ID} (the only theme guaranteed loaded this early);
   * `runTecode` applies the actually-configured `workbench.colorTheme`
   * once `config.ready` settles (`ui/themeConfigSync.ts`'s
   * `applyConfiguredTheme`, this module's TSDoc on why that can't happen
   * synchronously here). */
  themeService: ThemeService;
  /** Live `workbench.colorTheme` config-change subscription
   * (`ui/themeConfigSync.ts`'s `wireThemeConfigSync`, Req 7.5). Disposed
   * alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  themeConfigSync: Disposable;
  /** The `theme.select` command registration (Req 7.5, `ui/
   * themeSelectCommand.ts`) — registered directly on `commands`, not
   * through `tecode.commands` (that module's TSDoc on the privilege
   * boundary). Disposed alongside every other startup-owned subscription
   * in {@link wireProcessExit}. */
  themeSelectCommand: Disposable;
  /** The resolved workspace root this root was built for. */
  workspaceRoot: string;
  /** The layered keybinding table, kept up to date across every startup
   * phase — see `keymapState.ts`'s TSDoc. */
  keymap: KeymapState;
  /** The live two-stroke chord state machine (Req 4.4, design.md §6.1,
   * §6.3), built once here against a small forwarding view over `keymap`
   * (see this function's TSDoc's "Live keymap table view") so it always
   * resolves strokes against the CURRENT binding table even though
   * `keymap.getTable()` swaps to a new table object on every config/
   * extension-registration change. */
  chordMachine: ChordStateMachine;
  /** Owns the active document uri and every open document's `EditorState`
   * (Task 2.2, `ui/editorSession.ts`) — the seam shared between the
   * rendered `Shell` (via `renderShell.tsx`'s `ShellRenderDeps`), the real
   * `tecode.editor`/`tecode.window.activeEditor` (Task 2.3, `api.
   * editorSession` above), and {@link editorInputRouter} below, which reads/
   * writes it directly, from outside React. */
  editorSession: EditorSessionService;
  /** Owns every tab's in-buffer find/replace state (Req 11.1, design.md
   * §13, `ui/findService.ts`) — backs `tecode.editor.find` (via `api`
   * below) and the rendered `Shell`'s `FindWidget` sibling (`renderShell.
   * tsx`'s `ShellRenderDeps`), so a command executed through `commands.
   * execute` and a keystroke typed into the widget both operate on the
   * exact same live state. */
  findService: FindService;
  /** The language registry (Task 2.8, Req 8.1-8.3, `languages/
   * languageRegistry.ts`): resolves a document's `languageId` from its
   * extension (`DocumentManagerDeps.resolveLanguageId`, wired below,
   * before `documents` is built) and backs `tecode.languages`' real
   * `register`/`getLanguage`/`getLanguageId` (via `api` above).
   * {@link runDeferredPhase} feeds `loadExtensions`'s `pendingLanguages`
   * into it once discovery has run, mirroring `themeRegistry`'s own
   * `pendingThemes` wiring. */
  languageRegistry: LanguageRegistry;
  /** The syntax-highlighting pipeline (Task 2.8, Req 8.1-8.3, design.md
   * §10, `languages/highlightService.ts`) — built against `documents` and
   * `languageRegistry` above, with the production `web-tree-sitter`-backed
   * parser backend (defaulted inside `createHighlightService`) and an
   * asset resolver whose filesystem seam is overlaid with `@tecode/
   * builtin`'s embedded `languages-basic` grammar/query assets (Task 2.9,
   * Req 8.4, 8.5, `createBuiltinLanguageAssetsFs`) so those 12 built-in
   * languages load without ever touching a real `fs.readFile` (this
   * extension has no real directory — `languageAssetsFs.ts`'s TSDoc).
   * Threaded to `renderShell.tsx`'s `ShellRenderDeps.highlightService`,
   * mirroring `findService`'s own composition-root wiring. A document whose
   * extension matches none of `languages-basic`'s (or any `user`/
   * `workspace` extension's) languages still resolves to `"plaintext"` and
   * never touches the parser backend at all (design.md §10's Req 8.3
   * bypass). */
  highlightService: HighlightService;
  /** Turns a keymap-fallthrough key event into a multi-cursor
   * `applyEdits` call (Req 4.6, 6.6, design.md §6.1, §8.3, Task 2.2) —
   * wired into `renderShellToTerminal`'s real `renderer.keyInput` listener
   * via `keyRouting.ts`'s `handleKeyEvent`. */
  editorInputRouter: EditorInputRouter;
  /** Keeps `context`'s `"editorLangId"` key in sync with
   * {@link editorSession}'s active document (Req 4.6, `ui/editorLangId.ts`).
   * Disposed alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  editorLangIdSync: Disposable;
  /**
   * Forward-reference box for the extension host (this module's TSDoc,
   * "Forward-referenced host wiring"): `undefined` until the deferred
   * phase ({@link runDeferredPhase}) assigns it. `commands`/`documents`/
   * `slotRegistry` above all close over `hostRef.current` rather than a
   * host instance directly, so they can be built in the sync phase, before
   * the host exists, and still reach it once it does.
   */
  hostRef: { current?: ExtensionHost };
}

/**
 * Build the `tecode` composition root and register the `"tecode"` module
 * alias (Req 10.1, 10.2, 1.4; design.md §2, §12, §17). `packages/cli` is
 * the one place allowed to import `@tecode/core` directly
 * (`eslint.config.mjs`'s layering rule) — this function is that wiring,
 * and the sync phase of Task 1.15's startup sequence (everything up to,
 * but not including, rendering the Shell) is entirely this function's
 * body.
 *
 * **Forward-referenced host wiring**: the extension host
 * ({@link ExtensionHost}, `@tecode/core`'s `createExtensionHost`) is built
 * in the *deferred* phase ({@link runDeferredPhase}), after discovery —
 * which itself needs `commands`/`slotRegistry` already registered so
 * lazy commands/views exist to attach to. But `commands.execute` on a lazy
 * command, `documents`' `onLanguage:*` firing, and `slotRegistry`'s lazy
 * view activation all need to reach the host *from here*, in the sync
 * phase. `hostRef` — a plain mutable box, read through an optional-chained
 * closure — is exactly the pattern `host/activation.ts`'s own TSDoc
 * documents for this: build the services that need the host first with a
 * closure over `hostRef.current`, build the host once discovery has run,
 * then assign it. Every call through `hostRef.current` before the deferred
 * phase assigns it is a documented, safe no-op (each dependency's own
 * `activateExtension?`/`onLanguageActivation?` is already optional and
 * guarded for exactly this "no host yet" case).
 *
 * `registerTecodeAlias` runs immediately after {@link createTecodeApi} and
 * strictly before any extension module import — {@link runDeferredPhase}'s
 * `loadModule()` closures (`extensionRecords.ts`) are the first (and only)
 * dynamic imports of extension code, always strictly after this function
 * returns.
 *
 * **Live keymap table view** (Req 4.4, design.md §6.1, Task 2.2):
 * `ChordStateMachineDeps.table` (`@tecode/core`'s `chords.ts`) is typed as
 * `Pick<BindingTable, "lookup" | "hasSequencePrefix">` — any object with
 * those two methods, not a snapshot of one specific `BindingTable`
 * instance. `keymap.getTable()` (`keymapState.ts`) swaps to a brand-new
 * `BindingTable` object on every `setUserEntries`/`setExtensionEntries`
 * call (config reload, extension discovery finishing), so `chordMachine`
 * is built here against a small forwarding object whose `lookup`/
 * `hasSequencePrefix` call `keymap.getTable()` fresh on every invocation —
 * the chord machine therefore always resolves strokes against whichever
 * table is current, with no changes needed to `chords.ts` itself.
 */
export function buildAssemblyRoot(
  workspaceRoot: string = process.cwd(),
  deps: { log?: HostLog } = {},
): AssemblyRoot {
  const log = deps.log ?? createHostLog();
  // The UI shell is real now (PR #53), but nothing wires host/command
  // errors into it yet — that is the statusbar built-in's job
  // (`packages/builtin/statusbar`, still a placeholder) or a later
  // notification-area task, not Task 1.15's. Every other composition point
  // in `core` stays a no-op sink until one of those lands.
  const sink = createNoopStatusSink();

  const hostRef: { current?: ExtensionHost } = {};

  const commands = createCommandRegistry({
    log,
    sink,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });
  // Built before `documents` (Task 2.8, Req 8.3) so its `resolveLanguageId`
  // can be wired straight into `DocumentManagerDeps` below — every document
  // open resolves a real language id (or `"plaintext"`) from day one, not
  // `documentManager.ts`'s own stub default.
  const languageRegistry = createLanguageRegistry();
  const documents = createDocumentManager({
    log,
    sink,
    resolveLanguageId: languageRegistry.resolveLanguageId,
    onLanguageActivation: (id) => hostRef.current?.onLanguage(id),
  });
  // The highlight service (Task 2.8, Req 8.1-8.3, design.md §10): built
  // right after `documents`/`languageRegistry` exist, with the production
  // asset resolver (real `node:fs/promises`) and parser backend (real
  // `web-tree-sitter`, `createHighlightService`'s own default) — see
  // `AssemblyRoot.highlightService`'s TSDoc for why this is safe with zero
  // languages registered.
  // `fs: createBuiltinLanguageAssetsFs(...)` (Task 2.9, Req 8.4, 8.5):
  // overlays the SAME "built-in has no real directory" seam
  // `createBuiltinThemeAssetsFs` fixes for themes (above's TSDoc), so a
  // `languages-basic` language's `grammar`/`highlights` paths resolve from
  // `@tecode/builtin`'s embedded WASM/`.scm` maps instead of a real (never
  // present) `fs.readFile` under this extension's synthetic `<builtin>/<id>`
  // directory — in both dev and a `bun build --compile` binary alike
  // (`languageAssetsFs.ts`'s TSDoc).
  const highlightService = createHighlightService({
    documents,
    languageRegistry,
    assetResolver: createAssetResolver({
      fs: createBuiltinLanguageAssetsFs(builtinLanguageGrammarAssets, builtinLanguageQueryAssets),
    }),
    log,
    sink,
  });
  const fs = createFileSystem({ log });

  const keymap = createKeymapState(log);
  const config = createConfigService({
    log,
    sink,
    workspaceRoot,
    onKeybindingsChange: (entries) => keymap.setUserEntries(entries),
  });
  // Core's own settings (`editor.lineNumbers`, `editor.tabSize` — Req 9.5,
  // design.md §8.3's EditorView gutter/indentation) have no extension
  // manifest to flow through `loadExtensions`' `contributes.configuration`
  // handling (`host/registration.ts`), so register them directly, right
  // after the service exists — same seam an extension's schema would use,
  // just called once from the composition root instead of from manifest
  // registration (`config/coreDefaults.ts`'s TSDoc).
  registerCoreConfiguration(config);
  const context = createContextService();

  const slotRegistry = createSlotRegistry({
    log,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });
  const layoutState = createLayoutStateService({ log, sink });

  // Sync-phase theme construction (Req 7.4, 11.4, design.md §3, §9):
  // color-depth detection is synchronous env-var sniffing
  // (`terminalCapabilities.ts`'s TSDoc), so it can run right here, ahead of
  // `createThemeRegistry`, with no risk to the first-frame budget.
  // `themeRegistry` seeds the built-in base theme synchronously (already
  // quantized for `colorDepth` if less than truecolor) — `theme` below is a
  // snapshot of it for `renderShell.tsx`'s static `ShellRenderDeps.theme`
  // fallback (this function's `AssemblyRoot.theme` TSDoc). `themeService`
  // starts on {@link BASE_THEME_ID} — the ACTUAL configured
  // `workbench.colorTheme` is applied once BOTH `config.ready` AND
  // `themesReadyPromise` (below) settle (`runTecode`, `ui/
  // themeConfigSync.ts`'s TSDoc explains why that can't happen
  // synchronously here). `themeSettingsWriter` backs `theme.select`'s
  // commit persistence (Req 7.5).
  //
  // `fs: createBuiltinThemeAssetsFs(builtinThemeAssets)` (Task 2.7) wires
  // EVERY load this registry ever performs — this pre-load AND the deferred
  // phase's `loadContributions` — through the embedded-asset overlay, so a
  // built-in theme's synthetic `<builtin>/<id>` path resolves identically
  // in dev and a compiled binary (`themeAssetsFs.ts`'s TSDoc) instead of
  // failing to a real (nonexistent) `fs.readFile` and silently falling
  // back to the base palette.
  //
  // `themesReadyPromise` kicks off every built-in manifest's
  // `contributes.themes` entries RIGHT NOW, synchronously — before
  // discovery has even run — so `runTecode` can await just this one
  // promise (not the full deferred phase) ahead of `applyConfiguredTheme`/
  // `renderShell` and have the configured default (Dark Modern) genuinely
  // active for the first frame, with zero extensions discovered or
  // activated yet (`collectBuiltinPendingThemes`'s TSDoc).
  const { colorDepth } = detectTerminalCapabilities();
  const themeRegistry = createThemeRegistry({
    colorDepth,
    log,
    sink,
    fs: createBuiltinThemeAssetsFs(builtinThemeAssets),
  });
  const theme = themeRegistry.get(BASE_THEME_ID)!.theme;
  const { pending: builtinPendingThemes, extensionDirs: builtinThemeDirs } =
    collectBuiltinPendingThemes(builtinManifests);
  const themesReadyPromise = themeRegistry.loadContributions(builtinPendingThemes, builtinThemeDirs);
  const themeSettingsWriter = createThemeSettingsWriter({ log, sink });
  const themeService = createThemeService({
    registry: themeRegistry,
    initialThemeId: BASE_THEME_ID,
    onCommit: (id) => {
      // Fire-and-forget (matches `layoutState.update`'s own debounced-
      // write shape): `commitTheme()`'s own contract is synchronous and
      // never-throwing; the write itself is serialized internally
      // (`themeSettingsWriter.ts`'s `writeChain`) and reports its own
      // failures through `log`/`sink` rather than rejecting.
      void themeSettingsWriter.write(id);
    },
    log,
  });

  // Task 2.2's shared editor state seam (Req 4.6, 6.6, design.md §6.1,
  // §8.1, §8.3): built here, before `createTecodeApi`, so the REAL
  // `tecode.editor`/`tecode.window.activeEditor` (Task 2.3,
  // `api/editorNamespace.ts`) can be wired against it below — it is then
  // handed to both the rendered `Shell` (`renderShell.tsx`) and
  // `editorInputRouter` further down, so a keystroke routed outside React
  // updates exactly what `Shell` (and every extension reading `tecode.
  // editor`) sees.
  const editorSession = createEditorSessionService({ documents });
  // Task 2.5's find/replace service (Req 11.1, design.md §13) — built
  // against the SAME `editorSession` so `tecode.editor.find` and the
  // rendered `Shell`'s `FindWidget` share one live state, exactly like
  // `editorSession` itself is shared above.
  const findService = createFindService({ editorSession });

  const api = createTecodeApi({
    commands,
    documents,
    fs,
    rootUri: pathToUri(workspaceRoot),
    config,
    context,
    sink,
    slotRegistry,
    editorSession,
    findService,
    themeRegistry,
    themeService,
    languageRegistry,
  });

  // Must run before any extension module is imported (see this function's
  // TSDoc).
  registerTecodeAlias(api);

  // `theme.select` (Req 7.5, `ui/themeSelectCommand.ts`'s TSDoc): a
  // PRIVILEGED registration straight on `commands`, closing over
  // `themeService`'s preview/commit/revert directly — no equivalent exists
  // on `tecode.themes` (extensions never get this). `showQuickPick` comes
  // from `api.window` — still `createWindowStub`'s inert stub until Task
  // 3.1's real quick-pick UI lands (that module's TSDoc).
  const themeSelectCommand = registerThemeSelectCommand(commands, {
    themeRegistry,
    themeService,
    showQuickPick: api.window.showQuickPick,
    log,
  });

  // Live `workbench.colorTheme` config-change subscription (Req 7.5,
  // `ui/themeConfigSync.ts`'s TSDoc) — the INITIAL value is applied by
  // `runTecode` after `config.ready` settles, not here (same TSDoc).
  const themeConfigSync = wireThemeConfigSync({ config, themeService });

  // The live keymap table view (this function's TSDoc) — a thin forwarding
  // object, not a snapshot, so `chordMachine` below always resolves
  // against whichever `BindingTable` `keymap` currently holds.
  const liveTable: Pick<BindingTable, "lookup" | "hasSequencePrefix"> = {
    lookup: (stroke, get) => keymap.getTable().lookup(stroke, get),
    hasSequencePrefix: (sequence, get) => keymap.getTable().hasSequencePrefix(sequence, get),
  };
  const chordMachine = createChordStateMachine({
    table: liveTable,
    execute: (commandId) => commands.execute(commandId),
    getContext: (key) => context.get(key),
    log,
  });

  // `editorSession` was built earlier (above `createTecodeApi`) — see that
  // call site's comment. `editorInputRouter` reads/writes it directly, from
  // outside React.
  const editorInputRouter = createEditorInputRouter({ context, editorSession });
  const editorLangIdSync = wireEditorLangIdContext({ editorSession, context });

  return {
    log,
    sink,
    commands,
    documents,
    fs,
    config,
    context,
    api,
    slotRegistry,
    layoutState,
    theme,
    themeRegistry,
    themesReadyPromise,
    themeService,
    themeConfigSync,
    themeSelectCommand,
    workspaceRoot,
    keymap,
    chordMachine,
    editorSession,
    findService,
    languageRegistry,
    highlightService,
    editorInputRouter,
    editorLangIdSync,
    hostRef,
  };
}

/** What {@link runDeferredPhase} produced. */
export interface DeferredStartupResult {
  extensionHost: ExtensionHost;
  loadResult: LoadExtensionsResult;
}

/** Options for {@link runDeferredPhase}. */
export interface RunDeferredPhaseOptions {
  /** The argv-resolved file to open once extensions have registered (Req
   * 12.1's "open the initial file"). `undefined` for a directory/no-arg
   * launch. */
  initialFilePath?: string;
  /** Built-in manifests to discover alongside `user`/`workspace`
   * extensions. Defaults to `@tecode/builtin`'s `builtinManifests`
   * (currently `[]` — see that module's TSDoc); overridable for tests. */
  builtins?: Manifest[];
  /** Discovery's filesystem seam passthrough — production never sets
   * this; tests use it for hermeticity (matches `discovery.test.ts`'s
   * `createHermeticFs`, which blocks scanning the *real* user extensions
   * directory during an in-process test). */
  fs?: DiscoveryFs;
}

/**
 * Task 1.15's deferred phase (design.md §3's step 2, scheduled via
 * `queueMicrotask` by {@link runTecode} after the first frame): discover →
 * validate → register every extension (`loadExtensions`), fire
 * `onStartup` activations, then open the argv-resolved initial file
 * (firing `onLanguage:*` via `documents.openDocument`).
 *
 * Exported separately from {@link runTecode} (which drives the full CLI,
 * including `process.exit` in headless mode) so it can be exercised
 * in-process in tests without any risk of exiting the test runner itself.
 */
export async function runDeferredPhase(
  root: AssemblyRoot,
  options: RunDeferredPhaseOptions = {},
): Promise<DeferredStartupResult> {
  const loadResult = await loadExtensions({
    log: root.log,
    sink: root.sink,
    commands: root.commands,
    configRegistrar: root.config,
    builtins: options.builtins ?? builtinManifests,
    workspaceRoot: root.workspaceRoot,
    fs: options.fs,
  });

  // Feed registration's extension keybindings into the keymap's extension
  // layer now that they are known (Phase 2's plan) — the user layer was
  // already wired synchronously via ConfigService's onKeybindingsChange.
  root.keymap.setExtensionEntries(loadResult.extensionKeybindings);

  // Feed every `contributes.themes` entry discovered by `loadExtensions`
  // into the theme registry now that both the contributions AND each
  // owning extension's real directory are known (Req 7.1, Task 2.6) —
  // `buildExtensionDirMap` derives that directory the exact same way
  // `buildExtensionRecords` does for `loadModule`'s dynamic `import()`
  // (`extensionRecords.ts`'s `resolveExtensionDir`). Once every load has
  // settled, re-apply `workbench.colorTheme` (`ui/themeConfigSync.ts`'s
  // `applyConfiguredTheme`) so a configured theme that only just finished
  // loading (rather than the sync-phase's `BASE_THEME_ID` placeholder)
  // takes effect retroactively — a safe no-op if it was already active or
  // still unknown.
  await root.themeRegistry.loadContributions(
    loadResult.pendingThemes,
    buildExtensionDirMap(loadResult.loaded),
  );
  applyConfiguredTheme(root.config, root.themeService);

  // Feed every `contributes.languages` entry discovered by `loadExtensions`
  // into the language registry (Task 2.8, Req 8.1-8.3) — the same
  // `extensionId -> directory` map the theme registry's own
  // `loadContributions` call above uses, so a language's `grammar`/
  // `highlights` paths (`highlightService.ts`'s asset resolver) resolve
  // against the correct owning extension's directory once it's actually
  // used.
  await root.languageRegistry.loadContributions(
    loadResult.pendingLanguages,
    buildExtensionDirMap(loadResult.loaded),
  );

  const extensionHost = createExtensionHost({
    extensions: buildExtensionRecords(loadResult.loaded),
    api: root.api,
    log: root.log,
    sink: root.sink,
  });
  // Fulfills every forward reference `buildAssemblyRoot` built
  // (`hostRef`) — commands/documents/slotRegistry can now actually reach
  // activation.
  root.hostRef.current = extensionHost;

  await extensionHost.activateStartupExtensions();

  if (options.initialFilePath) {
    // Fires onLanguage:* via DocumentManagerDeps.onLanguageActivation,
    // which is exactly hostRef.current.onLanguage now that it is assigned
    // above.
    await root.documents.openDocument(pathToUri(options.initialFilePath));
  }

  return { extensionHost, loadResult };
}

/** Emit one structured, single-line JSON metric to stdout — the
 * CI-parseable timing/order channel this task's plan calls for.
 * `HostLog` (`@tecode/core`'s `host/errors.ts`) has no dedicated
 * metrics/info level (only `error`/`warning`), so shoehorning a timing
 * line into it would misuse that schema; stdout is what both the manual
 * smoke check and the subprocess integration test actually parse. */
function emitMetric(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Emit a step marker, only when `TECODE_VERBOSE=1` (this task's plan:
 * "verbose behind an env flag") — the baseline `tecode.timing` first-frame
 * metric below is always emitted regardless. */
function emitVerboseStep(startedAt: number, step: string): void {
  if (process.env["TECODE_VERBOSE"] !== "1") return;
  emitMetric("tecode.step", { step, ms: performance.now() - startedAt });
}

/** Options for {@link runTecode}. */
export interface RunTecodeOptions {
  /** Forces headless mode on/off. Defaults to `TECODE_HEADLESS=1` or "no
   * real TTY on stdout" (this task's adaptation) — see this module's
   * TSDoc. */
  headless?: boolean;
  /** Overrides the render seam — tests substitute their own to observe
   * ordering without a real terminal OR the built-in headless no-op.
   * Defaults to {@link renderShellHeadless} when `headless`, else
   * {@link renderShellToTerminal}. */
  renderShell?: RenderShell;
  /** Overrides the built-in manifest list passed to `loadExtensions` —
   * tests only; production always uses `@tecode/builtin`'s
   * `builtinManifests`. */
  builtins?: Manifest[];
  /** Overrides `process.cwd()` — tests only. */
  cwd?: string;
}

/** Sets up graceful-shutdown handling (Phase 3's "wire process-exit
 * disposeAll"). A synchronous Node/Bun `"exit"` handler cannot await async
 * cleanup, so this listens for `SIGINT`/`SIGTERM` instead — the standard
 * pattern for a CLI that needs to flush/dispose before actually exiting —
 * and calls `process.exit(0)` itself once cleanup settles. Idempotent: a
 * second signal while shutdown is already in flight is a no-op. */
function wireProcessExit(root: AssemblyRoot): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await root.layoutState.flush();
    root.config.dispose();
    root.chordMachine.dispose();
    root.findService.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    root.highlightService.dispose();
    root.languageRegistry.dispose();
    await root.hostRef.current?.disposeAll();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
}

/** What {@link runTecode} produced, for a non-headless (real) run — a
 * headless run instead calls `process.exit(0)` itself once the deferred
 * phase completes and never returns this. */
export interface RunTecodeResult {
  root: AssemblyRoot;
  extensionHost: ExtensionHost;
  loadResult: LoadExtensionsResult;
  firstFrameMs: number;
}

/**
 * Run the full startup sequence (Req 12.1, 12.2; design.md §3, §15): the
 * sync phase (argv → {@link buildAssemblyRoot} → config ready → terminal
 * capabilities → render the Shell = "first frame"), then the deferred
 * phase ({@link runDeferredPhase}, scheduled via `queueMicrotask` so it
 * never runs synchronously ahead of the first frame above it), with
 * startup-to-first-frame timing instrumentation throughout.
 *
 * **Headless mode** (`TECODE_HEADLESS=1`, or no real TTY on stdout at
 * all): the render seam defaults to {@link renderShellHeadless} (never
 * opens a TTY) and, once the deferred phase completes, this function
 * flushes layout state, disposes the config service's file watchers and
 * the extension host, emits a final `tecode.headlessExit` metric, and
 * calls `process.exit(0)` itself — `ConfigService`'s real `fs.watch`
 * handles would otherwise keep the event loop (and the process) alive
 * forever with no UI to justify it. This is what makes `TECODE_HEADLESS=1
 * bun packages/cli/src/main.ts <path>` usable as a scriptable smoke check
 * and what the subprocess integration test relies on to observe a clean
 * exit.
 */
export async function runTecode(
  argv: readonly string[],
  options: RunTecodeOptions = {},
): Promise<RunTecodeResult> {
  const startedAt = performance.now();
  const headless = options.headless ?? (process.env["TECODE_HEADLESS"] === "1" || !process.stdout.isTTY);

  const log = createHostLog();
  const cwd = options.cwd ?? process.cwd();
  const target: StartupTarget = await resolveStartupTarget(argv, cwd, log);

  // `buildAssemblyRoot` already ran sync-phase terminal capability
  // detection (color depth, Req 7.4) to construct `root.themeRegistry` —
  // see that function's TSDoc. The Kitty Keyboard Protocol half of
  // `TerminalCapabilities` is still a fixed placeholder with nothing
  // downstream consuming it (Task 4.2's job — `terminalCapabilities.ts`'s
  // TSDoc).
  const root = buildAssemblyRoot(target.workspaceRoot, { log });
  await root.config.ready;
  emitVerboseStep(startedAt, "config-ready");

  // Task 2.7, Req 11.4: wait for the built-in themes' sync-phase pre-load
  // (`buildAssemblyRoot`'s `themesReadyPromise`) to settle BEFORE applying
  // the configured theme — otherwise the default `workbench.colorTheme`
  // (Dark Modern) would still be unknown to `themeRegistry` at this point
  // and `applyConfiguredTheme` below would no-op, leaving `BASE_THEME_ID`
  // active for the first frame instead. Never rejects (`AssemblyRoot.
  // themesReadyPromise`'s TSDoc), so no try/catch is needed here.
  await root.themesReadyPromise;
  emitVerboseStep(startedAt, "themes-ready");

  // Apply the ACTUAL configured `workbench.colorTheme` now that both
  // `config.ready` AND `themesReadyPromise` have settled (Req 7.5, 11.4) —
  // `buildAssemblyRoot`'s `themeService` started on `BASE_THEME_ID` because
  // neither was ready yet at that point (`AssemblyRoot.themeService`'s
  // TSDoc, `ui/themeConfigSync.ts`'s TSDoc). A safe no-op if the configured
  // id is STILL unknown (e.g. it names a `user`/`workspace` extension's
  // theme — `runDeferredPhase` retries this once discovery's own
  // `loadContributions` settles).
  applyConfiguredTheme(root.config, root.themeService);

  wireProcessExit(root);

  const renderShell = options.renderShell ?? (headless ? renderShellHeadless : renderShellToTerminal);
  await renderShell({
    slotRegistry: root.slotRegistry,
    layoutState: root.layoutState,
    context: root.context,
    commands: root.commands,
    theme: root.theme,
    themeService: root.themeService,
    documents: root.documents,
    config: root.config,
    editorSession: root.editorSession,
    findService: root.findService,
    highlightService: root.highlightService,
    chordMachine: root.chordMachine,
    editorInputRouter: root.editorInputRouter,
  });

  const firstFrameMs = performance.now() - startedAt;
  root.log.append("warning", {
    message: `[tecode:timing] first-frame ${firstFrameMs.toFixed(2)}ms`,
  });
  // `ts` is a raw performance.now() reading — directly comparable, within
  // this same process, against any other same-process reading (e.g. the
  // subprocess integration test's fixture extension logging its own
  // module-load time) without needing a shared wall-clock epoch.
  emitMetric("tecode.timing", { phase: "first-frame", ms: firstFrameMs, ts: performance.now() });

  // Deferred phase (design.md §3's step 2): queueMicrotask guarantees this
  // never runs synchronously ahead of the render above — the microtask
  // queue only drains after the current synchronous stack (including the
  // `await renderShell(...)` continuation) has yielded.
  const deferred = await new Promise<DeferredStartupResult>((resolveDeferred, rejectDeferred) => {
    queueMicrotask(() => {
      runDeferredPhase(root, {
        initialFilePath: target.initialFilePath,
        builtins: options.builtins,
      }).then(resolveDeferred, rejectDeferred);
    });
  });
  emitVerboseStep(startedAt, "deferred-complete");

  if (headless) {
    emitMetric("tecode.headlessExit", {
      loaded: deferred.loadResult.loaded.length,
      skipped: deferred.loadResult.skipped.length,
      ms: performance.now() - startedAt,
    });
    await root.layoutState.flush();
    root.config.dispose();
    root.chordMachine.dispose();
    root.findService.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    root.highlightService.dispose();
    root.languageRegistry.dispose();
    await deferred.extensionHost.disposeAll();
    process.exit(0);
  }

  return { root, extensionHost: deferred.extensionHost, loadResult: deferred.loadResult, firstFrameMs };
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
  await runTecode(argv);
}

// `import.meta.main` is Bun's "am I the entry point" check (true only when
// this file itself was executed, e.g. `bun run main.ts`; false when another
// module — such as this file's own test — imports it). Without this guard,
// importing `main.ts` for testing `buildAssemblyRoot`/`runDeferredPhase`
// would also run `main(process.argv.slice(2))` as an unwanted side effect,
// against the *importing* process's real argv, real `HOME`, and (in
// non-headless mode) a real TTY.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error("tecode failed to start:", cause);
    process.exit(1);
  });
}
