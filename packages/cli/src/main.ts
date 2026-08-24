import pkg from "../package.json";
import type {
  Disposable,
  FileSystem,
  KeybindingContribution,
  Manifest,
  ResolvedTheme,
  Tecode,
} from "@tecode/api";
import {
  applyConfiguredTheme,
  BASE_THEME_ID,
  createAssetResolver,
  createChordPendingIndicator,
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
  createHostErrorStatusSink,
  createHostLog,
  createLanguageRegistry,
  createLayoutStateService,
  createModalService,
  createSlotRegistry,
  createTecodeApi,
  createThemeRegistry,
  createThemeService,
  createThemeSettingsWriter,
  createWebTreeSitterParserBackend,
  createWindowMessageService,
  loadExtensions,
  loadFallbackKeybindings,
  MODAL_DEFAULT_KEYBINDINGS,
  pathToUri,
  registerCoreConfiguration,
  registerExtensionsReloadCommand,
  registerKeybindingsCommands,
  registerModalCommands,
  registerOpenFileCommand,
  registerTabCommands,
  registerTecodeAlias,
  registerThemeSelectCommand,
  TAB_DEFAULT_KEYBINDINGS,
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
  type HostErrorStatusSink,
  type HostLog,
  type LanguageRegistry,
  type LayoutStateService,
  type LoadExtensionsResult,
  type ModalService,
  type PendingThemeContribution,
  type SlotRegistry,
  type StatusSink,
  type ThemeRegistry,
  type ThemeService,
  type WindowMessageService,
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
import { detectTerminalCapabilities, resolveKittyKeyboardSupport } from "./terminalCapabilities";
// `web-tree-sitter`'s OWN Emscripten runtime wasm (Finding 4, NOTICE.md's
// "Compiled-mode finding for Task 4.4") — distinct from any grammar's
// `.wasm` and needed by `Parser.init()` itself, BEFORE any grammar loads.
// Embedded with Bun's `"file"` loader exactly like `languages-basic/
// assets.ts` embeds grammar wasms: `path` is a real filesystem path under
// `bun run`, a `/$bunfs/...` virtual path once `bun build --compile`d, and
// `Bun.file(path).bytes()` reads the right bytes back either way. This has
// to live here, not in `@tecode/core` — `core` has no bundler-visible
// `.wasm` file of its own to embed (it depends on `web-tree-sitter` as an
// ordinary npm package, not a vendored asset), and `packages/cli` is the
// one composition root allowed to reach into `web-tree-sitter` directly for
// this.
import treeSitterRuntimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

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
  /**
   * The SAME object as {@link sink} — held here as its concrete,
   * disposable type (Task 3.4, Req 11.6, `ui/hostErrorSink.ts`) so shutdown
   * paths can dispose it without widening `sink`'s own `StatusSink` type
   * (services throughout this file depend on the narrow interface, per
   * `create.ts`'s "narrowing, not re-implementing" convention).
   */
  hostErrorSink: HostErrorStatusSink;
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
  /** The `workbench.action.files.openUri` command registration (Task 3.2,
   * Req 11.3, `ui/openFileCommand.ts`) — the privileged bridge command
   * `command-palette`'s file quick-open picks a file through, registered
   * directly on `commands` for the same privilege-boundary reason as
   * `themeSelectCommand` above. Disposed alongside every other
   * startup-owned subscription in {@link wireProcessExit}. */
  openFileCommand: Disposable;
  /** The 4 `tab.*` commands' registration (Task 3.5, Req 6.5, `ui/
   * tabCommands.ts`) — registered directly on `commands` for the same
   * privilege-boundary reason as `openFileCommand`/`themeSelectCommand`
   * above. Their default keybindings were already fed into `keymap`'s
   * `defaults` layer alongside `MODAL_DEFAULT_KEYBINDINGS`. Disposed
   * alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  tabCommands: Disposable;
  /** The `extensions.reload` command registration (Req 2.8, design.md
   * §4.4, `ui/extensionsReloadCommand.ts`) — registered directly on
   * `commands` for the same privilege-boundary reason as `openFileCommand`/
   * `themeSelectCommand`/`tabCommands` above: re-execing the whole process
   * is composition-root-only capability, not something `@tecode/api`
   * exposes. Disposed alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  extensionsReloadCommand: Disposable;
  /** The `keybindings.internal.ensureFile`/`keybindings.internal.
   * resolveTable` bridge commands' registration (Task 4.3, Req 11.7,
   * `ui/keybindingsCommands.ts`) — registered directly on `commands` for
   * the same privilege-boundary reason as `openFileCommand`/
   * `themeSelectCommand`/`tabCommands`/`extensionsReloadCommand` above.
   * Disposed alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  keybindingsCommands: Disposable;
  /** The resolved workspace root this root was built for. */
  workspaceRoot: string;
  /** The layered keybinding table, kept up to date across every startup
   * phase — see `keymapState.ts`'s TSDoc. */
  keymap: KeymapState;
  /**
   * Apply Task 4.2's Kitty Keyboard Protocol verdict (Req 4.7, design.md
   * §6.5) to `keymap`'s `fallback` layer: `isKittyCapable === false` loads
   * `keybindings.fallback.json` (the bundled asset, or the user's
   * `~/.config/tecode/keybindings.fallback.json` override —
   * `@tecode/core`'s `loadFallbackKeybindings`) into it via
   * `keymap.setFallbackEntries`; `true` clears it to `[]`. `runTecode`
   * calls this from `renderShell.tsx`'s `onCapabilitiesResolved` callback,
   * fed through `terminalCapabilities.ts`'s pure `resolveKittyKeyboardSupport`
   * first — this function itself takes the already-decided boolean, not a
   * raw capabilities value, so it stays decoupled from OpenTUI entirely
   * and can be called directly by a test with a canned verdict, with no
   * real `CliRenderer` (or even a real terminal environment) involved at
   * all — `keymapState.test.ts` already proves `setFallbackEntries` in
   * isolation; this is the one additional seam needed to prove the WIRING
   * from a verdict through the real loader to that setter, end to end.
   * Idempotent-safe to call more than once (each call is a fresh
   * `setFallbackEntries`, matching that setter's own plain-replace
   * contract) and never throws: `loadFallbackKeybindings` itself never
   * throws (`fallbackKeybindings.ts`'s TSDoc), and any other unexpected
   * failure is caught and logged rather than propagated, degrading to an
   * empty fallback layer.
   */
  applyKittyKeyboardVerdict(isKittyCapable: boolean): Promise<void>;
  /** The live two-stroke chord state machine (Req 4.4, design.md §6.1,
   * §6.3), built once here against a small forwarding view over `keymap`
   * (see this function's TSDoc's "Live keymap table view") so it always
   * resolves strokes against the CURRENT binding table even though
   * `keymap.getTable()` swaps to a new table object on every config/
   * extension-registration change. */
  chordMachine: ChordStateMachine;
  /** The chord-pending status bar indicator (Task 3.4, Req 4.4, `ui/
   * chordPendingIndicator.ts`) — disposed alongside every other
   * startup-owned subscription in {@link wireProcessExit}. */
  chordPendingIndicator: Disposable;
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
  /** The core-owned modal overlay's state/logic (Task 3.1, Req 10.1,
   * design.md §12) — backs the real `tecode.window.showQuickPick`/
   * `showInputBox` (via `api` above) and the rendered `ModalOverlay`
   * sibling (`renderShell.tsx`'s `ShellRenderDeps.modalService`). */
  modalService: ModalService;
  /** The `modal.*` commands' registration (Task 3.1, `ui/modalCommands.
   * ts`) — disposed alongside every other startup-owned subscription in
   * {@link wireProcessExit}. */
  modalCommands: Disposable;
  /** Backs the real `tecode.window.showMessage`/`setStatusBarItem` (Task
   * 3.1, Req 10.1, `ui/windowMessageService.ts`) against the SAME
   * `slotRegistry` above. Disposed alongside every other startup-owned
   * subscription in {@link wireProcessExit} so a pending `showMessage`
   * notice doesn't linger past shutdown. */
  windowMessageService: WindowMessageService;
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

/**
 * `extensions.reload`'s `reExec` closure (Req 2.8, design.md §4.4: "MVP
 * implementation re-execs the process (`Bun.spawn` of `process.execPath`
 * with the same argv, then exit)"). Lives here, not in `ui/
 * extensionsReloadCommand.ts`, for the same reason `theme.select`'s
 * `ThemeService` and `workbench.action.files.openUri`'s
 * `EditorSessionService` closures live in this file rather than their own
 * command modules: `Bun.spawn`/`process.exit` are composition-root-only
 * capabilities, and `extensionsReloadCommand.ts` is written to be testable
 * with a plain fake `reExec` instead of actually spawning a subprocess
 * (that module's own TSDoc).
 *
 * **`process.argv` shape caveat for `bun build --compile` binaries**: this
 * always drops exactly `argv[0]` (whatever the invoking path was) and
 * replaces it with `process.execPath` — under `bun run packages/cli/src/
 * main.ts ...args`, `argv` is `[bunExecutable, scriptPath, ...args]`, so
 * `argv.slice(1)` correctly keeps `[scriptPath, ...args]` and re-adds the
 * bun executable in front; under a compiled binary, `argv` collapses to
 * `[binaryPath, ...args]` with no separate script-path slot at all, so
 * `argv.slice(1)` is just `[...args]` and `execPath` (the binary itself
 * under `--compile`) stands in for `binaryPath`. Both forms reconstruct
 * the original invocation correctly PROVIDED `argv[0]` is genuinely the
 * path this process was invoked with (true for both of tecode's own
 * launch paths above) — this function assumes that, and does not attempt
 * to detect or special-case a `--compile` binary vs. a plain script run,
 * since dropping `argv[0]` and re-adding `execPath` happens to be exactly
 * right for both shapes without needing to tell them apart.
 *
 * **Known MVP limitation — the renderer is not torn down first.**
 * `process.exit()` fires neither `"beforeExit"` nor any signal, and
 * OpenTUI wires its terminal-restoring `CliRenderer.destroy()` to exactly
 * those two (`beforeExit` plus its `exitSignals` list: `SIGINT`,
 * `SIGTERM`, `SIGQUIT`, ...) and never to `"exit"`. `wireProcessExit`'s
 * own `shutdown()` is likewise signal-driven, so this path skips it too.
 * The parent therefore dies with the alternate screen, raw mode and the
 * Kitty keyboard flags still set. In the normal case that is invisible:
 * the child re-runs the same startup sequence and re-establishes all
 * three before it paints. It matters only if the child fails to start at
 * all, which leaves the terminal in raw mode with no process owning it
 * (`reset` recovers it). Fixing this properly needs the `CliRenderer` to
 * be reachable from here — `renderShell.tsx` deliberately does not expose
 * it today — so it is left as documented MVP behaviour, consistent with
 * design.md §4.4 calling the whole full-restart approach MVP-acceptable.
 * Layout state itself is NOT at risk either way: `extensions.reload`'s
 * handler awaits `layoutState.flush()` to completion before this function
 * is ever called (`ui/extensionsReloadCommand.ts`'s TSDoc).
 */
function reExecProcess(): void {
  Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(0);
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `@tecode/core`'s repeated `describeError` helper,
 * e.g. `keymap/bindingTable.ts`'s). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

export function buildAssemblyRoot(
  workspaceRoot: string = process.cwd(),
  deps: {
    log?: HostLog;
    /**
     * Overrides how `applyKittyKeyboardVerdict` loads the `fallback`
     * layer's entries when the terminal is NOT Kitty-capable — production
     * never sets this (it defaults to `@tecode/core`'s
     * `loadFallbackKeybindings` against the real filesystem); tests inject
     * a canned array instead, matching {@link RunDeferredPhaseOptions.fs}/
     * `builtins`' own "production never sets this; tests use it for
     * hermeticity" shape.
     */
    loadFallbackKeybindings?: () => Promise<KeybindingContribution[]>;
  } = {},
): AssemblyRoot {
  const log = deps.log ?? createHostLog();

  const hostRef: { current?: ExtensionHost } = {};

  // `slotRegistry` is built here, ahead of `sink` and everything else that
  // depends on `sink` (Task 3.4, Req 11.6): its own dependencies (`log`,
  // an `activateExtension` closure over `hostRef`, exactly like `commands`'
  // below) need nothing sink-related, so hoisting it costs nothing and lets
  // `hostErrorSink` — the REAL `StatusSink` implementation, `ui/
  // hostErrorSink.ts` — register its `statusBar.item` against the SAME
  // `slotRegistry` instance the rendered Shell's `StatusBar` reads from,
  // with no forward-reference box needed (unlike `hostRef` above, which
  // genuinely can't be avoided — the extension host needs `commands`/
  // `slotRegistry` to already exist). `main.ts`'s previous no-op sink
  // (`createNoopStatusSink`) named this exact gap in its own TSDoc: "that
  // is the statusbar built-in's job... or a later notification-area task."
  const slotRegistry = createSlotRegistry({
    log,
    activateExtension: (id) => hostRef.current?.activateExtension(id) ?? Promise.resolve(),
  });
  const hostErrorSink = createHostErrorStatusSink({ slotRegistry });
  const sink: StatusSink = hostErrorSink;

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
    // `backend`'s `runtimeWasm` (Finding 4, `parserBackend.ts`'s
    // `WebTreeSitterParserBackendDeps`): supplies `web-tree-sitter`'s own
    // runtime wasm as pre-embedded bytes so `Parser.init()` never tries (and
    // fails, inside a `bun build --compile` binary) to resolve
    // `tree-sitter.wasm` off a real filesystem path. A thunk, read lazily —
    // `getOrLoadLanguageAssets`'s own per-language cache means this can only
    // ever actually run once, on the first document of any registered
    // language.
    backend: createWebTreeSitterParserBackend({
      runtimeWasm: () => Bun.file(treeSitterRuntimeWasmPath).bytes(),
    }),
    log,
    sink,
  });
  const fs = createFileSystem({ log });

  // `MODAL_DEFAULT_KEYBINDINGS` (Task 3.1, `ui/modalCommands.ts`) is this
  // codebase's first real occupant of the `defaults` layer
  // (`keymapState.ts`'s TSDoc) — core-owned bindings, not an extension
  // manifest's. `TAB_DEFAULT_KEYBINDINGS` (Task 3.5, `ui/tabCommands.ts`)
  // joins it here, same layer, same reasoning.
  const keymap = createKeymapState(log, [...MODAL_DEFAULT_KEYBINDINGS, ...TAB_DEFAULT_KEYBINDINGS]);

  // Task 4.2's fallback-keymap loader (Req 4.7, design.md §6.5): defaults
  // to the real `@tecode/core` loader (bundled asset or the user's
  // `~/.config/tecode/keybindings.fallback.json` override) against the
  // real filesystem, closing over THIS root's own `log` — overridable by
  // `deps.loadFallbackKeybindings` for tests (this function's own
  // parameter TSDoc).
  const loadFallbackKeybindingsDep =
    deps.loadFallbackKeybindings ?? (() => loadFallbackKeybindings({ log }));

  /** `AssemblyRoot.applyKittyKeyboardVerdict` — see that field's TSDoc.
   * Guarded per house style (design.md §5, §14): `loadFallbackKeybindingsDep`
   * is documented never-throwing for the real loader, but an injected
   * test override has no such guarantee, so this still degrades to `[]`
   * and logs rather than letting a throw escape into `renderShell.tsx`'s
   * fire-and-forget `onCapabilitiesResolved` call site (`main.ts`'s
   * `runTecode`), where nothing would catch it. */
  // Generation token guarding {@link applyKittyKeyboardVerdict}'s async
  // gap — see that function's TSDoc. Same shape as `ui/themeLoader.ts`'s
  // per-id `loadGenerations` map, which solves the identical
  // "slow earlier load must not clobber a newer registration" problem.
  let kittyVerdictGeneration = 0;

  async function applyKittyKeyboardVerdict(isKittyCapable: boolean): Promise<void> {
    // Claim this verdict's generation BEFORE the early return, so that a
    // `true` verdict also invalidates any `false` verdict still awaiting
    // its loader below — that is the whole race being guarded against.
    //
    // `renderShell.tsx` calls back at most twice (that module's
    // "`.once`, not `.on`" contract): once synchronously with whatever
    // `renderer.capabilities` holds at mount — normally `null`, since the
    // capability query is a round trip that has not been answered yet,
    // which `resolveKittyKeyboardSupport` conservatively reads as NOT
    // Kitty-capable — and once more when the real answer arrives. On a
    // genuinely Kitty-capable terminal that is exactly a `false` verdict
    // followed by a `true` one. The `false` verdict starts an async
    // `loadFallbackKeybindings()`; the `true` verdict clears the layer
    // synchronously. Without this guard, the earlier load resolving after
    // that clear would re-apply the fallback overlay on a terminal that
    // does not need it, leaving e.g. `ctrl+g` bound to the palette
    // permanently.
    const generation = ++kittyVerdictGeneration;
    if (isKittyCapable) {
      keymap.setFallbackEntries([]);
      return;
    }
    let entries: KeybindingContribution[];
    try {
      entries = await loadFallbackKeybindingsDep();
    } catch (cause) {
      log.append("error", {
        message: `applyKittyKeyboardVerdict: loadFallbackKeybindings threw: ${describeError(cause)}`,
      });
      entries = [];
    }
    // Superseded while the loader was in flight — drop the stale result
    // rather than overwriting whatever the newer verdict already applied.
    if (generation !== kittyVerdictGeneration) return;
    keymap.setFallbackEntries(entries);
  }
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

  // Task 3.1's core-owned modal overlay layer (Req 10.1, design.md §12):
  // built before `createTecodeApi` so the REAL `tecode.window.
  // showQuickPick`/`showInputBox` can be wired against it below, exactly
  // like `editorSession`/`findService` above. `windowMessageService` backs
  // `showMessage`/`setStatusBarItem` against the SAME `slotRegistry`
  // instance the rendered `Shell`'s `StatusBar` reads from.
  const modalService = createModalService();
  const windowMessageService = createWindowMessageService({ slotRegistry });

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
    modalService,
    windowMessageService,
  });

  // Must run before any extension module is imported (see this function's
  // TSDoc).
  registerTecodeAlias(api);

  // The `modal.*` commands + their default keybindings (Task 3.1, `ui/
  // modalCommands.ts`'s TSDoc): registered directly on `commands`, NOT
  // through an extension manifest — the modal overlay is core-owned
  // infrastructure `theme.select`/`editor-core`'s find widget already
  // depend on existing. The default keybindings themselves were already
  // fed into `keymap`'s `defaults` layer above, ahead of `config`'s own
  // construction.
  const modalCommands = registerModalCommands(commands, modalService);

  // `theme.select` (Req 7.5, `ui/themeSelectCommand.ts`'s TSDoc): a
  // PRIVILEGED registration straight on `commands`, closing over
  // `themeService`'s preview/commit/revert directly — no equivalent exists
  // on `tecode.themes` (extensions never get this). `showQuickPick` comes
  // from `api.window`, now genuinely backed by `modalService` above (Task
  // 3.1) — live, real quick-pick UI, not a stub.
  const themeSelectCommand = registerThemeSelectCommand(commands, {
    themeRegistry,
    themeService,
    showQuickPick: api.window.showQuickPick,
    log,
  });

  // `workbench.action.files.openUri` (Task 3.2, Req 11.3, `ui/
  // openFileCommand.ts`'s TSDoc): another PRIVILEGED registration straight
  // on `commands`, closing over `documents`/`editorSession` directly —
  // `command-palette`'s file quick-open is this command's only caller
  // today, reaching it purely through `tecode.commands.execute`.
  const openFileCommand = registerOpenFileCommand(commands, {
    documents,
    editorSession,
    log,
  });

  // The 4 `tab.*` commands (Task 3.5, Req 6.5, `ui/tabCommands.ts`'s
  // TSDoc): another PRIVILEGED registration straight on `commands`,
  // closing over `documents`/`editorSession` directly, same as
  // `openFileCommand` above. `showQuickPick` comes from `api.window`,
  // backed by the same real `modalService` `theme.select` uses.
  const tabCommands = registerTabCommands(commands, {
    documents,
    editorSession,
    showQuickPick: api.window.showQuickPick,
    log,
  });

  // `extensions.reload` (Req 2.8, design.md §4.4, `ui/
  // extensionsReloadCommand.ts`'s TSDoc): another PRIVILEGED registration
  // straight on `commands`, closing over `layoutState` (already built
  // above) and `reExecProcess` (this module's TSDoc) — same
  // privilege-boundary reasoning as `themeSelectCommand`/`openFileCommand`/
  // `tabCommands` above.
  const extensionsReloadCommand = registerExtensionsReloadCommand(commands, {
    layoutState,
    reExec: reExecProcess,
    log,
  });

  // `keybindings.internal.ensureFile`/`keybindings.internal.resolveTable`
  // (Task 4.3, Req 11.7, `ui/keybindingsCommands.ts`'s TSDoc): another PAIR
  // of PRIVILEGED registrations straight on `commands`, same
  // privilege-boundary reasoning as `openFileCommand`/`themeSelectCommand`/
  // `tabCommands`/`extensionsReloadCommand` above — `keybindings-editor`
  // (the built-in) reaches both purely through `tecode.commands.execute`.
  // `getTable: () => keymap.getTable()` is a live getter, not a captured
  // `BindingTable` (matches `liveTable` below), so `showResolved` always
  // reflects whichever table `keymap` currently holds, including after a
  // live `keybindings.json` edit reloads the `user` layer.
  const keybindingsCommands = registerKeybindingsCommands(commands, {
    getTable: () => keymap.getTable(),
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
  // The chord-pending indicator (Task 3.4, Req 4.4, `ui/
  // chordPendingIndicator.ts`) — core-internal, wired directly against
  // `chordMachine`/`slotRegistry` here rather than through any extension
  // (a plain extension has no access to `ChordStateMachine`).
  const chordPendingIndicator = createChordPendingIndicator({ chordMachine, slotRegistry });

  // `editorSession` was built earlier (above `createTecodeApi`) — see that
  // call site's comment. `editorInputRouter` reads/writes it directly, from
  // outside React.
  const editorInputRouter = createEditorInputRouter({ context, editorSession });
  const editorLangIdSync = wireEditorLangIdContext({ editorSession, context });

  return {
    log,
    sink,
    hostErrorSink,
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
    openFileCommand,
    tabCommands,
    extensionsReloadCommand,
    keybindingsCommands,
    workspaceRoot,
    keymap,
    applyKittyKeyboardVerdict,
    chordMachine,
    chordPendingIndicator,
    editorSession,
    findService,
    languageRegistry,
    highlightService,
    editorInputRouter,
    editorLangIdSync,
    modalService,
    modalCommands,
    windowMessageService,
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

  // Feed every `contributes.views` entry discovered by `loadExtensions`
  // into the slot registry now that discovery has actually run (`ui/
  // slotRegistry.ts`'s `SlotRegistry.seedPendingViews`'s TSDoc on why this
  // can't happen at construction time in this codebase's real startup
  // order: `buildAssemblyRoot`'s sync phase builds `slotRegistry` — and
  // renders the Shell from it — strictly before this deferred phase ever
  // runs, so `SlotRegistryDeps.pendingViews` at construction always sees
  // `[]`). This is what makes a real extension's `sidebar`/`panel` view
  // (e.g. `tecode.explorer`'s `sidebar` view, `explorer/manifest.ts`)
  // actually reach the rendered ActivityBar/Sidebar/Panel at all.
  root.slotRegistry.seedPendingViews(loadResult.pendingViews);

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
    root.chordPendingIndicator.dispose();
    root.chordMachine.dispose();
    root.findService.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    root.openFileCommand.dispose();
    root.tabCommands.dispose();
    root.extensionsReloadCommand.dispose();
    root.keybindingsCommands.dispose();
    root.modalCommands.dispose();
    root.modalService.dispose();
    root.windowMessageService.dispose();
    root.hostErrorSink.dispose();
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
  // see that function's TSDoc. The Kitty Keyboard Protocol half (Req 4.7,
  // design.md §6.5, Task 4.2) is NOT knowable synchronously
  // (`terminalCapabilities.ts`'s TSDoc) — it is wired below, through
  // `renderShell`'s `onCapabilitiesResolved` callback, once the render
  // seam has actually opened (or not opened, for `renderShellHeadless`) a
  // real terminal.
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
    modalService: root.modalService,
    // Task 4.2's Kitty Keyboard Protocol wiring (Req 4.7, 13.3, design.md
    // §6.5): `renderShell.tsx`'s `onCapabilitiesResolved` delivers the raw
    // `@opentui/core` capabilities value (at most twice — synchronously,
    // then again on a late `"capabilities"` event, that module's TSDoc);
    // `resolveKittyKeyboardSupport` (`terminalCapabilities.ts`) turns that
    // into a pure yes/no verdict against the real `$TERM`/`$TERM_PROGRAM`,
    // and `root.applyKittyKeyboardVerdict` feeds the result into
    // `keymap`'s `fallback` layer. Fire-and-forget (`void`, not
    // `await`ed): per this task's <100ms first-frame budget (design.md
    // §15), the fallback keymap becoming active a moment after the first
    // frame is fine — it only affects a keystroke handled after that
    // point — but blocking the first frame ON a filesystem read of the
    // fallback keymap file would not be.
    onCapabilitiesResolved: (capabilitiesValue) => {
      const isKittyCapable = resolveKittyKeyboardSupport(capabilitiesValue, {
        TERM: process.env["TERM"],
        TERM_PROGRAM: process.env["TERM_PROGRAM"],
      });
      void root.applyKittyKeyboardVerdict(isKittyCapable);
    },
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
    root.chordPendingIndicator.dispose();
    root.chordMachine.dispose();
    root.findService.dispose();
    root.editorSession.dispose();
    root.editorLangIdSync.dispose();
    root.themeConfigSync.dispose();
    root.themeSelectCommand.dispose();
    root.openFileCommand.dispose();
    root.tabCommands.dispose();
    root.extensionsReloadCommand.dispose();
    root.keybindingsCommands.dispose();
    root.modalCommands.dispose();
    root.modalService.dispose();
    root.windowMessageService.dispose();
    root.hostErrorSink.dispose();
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
