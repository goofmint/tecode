/**
 * Shared end-to-end editing test harness (tasks.md's Task 2.10, Req 13.1;
 * design.md §15, §16): everything {@link "./editingScenario.e2e.test"} and
 * {@link "./typingBenchmark.test"} need to drive the REAL production
 * pipeline — real `AssemblyRoot` (`main.ts`'s `buildAssemblyRoot`/
 * `runDeferredPhase`, with a hermetic discovery `fs` so no test ever scans
 * the real machine's user extensions directory — matches
 * `themesPreFirstFrame.test.ts`'s own pattern), the real built-in
 * `themes-default`/`languages-basic`/`editor-core` extensions, the real
 * `web-tree-sitter` parser backend, and a `Shell` rendered through
 * OpenTUI's headless `testRender` with the exact same
 * `ThemeProvider`/`ContextFocusTracker`/`Shell` composition
 * `renderShell.tsx`'s `renderShellToTerminal` mounts onto a real terminal.
 *
 * **Why not a fake `ParserBackend`**: unlike almost every other test around
 * this pipeline (`parserBackend.ts`'s own TSDoc: "every OTHER test... uses a
 * mock backend"), this harness deliberately uses the REAL
 * `createWebTreeSitterParserBackend()` (`createHighlightService`'s own
 * default — nothing here overrides `backend`) — exactly like
 * `languagesBasicHighlights.test.ts` — because Task 2.10's whole point is
 * proving the pipeline works end to end, real grammar included. It runs
 * fine inside `testRender` (a real `web-tree-sitter` WASM load has no
 * dependency on a real TTY), so no fallback is needed.
 *
 * **Key routing**: `sendKey` calls `handleKeyEvent` (`keyRouting.ts`)
 * directly against the harness's own `root.chordMachine`/
 * `root.editorInputRouter` — the exact two collaborators
 * `renderShellToTerminal` wires to a real `renderer.keyInput` "keypress"
 * listener. Driving `handleKeyEvent` directly (rather than feeding raw
 * terminal bytes through OpenTUI's `mockInput`) keeps every keystroke this
 * harness sends exactly reproducible while still exercising tecode's own
 * real pipeline in full: `keyEventToStroke` -> chord state machine ->
 * binding lookup/`when` filter -> `commands.execute` (consumed) or
 * `editorInputRouter.routeKeyEvent` (passthrough) -> `document.applyEdits`.
 */

