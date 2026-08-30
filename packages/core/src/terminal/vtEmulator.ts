/**
 * `createVtEmulator`: a VT100/xterm emulator wrapping `@xterm/headless`'s
 * `Terminal` (Issue #98), turning a stream of raw pty output bytes into a
 * readable cell grid — characters, wide-character widths, and colors — a
 * panel view can draw. This module owns no pty of its own (`ptyService.ts`
 * does); a caller feeds it {@link PtySession.onData} bytes via {@link
 * VtEmulator.write} and reads the result back through {@link
 * VtEmulator.getCell}.
 *
 * **`allowProposedApi: true`**: `@xterm/headless`'s buffer-read surface
 * (`terminal.buffer`, and everything reachable from it — exactly what
 * {@link VtEmulator.getCell} needs) is gated behind this option; omitting
 * it makes `terminal.buffer` throw the moment anything touches it
 * ("You must set the allowProposedApi option to true to use proposed
 * API" — reproduced by hand against this exact version). There is no
 * lower-risk alternative surface for a headless-buffer reader to use
 * instead — every xterm.js buffer-reading API lives behind this flag.
 *
 * **Where this lives, and why** (house layering — `ui/` → `keymap/`/
 * `host/` is established by other core modules; `keymap/` → `ui/` and
 * `host/` → `ui/` are NOT, by the same evidence): this module needs
 * `ui/colorQuantize.ts`'s `buildXterm256Palette()` to resolve a cell's
 * xterm-256 palette index (16-255) to RGB, which would make `terminal/` →
 * `ui/` an import in the same "wrong" direction if `terminal/` sat
 * alongside `keymap/`/`host/` in that hierarchy. There is no ESLint rule
 * (or any other enforcement) actually forbidding it today — the codebase's
 * only enforced import-layering rule (`layering.test.ts`) polices the
 * `builtin`/`cli` boundary against `@tecode/core`, not directions between
 * folders INSIDE `core/src/`. Importing `buildXterm256Palette` here is
 * still deliberately narrow: it comes from `../ui/colorQuantize` directly
 * (bypassing `ui/index.ts`'s barrel, which also re-exports the entire
 * React/OpenTUI-backed `Shell`/`EditorView` component tree) so pulling in
 * this one pure, dependency-free function does not drag any of that in
 * along with it. `colorQuantize.ts` itself imports nothing but
 * `@tecode/api` types, so this is a leaf-to-leaf reference, not a cycle.
 */

import { Terminal as XtermTerminal } from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { Disposable, Event, Listener, RGB } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import { buildXterm256Palette } from "../ui/colorQuantize";
import { resolveAnsi16 } from "./ansiPalette";

/** One cell's resolved color (Issue #98's "colours distinguishing
 * default / palette-index / RGB" acceptance bar) — a discriminated union
 * so a renderer never has to guess which of `index`/`rgb` is meaningful
 * for a given cell. */
export type TerminalCellColor =
  | { kind: "default" }
  | { kind: "palette"; index: number; rgb: RGB }
  | { kind: "rgb"; rgb: RGB };

/** One character cell read back from the emulator's grid ({@link
 * VtEmulator.getCell}). */
export interface TerminalCell {
  /** The cell's character(s) — usually one, occasionally a combined
   * grapheme cluster (`IBufferCell.getChars()`). Empty for a continuation
   * cell (see {@link width}). */
  chars: string;
  /** `1` for a normal-width cell, `2` for the FIRST cell of a wide
   * character (CJK, most emoji), `0` for the cell immediately after a
   * wide character — a continuation slot with no character of its own
   * (`IBufferCell.getWidth()`'s own documented values). A renderer skips
   * width-`0` cells entirely rather than drawing them as blank. */
  width: number;
  foreground: TerminalCellColor;
  background: TerminalCellColor;
}

/** Dependencies for {@link createVtEmulator}. Every field but `cols`/
 * `rows` is optional. */
export interface VtEmulatorDeps {
  /** Initial column count — matches the pty's own `cols` so the two never
   * disagree about the screen's width from the first frame. */
  cols: number;
  /** Initial row count — matches the pty's own `rows`. */
  rows: number;
  /** Structured log for write/dispose failures (design.md §14). Omitted
   * swallows these silently — every method here still never throws. */
  log?: HostLog;
}

