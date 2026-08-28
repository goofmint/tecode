// The clipboard domain (Issue #91): an internal buffer with write-through
// OSC 52 sync to the terminal's system clipboard (`clipboard.ts`), backing
// `tecode.clipboard` and `editor-core`'s copy/cut/paste commands.
export { createClipboard, type Clipboard, type ClipboardDeps } from "./clipboard";
