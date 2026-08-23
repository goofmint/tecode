// Syntax highlighting and languages (Req 8.1-8.3; design.md §10; Task 2.8):
// the language registry (extension -> language id resolution, plaintext
// fallback), the asset resolver (grammar WASM / highlight query loading),
// the tree-sitter parser backend seam, and the highlight service itself.

export {
  createLanguageRegistry,
  PLAINTEXT_LANGUAGE_ID,
  type LanguageRegistry,
  type LanguageRegistryEntry,
} from "./languageRegistry";

export {
  createAssetResolver,
  type AssetResolver,
  type AssetResolverDeps,
  type AssetResolverFs,
} from "./assetResolver";

export {
  createWebTreeSitterParserBackend,
  utf16OffsetToUtf8Byte,
  utf8ByteOffsetToUtf16,
  type ParserBackend,
  type ParserCapture,
  type ParserEditDescriptor,
  type ParserLanguageHandle,
  type ParserPoint,
  type ParserQuery,
  type ParserTree,
} from "./parserBackend";

export {
  createHighlightService,
  type HighlightService,
  type HighlightServiceDeps,
  type HighlightSpan,
} from "./highlightService";
