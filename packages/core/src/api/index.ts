// The `tecode` API object assembly (Req 10.1, 10.2, design.md §12): builds
// the frozen `Tecode` object handed to every extension, the no-op/
// placeholder namespaces it delegates to ahead of later tasks giving them
// real backing, and the `"tecode"` module-alias registration extensions
// import against.
export {
  createTecodeApi,
  type CreateTecodeApiDeps,
} from "./create";
export {
  createEditorNamespace,
  type EditorNamespaceDeps,
} from "./editorNamespace";
export {
  createBaseTheme,
  createClipboardStub,
  createEditorStub,
  createFindStub,
  createLanguagesStub,
  createThemesStub,
  createWindowStub,
  type LanguagesStub,
  type ThemesStub,
  type WindowStub,
} from "./stubs";
export { registerTecodeAlias } from "./alias";