/** {@link createVtEmulator}'s return type. */
export interface VtEmulator {
  /** Current column count. */
  readonly cols: number;
  /** Current row count. */
  readonly rows: number;
  /**
   * Feed raw pty output bytes (or a pre-decoded string) into the VT
   * parser. Resolves once the parser has fully processed `data` and the
   * grid reflects it — i.e. once {@link onDidChange} for this call has
   * already fired, so a caller that only needs "did this settle" rather
   * than the change notification itself can just `await` this instead of
   * subscribing. Never rejects: a parser failure is reported through
   * `log` and swallowed (matches every other never-throwing boundary in
   * this codebase — `clipboard.ts`'s `write`, `fileSystem.ts`'s `watch`).
   */
  write(data: Uint8Array | string): Promise<void>;
  /** Resize the emulator's own grid — does NOT touch any pty; a caller
   * driving both a {@link VtEmulator} and a `PtySession` together calls
   * this AND `PtySession.resize` (the two are deliberately independent
   * seams — see this module's TSDoc). Fires {@link onDidChange}. */
  resize(cols: number, rows: number): void;
  /**
   * Read cell `(x, y)` — `x`/`y` both 0-based, `y` counted from the top
   * of the current viewport (row 0 is always on-screen). `undefined` when
   * `(x, y)` is out of bounds for the current grid.
   */
  getCell(x: number, y: number): TerminalCell | undefined;
  /** Fires after every grid-affecting change: a completed {@link write},
   * or a {@link resize}. Carries no payload — the same "re-read whatever
   * cells you need" shape as this codebase's other coarse `onDidChange`
   * events (`ThemesNamespace.onDidChange`, `EditorNamespace.onDidChange`). */
  onDidChange: Event<void>;
  /** Tear down the underlying `@xterm/headless` `Terminal`. Idempotent —
   * a second call is always safe and never throws. */
  dispose(): void;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches `clipboard.ts`'s/`fileSystem.ts`'s
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * The 16-255 xterm-256 cube/gray-ramp table, built exactly once at module
 * load (`buildXterm256Palette()` is documented cheap and side-effect free
 * — its own TSDoc — so a plain module-level `const` needs no lazy-init
 * ceremony). {@link resolvePaletteRgb} is called per cell while walking a
 * whole grid (`rows * cols` cells per frame, e.g. 1,920 for an 80x24
 * viewport) — rebuilding a 240-entry table on every one of those calls
 * was measurable waste for zero benefit, since the table never changes
 * after the first build.
 */
const XTERM_256_PALETTE = buildXterm256Palette();

/**
 * Resolve a cell's xterm-256 palette index (0-255) to RGB: 0-15 via
 * `ansiPalette.ts`'s well-known ANSI-16 approximation, 16-255 via {@link
 * XTERM_256_PALETTE} (this module's TSDoc explains both choices).
 */
function resolvePaletteRgb(index: number): RGB {
  if (index < 16) return resolveAnsi16(index);
  return XTERM_256_PALETTE[index - 16] ?? { r: 0, g: 0, b: 0 };
}

/** Resolve one of a cell's two colors (`"fg"` or `"bg"`) using the
 * `isFgDefault`/`isFgRGB`/`isFgPalette` (or `Bg`-) trio `@xterm/headless`
 * exposes for exactly this purpose (this module's TSDoc references —
 * checked in that order since "default" and "RGB" are both single, cheap
 * boolean checks, leaving "palette" as the fallback for whatever remains). */
function resolveCellColor(mode: "fg" | "bg", cell: IBufferCell): TerminalCellColor {
  const isDefault = mode === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return { kind: "default" };

  const isRGB = mode === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const value = mode === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) {
    return {
      kind: "rgb",
      rgb: { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff },
    };
  }

  // Neither default nor RGB: `isFgPalette()`/`isBgPalette()` per
  // `IBufferCell`'s own TSDoc ("Default: ...; Palette: ...; RGB: ...").
  return { kind: "palette", index: value, rgb: resolvePaletteRgb(value) };
}

/**
 * Build a {@link VtEmulator} (Issue #98). `deps.cols`/`deps.rows` size the
 * emulator's grid from construction; `deps.log` is optional.
 */
