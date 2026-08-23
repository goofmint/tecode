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

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ResolvedTheme } from "@tecode/api";
import {
  ContextFocusTracker,
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
  type LayoutStateService,
  type SlotRegistry,
} from "@tecode/core";
import { handleKeyEvent } from "./keyRouting";

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
  theme: ResolvedTheme;
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
}

/** The render seam's shape: resolves once "first frame" has happened (see
 * each implementation's TSDoc for what that means for it). Guarded at its
 * one call site in `main.ts` — an implementation that throws still leaves
 * `runTecode`'s own never-throwing startup contract to that call site, not
 * to this type. */
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
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  root.render(
    <ThemeProvider theme={deps.theme}>
      <ContextFocusTracker context={deps.context}>
        <Shell
          slotRegistry={deps.slotRegistry}
          layoutState={deps.layoutState}
          commands={deps.commands}
          documents={deps.documents}
          config={deps.config}
          editorSession={deps.editorSession}
          findService={deps.findService}
        />
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
    renderer.keyInput.on("keypress", (key) => {
      handleKeyEvent({ chordMachine, editorInputRouter }, key);
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
 */
export const renderShellHeadless: RenderShell = async () => {
  // Intentionally does nothing — see this module's TSDoc.
};
