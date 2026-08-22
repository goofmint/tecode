// The configuration service (design.md §11, Req 9): a hand-written JSONC
// parser, the layered (defaults ← user ← workspace) settings service, and
// its file watching, live reload, and raw keybindings access.

export {
  parseJsonc,
  type JsoncFailure,
  type JsoncParseResult,
  type JsoncSuccess,
} from "./jsonc";
export {
  createConfigService,
  type ConfigService,
  type ConfigServiceDeps,
  type ConfigServiceFs,
} from "./service";
