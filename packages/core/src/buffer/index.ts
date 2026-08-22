// Documents and the text buffer (Req 5, design.md §7.1, §7.2): `LineBuffer`
// is the line-array store, `Document` wraps it with version/dirty/EOL
// tracking, change notification, and undo/redo via `UndoStack`;
// `DocumentManager` owns the open/close/save lifecycle over a `Map<Uri,
// CoreDocument>`.
export {
  createLineBuffer,
  type AppliedEdit,
  type LineBuffer,
} from "./lineBuffer";
export {
  createSystemClock,
  type Clock,
} from "./clock";
export {
  createUndoStack,
  TYPING_COALESCE_WINDOW_MS,
  type PushInput,
  type TypingCoalesceHint,
  type UndoEntry,
  type UndoStack,
  type UndoStackDeps,
} from "./undoStack";
export {
  createDocument,
  type ApplyEditsOptions,
  type CoreDocument,
  type CreateDocumentOptions,
} from "./document";
export {
  createDocumentManager,
  LARGE_FILE_THRESHOLD_BYTES,
  type DocumentManager,
  type DocumentManagerDeps,
  type DocumentManagerFs,
} from "./documentManager";
export { pathToUri, uriToPath } from "./uri";
