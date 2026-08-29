// The integrated-terminal domain (Issue #98): platform gating
// (`platform.ts`), the injectable/disposable pty service (`ptyService.ts`)
// backing `tecode.terminal`, the standalone ANSI-16 color table
// (`ansiPalette.ts`), and the `@xterm/headless`-backed VT emulator wrapper
// (`vtEmulator.ts`) that turns pty output bytes into a readable cell grid.
export { isPosixPlatform } from "./platform";
export { ANSI_16_PALETTE, resolveAnsi16 } from "./ansiPalette";
export {
  createTerminalService,
  type TerminalService,
  type TerminalServiceDeps,
} from "./ptyService";
export {
  createVtEmulator,
  type TerminalCell,
  type TerminalCellColor,
  type VtEmulator,
  type VtEmulatorDeps,
} from "./vtEmulator";
