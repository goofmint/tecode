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
  type CommandRegistry,
  type ContextService,
  type LayoutStateService,
  type SlotRegistry,
} from "@tecode/core";

/** Everything one `renderShell` call needs to mount the Shell (this
 * module's TSDoc) — exactly the live services `main.ts`'s sync phase has
 * already built by the time it calls this. */
export interface ShellRenderDeps {
  slotRegistry: SlotRegistry;
  layoutState: LayoutStateService;
  context: ContextService;
  commands: CommandRegistry;
  theme: ResolvedTheme;
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
 * **"First frame" here is a documented approximation.** `createRoot(...).render()`
 * synchronously commits the initial React tree onto OpenTUI's host config;
 * `CliRenderer` then runs its own frame loop to actually draw to the
 * terminal. Precisely awaiting "pixels reached the terminal" would need a
 * lower level `CliRenderer` render-loop hook this task did not need to
 * reverse-engineer for a <100ms sanity budget (design.md §15) — yielding
 * one microtask after the synchronous commit is a defensible, cheap proxy
 * for "the shell has painted its first frame," consistent with this task's
 * other documented stubs (`terminalCapabilities.ts`).
 */
export const renderShellToTerminal: RenderShell = async (deps) => {
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  root.render(
    <ThemeProvider theme={deps.theme}>
      <ContextFocusTracker context={deps.context}>
        <Shell slotRegistry={deps.slotRegistry} layoutState={deps.layoutState} commands={deps.commands} />
      </ContextFocusTracker>
    </ThemeProvider>,
  );
  await Promise.resolve();
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