export function createVtEmulator(deps: VtEmulatorDeps): VtEmulator {
  const term = new XtermTerminal({
    cols: deps.cols,
    rows: deps.rows,
    allowProposedApi: true,
  });
  // Reused across every `getCell` call (this module's TSDoc, matching the
  // plan's "reuse `buffer.getNullCell()`'s scratch cell" guidance) —
  // `IBufferLine.getCell(x, cell)` fills this same object in place rather
  // than allocating a fresh one per cell, which matters once a renderer
  // walks a whole grid (`rows * cols` cells) on every frame.
  const scratchCell = term.buffer.active.getNullCell();

  let disposed = false;
  const changeListeners = new Set<Listener<void>>();

  function logSafely(err: HostError): void {
    if (!deps.log) return;
    try {
      deps.log.append("warning", err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go
      // (matches `clipboard.ts`'s/`fileSystem.ts`'s `logSafely`).
    }
  }

  function makeEvent<T>(listeners: Set<Listener<T>>): Event<T> {
    return (listener) => {
      listeners.add(listener);
      let listenerDisposed = false;
      const disposable: Disposable = {
        dispose() {
          if (listenerDisposed) return;
          listenerDisposed = true;
          listeners.delete(listener);
        },
      };
      return disposable;
    };
  }

  function fireChange(): void {
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop (matches
    // `documentManager.ts`'s `fire`).
    for (const listener of Array.from(changeListeners)) {
      try {
        listener(undefined);
      } catch (cause) {
        logSafely({ message: `VtEmulator onDidChange listener threw: ${describeError(cause)}` });
      }
    }
  }

  function write(data: Uint8Array | string): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        term.write(data, () => {
          fireChange();
          resolve();
        });
      } catch (cause) {
        // Never rejects (this module's/type's TSDoc) — a parser failure
        // is reported and swallowed exactly like every other
        // never-throwing boundary in this codebase.
        logSafely({ message: `VtEmulator write failed: ${describeError(cause)}` });
        resolve();
      }
    });
  }

  function resize(cols: number, rows: number): void {
    if (disposed) return;
    try {
      term.resize(cols, rows);
      fireChange();
    } catch (cause) {
      logSafely({ message: `VtEmulator resize(${cols}, ${rows}) failed: ${describeError(cause)}` });
    }
  }

  function getCell(x: number, y: number): TerminalCell | undefined {
    if (disposed) return undefined;
    // `IBuffer.getLine` indexes the WHOLE buffer, scrollback included, but
    // this method's contract is viewport-relative ("row 0 is always
    // on-screen" — {@link VtEmulator.getCell}'s own TSDoc). The two
    // coincide only until the child program first scrolls; after that a
    // bare `getLine(y)` returns the OLDEST scrollback line and the panel
    // freezes on the start of the session (Issue #102).
    //
    // `viewportY`, not `baseY`: this answers "what is on screen right
    // now", where `baseY` answers "where does the bottom page start". They
    // are equal while nothing scrolls the view back through history, and
    // scrollback navigation is out of scope — but picking the one that
    // matches the documented contract means adding that later does not
    // silently change what this returns.
    //
    // Re-read on every call rather than cached: `write`/`resize` both move
    // it.
    const buffer = term.buffer.active;
    // Bounds-check `y` against the GRID, before the offset is applied.
    // Without this, offsetting turns an out-of-range row into a valid
    // buffer index: `getCell(x, -1)` would read the scrollback line just
    // above the viewport, and (once scrollback navigation exists, putting
    // `viewportY` below `baseY`) `y >= rows` would read one below it —
    // both off-screen, both contradicting this method's documented
    // "`undefined` when `(x, y)` is out of bounds". A bare `getLine(y)`
    // used to get this right by accident, since a negative index is never
    // a real buffer row.
    if (y < 0 || y >= term.rows) return undefined;
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) return undefined;
    const cell = line.getCell(x, scratchCell);
    if (!cell) return undefined;
    return {
      chars: cell.getChars(),
      width: cell.getWidth(),
      foreground: resolveCellColor("fg", cell),
      background: resolveCellColor("bg", cell),
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      term.dispose();
    } catch (cause) {
      logSafely({ message: `VtEmulator dispose failed: ${describeError(cause)}` });
    }
  }

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write,
    resize,
    getCell,
    onDidChange: makeEvent(changeListeners),
    dispose,
  };
}
