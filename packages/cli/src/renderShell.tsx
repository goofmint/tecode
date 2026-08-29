/**
 * The shell-render seam (Req 12.1, 12.2; design.md §3, §8.1; tasks.md's
 * Task 1.15: "shell render" as the sync phase's "first frame" step).
 *
 * `runTecode` (`main.ts`) never calls `@opentui/core`/`@opentui/react`
 * directly — it calls `deps.renderShell(...)`, injectable so tests (and
 * `TECODE_HEADLESS=1`) can substitute {@link renderShellHeadless} and never
 * open a real TTY. {@link renderShellToTerminal} is the seam's default,
 * real implementation.
 */

import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ResolvedTheme } from "@tecode/api";
import {
  ContextFocusTracker,
  ModalOverlay,
  Shell,
  ThemeProvider,
  type ChordStateMachine,
  type CommandRegistry,
  type ConfigService,
  type ContextService,
  type DocumentManager,
  type EditorInputRouter,
  type EditorSessionService,
  type FindService,
  type HighlightService,
  type LayoutStateService,
  type ModalService,
  type SlotRegistry,
  type ThemeService,
} from "@tecode/core";
import { handleKeyEvent, type TerminalKeyRoutingDeps } from "./keyRouting";

/** Everything one `renderShell` call needs to mount the Shell (this
 * module's TSDoc) — exactly the live services `main.ts`'s sync phase has
 * already built by the time it calls this. `documents`/`config` (Req 6.5,
 * 6.6, 9.5) are already constructed synchronously in `buildAssemblyRoot`
 * even though the *initial file* is not opened until the deferred phase —
 * `Shell`'s own `useOpenDocuments` subscription (`ui/shell.tsx`) picks up
 * that later `onDidOpen` and re-renders, so wiring them in at first-frame
 * time is enough for the initial file to appear once it opens. Both
 * optional, mirroring `Shell`'s own optional `documents`/`config` props —
 * an existing caller/test that builds `ShellRenderDeps` without them keeps
 * getting the placeholder-only `EditorArea` exactly as before. */
