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
  createBaseTheme,
  createEditorStub,
  createLanguagesStub,
  createThemesStub,
  createUiStub,
  createWindowStub,
  type LanguagesStub,
  type RegisteredView,
  type ThemesStub,
  type UiStub,
  type WindowStub,
} from "./stubs";
export { registerTecodeAlias } from "./alias";
