// Documents and the text buffer (Req 5, design.md §7.1): `LineBuffer` is
// the line-array store, `Document` wraps it with version/dirty/EOL
// tracking and change notification. `UndoStack`/`DocumentManager` land in
// later tasks (1.8+).
export {
  createLineBuffer,
  type AppliedEdit,
  type LineBuffer,
} from "./lineBuffer";
export {
  createDocument,
  type CreateDocumentOptions,
} from "./document";