export interface ShellRenderDeps {
  slotRegistry: SlotRegistry;
  layoutState: LayoutStateService;
  context: ContextService;
  commands: CommandRegistry;
  /** The FIRST-FRAME theme (Req 7.4, design.md §3): the sync phase's
   * base-palette theme (possibly already quantized for the detected color
   * depth), rendered before `themeService` (below) exists to take over.
   * Once `themeService` is given, `ThemeProvider` uses it instead from the
   * very first render (`ui/theme.tsx`'s TSDoc) — this stays required
   * (rather than becoming redundant) because `ThemeProvider`'s own
   * `theme`/`themeService` props are independent, backward-compatible
   * knobs (`ThemeProviderProps`' TSDoc), and every caller/test that omits
   * `themeService` still needs a theme to render. */
  theme: ResolvedTheme;
  /** The live theme service (Task 2.6, `ui/themeService.ts`) — threaded
   * straight through to `ThemeProvider`'s own `themeService` prop so
   * `theme.select` preview/commit/revert and a `workbench.colorTheme`
   * config-file live-switch re-render the whole shell (Req 7.3, 7.5).
   * Optional: a caller/test that omits it keeps the fixed `theme` above,
   * matching every other optional-dependency fallback in this module. */
  themeService?: Pick<ThemeService, "get" | "onDidChange">;
  documents?: DocumentManager;
  config?: ConfigService;
  /** Owns the active document/`EditorState` from outside `Shell` (Task
   * 2.2, `ui/editorSession.ts`) — threaded straight through to `Shell`'s
   * own `editorSession` prop. Optional, matching `documents`/`config`
   * above: a caller/test that omits it gets `Shell`'s original
   * component-local fallback (`shell.tsx`'s TSDoc). */
  editorSession?: EditorSessionService;
  /** Backs the rendered `Shell`'s `FindWidget` sibling (Req 11.1, design.md
   * §13) — threaded straight through to `Shell`'s own `findService` prop.
   * Optional, matching `editorSession` above: a caller/test that omits it
   * gets no `FindWidget` regardless of `find?.isOpen` (`shell.tsx`'s
   * `EditorAreaProps.findService` TSDoc). */
  findService?: Pick<FindService, "setQuery" | "setReplaceQuery" | "toggleCaseSensitive">;
  /** The syntax-highlighting pipeline (Task 2.8, Req 8.1-8.3, design.md
   * §10) — threaded straight through to `Shell`'s own `highlightService`
   * prop, which threads it to `EditorArea`/`EditorView` in turn. Optional,
   * mirroring `editorSession`/`findService` above: a caller/test that
   * omits it keeps `EditorView`'s current (unhighlighted) rendering
   * unchanged. */
  highlightService?: Pick<HighlightService, "getSpansForLine" | "onDidChange">;
  /** The live chord state machine (Req 4.4, design.md §6.1) —
   * {@link renderShellToTerminal} wires `renderer.keyInput` through it (and
   * `editorInputRouter` below) only when BOTH are given; either omitted
   * keeps the shell key-inert, matching the headless renderer's existing
   * behavior and every test that does not need real key routing. */
  chordMachine?: Pick<ChordStateMachine, "handleStroke">;
  /** The editor input router (Req 4.6, 6.6, design.md §6.1, §8.3) —
   * receives every stroke the chord machine reports as `"passthrough"`.
   * See {@link chordMachine}'s TSDoc for when the listener is actually
   * wired. */
  editorInputRouter?: Pick<EditorInputRouter, "routeKeyEvent">;
  /** Terminal-forwarding collaborator (Issue #98 Phase 3, `keyRouting.ts`'s
   * `TerminalKeyRoutingDeps`) — threaded straight into `handleKeyEvent`
   * alongside `chordMachine`/`editorInputRouter` above whenever `main.ts`
   * has a real pty to route to. Optional and independent of `chordMachine`/
   * `editorInputRouter`'s own "both or neither" pairing: a caller/test that
   * supplies those two but omits this keeps every key going through the
   * ordinary keymap pipeline exactly as before this issue. */
  terminal?: TerminalKeyRoutingDeps;
  /** Receives a stable focus-the-editor-text-plane handle once `Shell`'s
   * `EditorArea` publishes one (Issue #98 Phase 3) — threaded straight
   * through to `Shell`'s own `onEditorFocusHandleChange` prop. `main.ts`
   * wires this to build {@link terminal}'s own `escape` callback. Optional:
   * a caller/test that omits it simply never receives the handle. */
  onEditorFocusHandleChange?: (focus: () => void) => void;
  /** The core-owned modal overlay's state/logic (Task 3.1, Req 10.1,
   * design.md §12) — when given, rendered as the LAST sibling of `<Shell>`,
   * inside the same `<ThemeProvider>`/`<ContextFocusTracker>`, via
   * `ModalOverlay` (`ui/modalOverlay.tsx`). Optional, matching every other
   * service dependency above: a caller/test that omits it renders `<Shell>`
   * alone, with no modal overlay at all (not even an inert one) — exactly
   * the pre-Task-3.1 behavior. */
  modalService?: Pick<ModalService, "getState" | "onDidChange" | "setFilter" | "setInputValue">;
  /**
   * Terminal-capability reporting (Req 4.7, 13.3; design.md §6.5; Task
   * 4.2) — called with whatever `@opentui/core`'s `CliRenderer.capabilities`
   * currently holds (`terminalCapabilities.ts`'s `resolveKittyKeyboardSupport`
   * is the pure decision function `main.ts` runs the value through; this
   * callback only DELIVERS the raw value, it does not interpret it — same
   * separation of concerns `renderShell.tsx`'s other callbacks/services
   * keep from the policy that consumes them). {@link renderShellToTerminal}
   * calls this TWICE at most: once synchronously right after the renderer
   * is created (`renderer.capabilities`'s already-current value at that
   * point — typically the conservative not-yet-answered default, since the
   * query is still in flight), and once more if/when a `"capabilities"`
   * event actually fires with the terminal's real answer (`renderer.once`,
   * not `.on` — this listener never outlives its own first firing, so it
   * cannot leak past whatever happens to this renderer afterward). A
   * terminal that never answers at all (the query timed out —
   * `terminalCapabilities.ts`'s TSDoc) simply never triggers the second
   * call; the first, synchronous call already gave the caller a safe
   * default to act on. Optional and never required: omitting it (every
   * caller/test that doesn't need the fallback keymap) skips this wiring
   * entirely — {@link renderShellToTerminal} does not even read
   * `renderer.capabilities` or subscribe to the event when this is
   * absent, so there is no dangling subscription either way.
   * {@link renderShellHeadless} never calls this at all (this module's
   * TSDoc's "First frame for a headless run").
   */
  onCapabilitiesResolved?: (capabilitiesValue: unknown) => void;
  /**
   * Fires once the real `CliRenderer` has been destroyed (Issue #84, Req
   * 12.3) — wired straight through to `createCliRenderer`'s own
   * `onDestroy` config callback ({@link renderShellToTerminal}, below).
   * This is the ONLY reliable "the editor is quitting" signal for an
   * interactive Ctrl+C: `createCliRenderer()` puts stdin in raw mode,
   * which disables signal generation, so Ctrl+C never reaches Node as a
   * real `SIGINT` — OpenTUI's own `exitOnCtrlC` key handling (default
   * `true`) intercepts the `\x03` byte itself and calls
   * `CliRenderer.destroy()` directly, bypassing `SIGINT` entirely.
   *
   * `destroy()`'s `finalizeDestroy()` never calls `process.exit` (checked
   * against the pinned `@opentui/core@0.1.107` bundle), so `main.ts`'s
   * `runTecode` starts async cleanup here (`shutdown()`) and, once it
   * settles, explicitly calls `process.exit(0)` itself — mirroring
   * exactly what it already does on `SIGINT`/`SIGTERM`
   * (`void shutdown().finally(() => process.exit(0))`), rather than
   * relying on the process to exit "naturally" once its own pending I/O
   * happens to drain the event loop: `shutdown()` is raced against a
   * bounded timeout precisely so a hung `flush()`/`dispose()` cannot hang
   * the process forever, but that timeout only bounds the `shutdown()`
   * PROMISE — it does not cancel the pending I/O behind it — so without
   * an explicit exit call here, a genuinely hung disposal would still
   * leave the process (and the editor) unquittable even after `shutdown()`
   * itself has given up (`createShutdown`'s own TSDoc in `main.ts`).
   * `onDestroy` (a plain `CliRendererConfig` field) was chosen over
   * subscribing to the `CliRenderEvents.DESTROY` event this module
   * already uses for `CAPABILITIES` below: `finalizeDestroy()` emits
   * `"destroy"` BEFORE it finishes tearing down the renderable tree/
   * console/native renderer, via a plain `EventEmitter.emit` that does
   * NOT catch a throwing listener — and by the time it emits, `destroy()`
   * has already removed the renderer's own `uncaughtException` handler
   * (`cleanupBeforeDestroy()` runs first), so a listener that threw would
   * escape uncaught and abort the rest of that teardown. `onDestroy`, by
   * contrast, runs at the very END of `finalizeDestroy()` (after the
   * renderer has fully torn itself down) and is already wrapped in its
   * OWN try/catch internally — a second, library-provided guard on top of
   * this callback's own (`runTecode`'s TSDoc on why it never throws
   * either). Optional and never required: {@link renderShellHeadless}
   * never calls this (no real `CliRenderer` exists to destroy), matching
   * every other optional dependency in this module.
   */
  onDestroy?: () => void;
  /**
   * Delivers the terminal's OSC 52 write function exactly ONCE (Issue #91),
   * without exposing the `CliRenderer` itself — the same "hand over a
   * value/callback, not the renderer" convention as {@link
   * onCapabilitiesResolved}/{@link onDestroy} above. {@link
   * renderShellToTerminal} calls this synchronously, right after the
   * renderer is created, with `renderer.copyToClipboardOSC52` bound to that
   * renderer instance — the returned function's own boolean return value
   * (`true`/`false` for accepted/not) is `@opentui/core`'s only per-call
   * feedback; there is no separate "supported" query this callback also
   * needs to report, since a terminal that does not support OSC 52 simply
   * reports `false` (or is silently ignored) on every call, which the
   * clipboard service (`@tecode/core`'s `clipboard/clipboard.ts`) already
   * logs and swallows. Optional and never required: {@link
   * renderShellHeadless} never calls this (no real `CliRenderer`/terminal
   * exists to write an OSC 52 escape sequence to), matching every other
   * optional terminal-seam callback in this module.
   */
  onClipboardWriterReady?: (write: (text: string) => boolean) => void;
  /**
   * Delivers bracketed-paste text as it arrives (Issue #91): {@link
   * renderShellToTerminal} listens for `renderer.keyInput`'s `"paste"`
   * event (`@opentui/core`'s `PasteEvent`, `lib/KeyHandler.d.ts`) and
   * decodes its `bytes` (a `Uint8Array`) as UTF-8 before calling this with
   * the resulting string — extension/router code never sees raw bytes.
   * Wired ONLY when this callback is supplied, the same "register nothing
   * unless the caller actually wants it" pattern the `chordMachine`/
   * `editorInputRouter` pairing above already uses for `"keypress"` — a
   * caller/test that omits this leaves paste entirely unhandled, exactly
   * like every other optional callback here. {@link renderShellHeadless}
   * never calls this either (this module's TSDoc's "First frame for a
   * headless run" — there is no real terminal to receive a paste from).
   */
  onPaste?: (text: string) => void;
}