import {
  mkdir,
  readdir as nodeReaddir,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { ReactNode } from "react";
import type { TestRendererOptions } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { Disposable, Event, Listener, Manifest } from "@tecode/api";
import {
  applyConfiguredTheme,
  ContextFocusTracker,
  getUserExtensionsDir,
  ModalOverlay,
  Shell,
  ThemeProvider,
  type ContextService,
  type DiscoveryFs,
  type ExtensionHost,
  type HighlightService,
  type KeyEventLike,
  type LoadExtensionsResult,
} from "@tecode/core";
import { handleKeyEvent, type RoutableKeyEvent } from "./keyRouting";
import { buildAssemblyRoot, runDeferredPhase, type AssemblyRoot } from "./main";

/**
 * Blocks the real user extensions dir (matches `themesPreFirstFrame.
 * test.ts`'s/`main.test.ts`'s own `createHermeticDiscoveryFs` — kept as a
 * SEPARATE copy here, not an import from a `.test.ts` file, since test
 * files are not meant to be imported as modules) so no scenario/benchmark
 * test can ever scan (or be affected by) the real machine's
 * `~/.config/tecode/extensions`.
 */
export function createHermeticDiscoveryFs(): DiscoveryFs {
  const blockedUserDir = getUserExtensionsDir();
  return {
    async readdir(path) {
      if (path === blockedUserDir) {
        throw Object.assign(new Error("ENOENT (blocked for test hermeticity)"), { code: "ENOENT" });
      }
      return nodeReaddir(path);
    },
    async stat(path) {
      const stats = await nodeStat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
}

/** Options for {@link buildEditingHarness}. */
export interface EditingHarnessOptions {
  /** The real (temp-directory) workspace root documents open relative to. */
  workspaceRoot: string;
  /** A temp directory substituted for `HOME`/`APPDATA` for the duration of
   * `buildAssemblyRoot` (Req 9's config-file discovery reads `HOME` for the
   * user `settings.json`/`keybindings.json` paths) — restored immediately
   * after, exactly like `themesPreFirstFrame.test.ts`'s own env dance. */
  homeDir: string;
  /** Overrides the built-in manifest list — tests only; omitted uses
   * `@tecode/builtin`'s real `builtinManifests` (the production default,
   * `runDeferredPhase`'s own fallback). */
  builtins?: Manifest[];
}

/** What {@link buildEditingHarness} hands back. */
export interface EditingHarness {
  root: AssemblyRoot;
  extensionHost: ExtensionHost;
  loadResult: LoadExtensionsResult;
  /** Disposes every startup-owned subscription, mirroring `main.ts`'s
   * `wireProcessExit`/`themesPreFirstFrame.test.ts`'s own `finally` block —
   * call this in the test's own `finally` (or `afterEach`) so a failed
   * assertion never leaks a document-manager `fs.watch` handle or a live
   * highlight-service subscription into the next test. */
  dispose(): Promise<void>;
}

/**
 * Build a real `AssemblyRoot` and run it through the full startup sequence
 * up to (and including) the deferred phase — discovery, built-in
 * `themes-default`/`languages-basic`/`editor-core` registration and
 * `onStartup` activation — using a hermetic discovery `fs` (this module's
 * TSDoc). Mirrors `runTecode`'s own documented sync-phase ordering
 * (`main.ts`'s TSDoc: `config.ready` -> `themesReadyPromise` ->
 * `applyConfiguredTheme` -> deferred phase) rather than calling `runTecode`
 * itself, since that also opens a real render seam and installs real
 * `SIGINT`/`SIGTERM` handlers — exactly the same reasoning
 * `themesPreFirstFrame.test.ts` gives for doing the same.
 */
export async function buildEditingHarness(options: EditingHarnessOptions): Promise<EditingHarness> {
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = options.homeDir;
  process.env["APPDATA"] = options.homeDir;
  let root: AssemblyRoot;
  try {
    root = buildAssemblyRoot(options.workspaceRoot);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  await root.config.ready;
  await root.themesReadyPromise;
  applyConfiguredTheme(root.config, root.themeService);

  const { extensionHost, loadResult } = await runDeferredPhase(root, {
    builtins: options.builtins,
    fs: createHermeticDiscoveryFs(),
  });

  return {
    root,
    extensionHost,
    loadResult,
    async dispose() {
      await root.layoutState.flush();
      root.config.dispose();
      root.chordMachine.dispose();
      root.findService.dispose();
      root.editorSession.dispose();
      root.editorLangIdSync.dispose();
      root.themeConfigSync.dispose();
      root.themeSelectCommand.dispose();
      root.openFileCommand.dispose();
      root.highlightService.dispose();
      root.languageRegistry.dispose();
      await extensionHost.disposeAll();
    },
  };
}

/** Write `content` to `path`, creating parent directories as needed — a
 * thin convenience over `node:fs/promises` for tests writing a fixture
 * `.ts` file into their own temp scratch directory (never the repo, never
 * a real user directory). */
export async function writeFixtureFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await nodeWriteFile(path, content, "utf8");
}

/**
 * Deterministic, arbitrarily-long TypeScript source generator (Req 13.1's
 * "10,000-line file"): `Math.ceil(lineCount / 5)` exported functions, each
 * a fixed 5-line shape (`export function computeN(a, b) {...}`), so the
 * text is genuinely valid, parseable TypeScript throughout — not just
 * repeated noise — real enough to exercise the real `typescript.wasm`
 * grammar's incremental reparse on every edit, deterministic (no randomness
 * or wall-clock dependency) so a benchmark run is reproducible, and cheap
 * to build (`Array.prototype.join`, no per-line string concatenation).
 * `lines.slice(0, lineCount)` trims the final partial block down to exactly
 * `lineCount` lines when `lineCount` isn't a multiple of 5 (tree-sitter
 * tolerates the resulting trailing partial statement as an ordinary parse
 * error node — it never throws on invalid input).
 */
export function generateTypeScriptSource(lineCount: number): string {
  const LINES_PER_FUNCTION = 5;
  const functionCount = Math.ceil(lineCount / LINES_PER_FUNCTION);
  const lines: string[] = [];
  for (let i = 0; i < functionCount; i++) {
    lines.push(`export function compute${i}(a: number, b: number): number {`);
    lines.push(`  // step ${i}: sum two numbers and scale`);
    lines.push(`  const total = a + b + ${i};`);
    lines.push(`  return total * 2;`);
    lines.push(`}`);
  }
  return lines.slice(0, lineCount).join("\n") + "\n";
}

/** A real OpenTUI `KeyEvent`-shaped stroke, built the same way
 * `keyRouting.test.ts`'s own `keyOf` helper does — every field
 * `keyEventToStroke`/`classifyKeyEvent` (`chords.ts`/`inputRouter.ts`)
 * actually reads, with `sequence` defaulting to `name` (right for every
 * plain printable character this harness types; callers pass `sequence`
 * explicitly for anything else, e.g. `{ name: "return", sequence: "\r" }`). */
export function keyOf(partial: Partial<KeyEventLike> & { name: string }): RoutableKeyEvent {
  return {
    ctrl: false,
    shift: false,
    option: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    ...partial,
  };
}

/** Feed one key event through the REAL routing pipeline (this module's
 * TSDoc's "Key routing"): `handleKeyEvent` against the harness's own live
 * `chordMachine`/`editorInputRouter` — identical collaborators, identical
 * order, to `renderShellToTerminal`'s real `renderer.keyInput` listener. */
export function sendKey(root: Pick<AssemblyRoot, "chordMachine" | "editorInputRouter">, event: RoutableKeyEvent): void {
  handleKeyEvent({ chordMachine: root.chordMachine, editorInputRouter: root.editorInputRouter }, event);
}

/**
 * Await one firing of `event`, or reject after `timeoutMs` (default 5s) —
 * this module's "wait for highlight" helper, generalized to any
 * `@tecode/api` `Event<T>` (also used for `DocumentManager.onDidSave`,
 * whose completion this harness's callers need to await since
 * `editor.action.save`'s handler is genuinely async — Task 2.10's plan).
 * The timeout exists purely as a safety net against a genuine regression
 * hanging the test suite; every real call in this harness's own tests is
 * expected to resolve near-instantly, since the underlying pipeline
 * (`highlightService.ts`'s per-language asset cache, `DocumentManager.
 * save`'s real fs write+rename) is not gated on any external wall-clock
 * wait of its own.
 */
export function waitForEvent<T>(event: Event<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const box: { sub?: Disposable } = {};
    const timer = setTimeout(() => {
      box.sub?.dispose();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for an event to fire`));
    }, timeoutMs);
    const listener: Listener<T> = (value) => {
      clearTimeout(timer);
      box.sub?.dispose();
      resolve(value);
    };
    box.sub = event(listener);
  });
}

/** {@link waitForEvent} specialized to `HighlightService.onDidChange` — the
 * harness's named "wait for highlight" helper (tasks.md's Task 2.10 plan):
 * await one parse settling, THEN `renderOnce()` (the caller's job — this
 * only resolves once spans are ready to be read via `getSpansForLine`). */
export function waitForHighlightChange(
  highlightService: Pick<HighlightService, "onDidChange">,
  timeoutMs = 5_000,
): Promise<void> {
  return waitForEvent(highlightService.onDidChange, timeoutMs);
}

/** The narrow shape of an OpenTUI renderable this module's focus helpers
 * need — matches `shell.snapshot.test.tsx`'s own `findAllFocusable`/
 * `findInputByPlaceholder` idiom (loosely typed rather than importing
 * `BoxRenderable`, since neither helper needs anything renderable-specific
 * beyond these three members). */
interface FocusableLike {
  focusable?: boolean;
  focus?: () => void;
  blur?: () => void;
  getChildren?: () => unknown[];
}

/** Depth-first collection of every `focusable` descendant — copied from
 * `shell.snapshot.test.tsx`'s own helper of the same name (kept local rather than
 * imported, since that file is a test file, not a module other files are
 * meant to import). */
function findAllFocusable(node: unknown): FocusableLike[] {
  const candidate = node as FocusableLike;
  const found: FocusableLike[] = candidate?.focusable ? [candidate] : [];
  for (const child of candidate?.getChildren?.() ?? []) {
    found.push(...findAllFocusable(child));
  }
  return found;
}

/**
 * Focus the Shell's editor TEXT PLANE specifically (not its outer
 * `EditorArea` region box) — the real focus transition `editorInputRouter.
 * routeKeyEvent` gates every insert on (`editorTextFocus`), driven through
 * OpenTUI's OWN real `Renderable.focus()`/`FOCUSED` event dispatch exactly
 * like `shell.snapshot.test.tsx`'s "Finding 5" test does, rather than a shortcut
 * `context.set("editorTextFocus", true)` — this harness's whole point is
 * exercising the real, wired-together pipeline end to end (this module's
 * top TSDoc), and focus tracking is part of that pipeline (Req 4.6).
 * Returns `true` once a focused node is found that actually sets the key;
 * `false` (leaving every candidate focused-then-blurred) if none does —
 * e.g. no document is open yet, so `EditorArea` has no text plane to find.
 *
 * **Does NOT answer "who grants focus in the first place?"** (Issue #82's
 * post-mortem): before the fix in `ui/shell.tsx`'s `EditorArea`, NOTHING in
 * production ever imperatively focused the text plane on mount — this
 * helper's own real-`.focus()`-walk masked that gap for over a year of
 * tests, because every test that types goes through this function first,
 * never through the production mount path alone. `EditorArea` now grants
 * initial focus itself (on mount with a document already open, on a
 * document opening later, and on switching tabs — see that component's own
 * TSDoc for the exact rule and its do-not-steal guard), so a test that
 * wants to prove typing works FROM PRODUCTION STARTUP ALONE must render the
 * Shell and type WITHOUT calling this helper at all
 * (`shell.initialFocus.test.tsx`'s "no focus assist" tests are exactly
 * that) — calling `focusEditorText` before typing is still correct and
 * still the right tool for every test that has a different, unrelated
 * thing to prove (multi-cursor, undo/redo, syntax highlighting, …), it
 * just no longer stands in for "does startup focus the editor" the way its
 * mere existence previously, silently did.
 */
export function focusEditorText(rendererRoot: unknown, context: Pick<ContextService, "get">): boolean {
  for (const node of findAllFocusable(rendererRoot)) {
    node.focus?.();
    if (context.get<boolean>("editorTextFocus") === true) return true;
    node.blur?.();
  }
  return false;
}

/** Everything {@link renderEditingShell} needs from an {@link AssemblyRoot}
 * to mount the Shell — exactly `renderShell.tsx`'s `ShellRenderDeps` shape,
 * narrowed to the fields `main.ts`'s real composition root always supplies
 * (this harness never needs `ShellRenderDeps`'s `chordMachine`/
 * `editorInputRouter` props — those two are wired externally via
 * {@link sendKey}, not passed to `<Shell>` itself; see `renderShell.tsx`'s
 * `renderShellToTerminal`, which does the same). */
export type EditingShellDeps = Pick<
  AssemblyRoot,
  | "slotRegistry"
  | "layoutState"
  | "context"
  | "commands"
  | "theme"
  | "themeService"
  | "documents"
  | "config"
  | "editorSession"
  | "findService"
  | "highlightService"
  | "modalService"
>;

/**
 * Mount `<ThemeProvider><ContextFocusTracker><Shell/><ModalOverlay/>
 * </ContextFocusTracker></ThemeProvider>` (design.md §8.1's component tree,
 * `modalOverlay.tsx`'s "Mount point") onto OpenTUI's headless test
 * renderer — the exact same tree `renderShell.tsx`'s `renderShellToTerminal`
 * mounts onto a real terminal, just onto `@opentui/react/test-utils`'s
 * `testRender` instead of a real `CliRenderer` (`shell.snapshot.test.tsx`'s
 * top-of-file TSDoc documents why this is a full, real cell-grid renderer,
 * not a fallback). `ModalOverlay` is mounted unconditionally (matching
 * `renderShellToTerminal`'s own always-there `modalService` in production
 * `main.ts`), so a test can drive `root.modalService.openQuickPick(...)`/
 * `openInputBox(...)` and observe the SAME `quickPickFocus`/`inputBoxFocus`
 * context transitions production reports — Issue #82's "do not steal focus
 * from the palette" regression is a real ordering interaction between
 * `ModalOverlay` and `Shell`'s `EditorArea` that a harness omitting
 * `ModalOverlay` could never exercise.
 */
export function renderEditingShell(
  deps: EditingShellDeps,
  testRendererOptions: TestRendererOptions,
): ReturnType<typeof testRender> {
  const node: ReactNode = (
    <ThemeProvider theme={deps.theme} themeService={deps.themeService}>
      <ContextFocusTracker context={deps.context}>
        <Shell
          slotRegistry={deps.slotRegistry}
          layoutState={deps.layoutState}
          commands={deps.commands}
          documents={deps.documents}
          config={deps.config}
          editorSession={deps.editorSession}
          findService={deps.findService}
          highlightService={deps.highlightService}
        />
        <ModalOverlay modalService={deps.modalService} />
      </ContextFocusTracker>
    </ThemeProvider>
  );
  return testRender(node, testRendererOptions);
}
