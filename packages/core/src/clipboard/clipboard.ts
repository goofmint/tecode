/**
 * `createClipboard`: the implementation behind `tecode.clipboard` (Issue
 * #91). Wraps a single in-memory buffer — a thin host-resource seam, the
 * same shape `buffer/fileSystem.ts`'s `createFileSystem` wraps
 * `node:fs/promises` behind — with a write-through OSC 52 sync to the
 * terminal's own system clipboard, injected lazily once the real terminal
 * seam (`packages/cli/src/renderShell.tsx`'s `onClipboardWriterReady`) has
 * resolved one.
 *
 * **Why an internal buffer, not a live OSC 52 round-trip**: OSC 52
 * *reading* is not portable — many terminals never implement the query
 * form at all, and those that do commonly gate it behind an interactive
 * user prompt (`@tecode/api`'s `ClipboardNamespace` TSDoc explains this to
 * extension authors too). `read()` below therefore only ever reports this
 * buffer's own last-written value; nothing in this module ever attempts an
 * OSC 52 *read*.
 *
 * **Never crashes the process** (matches `fileSystem.ts`'s own contract for
 * `watch`): the injected OSC 52 writer is host-provided terminal-escape-
 * sequence plumbing with no reliable failure signal — a terminal that
 * silently ignores it looks identical, from here, to one that briefly
 * failed. A writer that returns `false`, or throws outright, is reported
 * through `deps.log` (when supplied) and otherwise swallowed; `write()`
 * itself always resolves once the INTERNAL buffer has been updated,
 * regardless of what the system-clipboard half did.
 */

import type { ClipboardNamespace } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `fileSystem.ts`'s/`documentManager.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Dependencies for {@link createClipboard}. Every field is optional —
 * `createClipboard()` with no arguments is a complete, working clipboard
 * (internal buffer only, no system-clipboard sync until {@link
 * Clipboard.setSystemWriter} injects one); `log` only adds visibility into
 * OSC 52 write failures that would otherwise be silently swallowed. */
export interface ClipboardDeps {
  /** Structured log for OSC 52 write failures (design.md §14). Omitted
   * (the default) swallows these silently — {@link Clipboard.write} still
   * never throws or rejects either way. */
  log?: HostLog;
}

/**
 * {@link createClipboard}'s return type: the `ClipboardNamespace` extension
 * code sees (`read`/`write`), plus two host-only setters `create.ts`/
 * `main.ts` use to wire this instance up to the real terminal and to the
 * live `clipboard.useSystemClipboard` setting — narrowed away when
 * `create.ts` assembles the frozen `tecode.clipboard` namespace extensions
 * actually receive (matches `stubs.ts`'s `WindowStub`/`LanguagesStub` TSDoc
 * on why a factory here returns more than its `@tecode/api` namespace
 * shape).
 */
export interface Clipboard extends ClipboardNamespace {
  /**
   * Inject (or clear, with `undefined`) the OSC 52 write function
   * (`packages/cli/src/renderShell.tsx`'s `onClipboardWriterReady`,
   * bound to `@opentui/core`'s `CliRenderer.copyToClipboardOSC52`). A
   * terminal-render seam that never resolves one (`renderShellHeadless`,
   * or any test) leaves system-clipboard sync permanently inert — {@link
   * write} still updates the internal buffer either way.
   */
  setSystemWriter(write: ((text: string) => boolean) | undefined): void;
  /**
   * Enable or disable OSC 52 sync without touching the injected writer
   * itself — the live backing for `editor-core`'s `clipboard.
   * useSystemClipboard` configuration (Issue #91): `index.ts`'s
   * `activate` calls this once at startup and again on every live
   * `tecode.config.onDidChange` for that key. Defaults to `true` (this
   * module's TSDoc), matching that setting's own schema default so a
   * caller that never wires config sync at all still gets sync-when-
   * possible, not silently-disabled, behavior.
   */
  setSystemClipboardEnabled(enabled: boolean): void;
}

/**
 * Build a {@link Clipboard} (Issue #91). `deps.log` is optional — see
 * {@link ClipboardDeps}.
 */
export function createClipboard(deps: ClipboardDeps = {}): Clipboard {
  let buffer = "";
  let systemWriter: ((text: string) => boolean) | undefined;
  // Matches `clipboard.useSystemClipboard`'s own `default: true` schema
  // (`editor-core/manifest.ts`) — see `setSystemClipboardEnabled`'s TSDoc.
  let systemClipboardEnabled = true;

  function logSafely(err: HostError): void {
    if (!deps.log) return;
    try {
      deps.log.append("warning", err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go
      // (matches `fileSystem.ts`'s own `logSafely`).
    }
  }

  async function read(): Promise<string> {
    return buffer;
  }

  async function write(text: string): Promise<void> {
    // The internal buffer is updated UNCONDITIONALLY, before any
    // system-clipboard sync is even attempted — every caller (`read()`
    // here, and `editor-core`'s own paste handler) must see the new
    // value regardless of whether OSC 52 is enabled, wired, or working.
    buffer = text;

    if (!systemClipboardEnabled || !systemWriter) return;

    try {
      const accepted = systemWriter(text);
      if (!accepted) {
        logSafely({
          message: "Clipboard: OSC 52 system-clipboard write was not accepted by the terminal.",
        });
      }
    } catch (cause) {
      // Never let an injected writer's failure propagate past this seam
      // (this module's TSDoc) — logged, not rethrown, not left as a
      // rejection.
      logSafely({
        message: `Clipboard: OSC 52 system-clipboard write threw: ${describeError(cause)}`,
      });
    }
  }

  function setSystemWriter(write: ((text: string) => boolean) | undefined): void {
    systemWriter = write;
  }

  function setSystemClipboardEnabled(enabled: boolean): void {
    systemClipboardEnabled = enabled;
  }

  return { read, write, setSystemWriter, setSystemClipboardEnabled };
}