/** The render seam's shape: resolves once "first frame" has happened (see
 * each implementation's TSDoc for what that means for it). Guarded at its
 * one call site in `main.ts` — an implementation that throws still leaves
 * `runTecode`'s own never-throwing startup contract to that call site, not
 * to this type. */
/**
 * Decode a bracketed-paste payload (`PasteEvent.bytes`) into the string
 * handed to {@link ShellRenderDeps.onPaste} — and, through it, straight
 * into `EditorInputRouter.insertText` (Issue #91).
 *
 * `ignoreBOM: true` is load-bearing, and is the opposite of what the name
 * suggests: per the WHATWG Encoding Standard a DEFAULT `new TextDecoder()`
 * has `ignoreBOM: false`, which makes it treat a leading U+FEFF as an
 * encoding marker and SILENTLY DROP it; `true` makes it treat that U+FEFF
 * as ordinary text and keep it. Paste has to insert exactly the characters
 * the user pasted — a round trip that copies a BOM-prefixed line and pastes
 * it back must not quietly lose a character. Only a LEADING BOM is affected
 * either way: one in the middle of the payload already survives the default
 * decoder.
 *
 * Exported for its own test: {@link renderShellToTerminal}, its only
 * caller, opens a real `CliRenderer`/TTY that `bun test` cannot provide
 * (see this module's TSDoc), so this seam is where the behaviour is
 * assertable at all.
 */
export function decodePastedBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export type RenderShell = (deps: ShellRenderDeps) => Promise<void>;

/**
 * The real implementation: mounts `<ThemeProvider><ContextFocusTracker>
 * <Shell/></ContextFocusTracker></ThemeProvider>` (design.md §8.1's
 * component tree) onto a real `CliRenderer`, opening the actual terminal.
 *
 * "First frame" resolves via `renderer.idle()`: `createRoot(...).render()`
 * commits the initial React tree onto OpenTUI's host config and schedules
 * the actual terminal draw; `idle()` resolves once the renderer has no
 * pending draw work left (it resolves immediately when nothing is
 * scheduled yet, so this never waits longer than the real first draw).
 * The demand-driven `CliRenderer` only runs a continuous loop when a
 * component requests live mode — the Shell's initial tree requests none,
 * so `idle()` cannot hang here.
 */
export const renderShellToTerminal: RenderShell = async (deps) => {
  // `onDestroy: deps.onDestroy` (Issue #84, Req 12.3, this module's
  // `ShellRenderDeps.onDestroy` TSDoc): `undefined` when the caller
  // doesn't supply one, which `createCliRenderer` treats identically to
  // the field being omitted entirely.
  const renderer = await createCliRenderer({ onDestroy: deps.onDestroy });
  const root = createRoot(renderer);
  root.render(
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
          onEditorFocusHandleChange={deps.onEditorFocusHandleChange}
        />
        {/* LAST sibling of <Shell> (Task 3.1, `ui/modalOverlay.tsx`'s
         * TSDoc's "Mount point") — omitted entirely (not even an inert
         * render) when no `modalService` is given, matching every other
         * optional-dependency fallback in this module. */}
        {deps.modalService ? <ModalOverlay modalService={deps.modalService} /> : null}
      </ContextFocusTracker>
    </ThemeProvider>,
  );

  // The real input pipeline (Req 4.4, 4.6, 6.6; design.md §6.1): only wired
  // when both collaborators are given (this module's `ShellRenderDeps`
  // TSDoc) — `main.ts`'s composition root always supplies both, but a
  // caller/test that constructs `ShellRenderDeps` without them keeps the
  // shell key-inert exactly as before this task.
  if (deps.chordMachine && deps.editorInputRouter) {
    const chordMachine = deps.chordMachine;
    const editorInputRouter = deps.editorInputRouter;
    const terminal = deps.terminal;
    renderer.keyInput.on("keypress", (key) => {
      handleKeyEvent({ chordMachine, editorInputRouter, terminal }, key);
    });
  }

  // OSC 52 system-clipboard write (Issue #91, `ShellRenderDeps.
  // onClipboardWriterReady`'s TSDoc): delivered exactly once, bound to
  // THIS renderer instance — never exposes `renderer` itself, only the
  // bound write function.
  if (deps.onClipboardWriterReady) {
    deps.onClipboardWriterReady((text) => renderer.copyToClipboardOSC52(text));
  }

  // Bracketed-paste terminal input (Issue #91, `ShellRenderDeps.onPaste`'s
  // TSDoc): `PasteEvent.bytes` is decoded to a UTF-8 string before ever
  // reaching `deps.onPaste` — registered only when the caller actually
  // wants it, the same "nothing wired unless asked" pattern the
  // `chordMachine && editorInputRouter` pairing above already uses.
  if (deps.onPaste) {
    const onPaste = deps.onPaste;
    renderer.keyInput.on("paste", (event) => {
      onPaste(decodePastedBytes(event.bytes));
    });
  }

  // Terminal-capability reporting (Req 4.7, 13.3; design.md §6.5; Task
  // 4.2) — see `ShellRenderDeps.onCapabilitiesResolved`'s TSDoc for the
  // "at most twice, `.once` not `.on`" contract this implements.
  if (deps.onCapabilitiesResolved) {
    const onCapabilitiesResolved = deps.onCapabilitiesResolved;
    onCapabilitiesResolved(renderer.capabilities);
    renderer.once(CliRenderEvents.CAPABILITIES, (capabilitiesValue: unknown) => {
      onCapabilitiesResolved(capabilitiesValue);
    });
  }

  await renderer.idle();
};

/**
 * The headless/no-op implementation (the adaptation this task's plan
 * requires): never touches `@opentui/core`/opens a TTY. Used whenever
 * `TECODE_HEADLESS=1` is set (or stdout is not a TTY at all), and by every
 * test that exercises `runTecode`/`main` without a real terminal. "First
 * frame" for a headless run is simply the moment this resolves — there is
 * no terminal to paint, but the deferred phase still needs a well-defined
 * point to measure startup timing from and to start after.
 *
 * Never calls `deps.onCapabilitiesResolved` (Req 4.7, Task 4.2) — there is
 * no real `CliRenderer`, hence no capability query to report an answer
 * for. `KeymapState`'s `fallback` layer therefore simply stays whatever
 * it started as (`[]`) for the lifetime of a headless run, which is
 * correct: with no real terminal attached, no keystroke ever needs
 * disambiguating in the first place.
 */
export const renderShellHeadless: RenderShell = async () => {
  // Intentionally does nothing — see this module's TSDoc.
};
