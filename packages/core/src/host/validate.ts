/**
 * Hand-written manifest validation (Req 2.3, 2.7, design.md §4.1, §4.3) —
 * no runtime schema library (house convention: keeps the compiled binary
 * lean). Validates a raw, untyped manifest module export against the
 * `@tecode/api` `Manifest` shape and reports every problem it finds, each
 * carrying a field path (e.g. `contributes.commands[0].id`) rather than
 * failing fast on the first — a manifest author sees every mistake in one
 * pass. `validateManifest` never throws, and returns a discriminated
 * result rather than throwing on failure.
 *
 * API-version compatibility (design.md §4.3) is a separate, later check
 * ({@link checkApiVersionCompatibility}) — a manifest can be *structurally*
 * valid (a well-formed `apiVersion` string) while still being
 * *incompatible* with the running host, which is not a validation failure
 * in the same sense.
 */

import { API_VERSION } from "@tecode/api";
import type {
  ActivationEvent,
  BracketPair,
  CommandContribution,
  ConfigurationContribution,
  ConfigurationPropertySchema,
  Contributes,
  KeybindingContribution,
  LanguageComments,
  LanguageContribution,
  Manifest,
  ThemeContribution,
  ViewContribution,
} from "@tecode/api";
import { isValidCommandId } from "../commands/registry";

/** The result of {@link validateManifest}: either a fully-typed `Manifest`,
 * or the list of every problem found (field-path-qualified). */
export type ManifestValidationResult =
  | { valid: true; manifest: Manifest }
  | { valid: false; errors: string[] };

/** Whether an {@link checkApiVersionCompatibility} check passed, and why
 * not when it didn't. */
export interface ApiVersionCompatibility {
  compatible: boolean;
  /** Human-readable reason, present only when `compatible` is `false`. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const ACTIVATION_EVENT_PATTERN = /^(?:onStartup|onCommand:.+|onLanguage:.+)$/;

function isActivationEvent(value: unknown): value is ActivationEvent {
  return typeof value === "string" && ACTIVATION_EVENT_PATTERN.test(value);
}

/** `"<major>"` or `"<major>.<minor>"` (design.md §4.3). */
const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** The SemVer 2.0.0 grammar (semver.org's published pattern) for
 * `Manifest.version`, which — unlike the two-part {@link VERSION_PATTERN}
 * used for `apiVersion` — is a full `major.minor.patch` version with
 * optional pre-release/build parts. `"1.0"` and `"not-semver"` are
 * rejected. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseVersion(value: string): { major: number; minor: number } | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return { major, minor };
}

const VIEW_SLOTS = new Set(["sidebar", "panel"]);
const CONFIG_PROPERTY_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

/**
 * Validate one manifest module's raw default export against the `Manifest`
 * shape (Req 2.3). Never throws.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: [
        'manifest: must export a default object ("export default {...} satisfies Manifest")',
      ],
    };
  }

  if (!isNonEmptyString(raw.id)) {
    errors.push("id: required non-empty string");
  }
  if (!isNonEmptyString(raw.version)) {
    errors.push("version: required non-empty string");
  } else if (!SEMVER_PATTERN.test(raw.version)) {
    errors.push('version: must be a SemVer version ("<major>.<minor>.<patch>", e.g. "1.0.0")');
  }
  if (!isNonEmptyString(raw.apiVersion) || !VERSION_PATTERN.test(raw.apiVersion)) {
    errors.push(
      'apiVersion: required string in "<major>" or "<major>.<minor>" form (e.g. "1", "1.0")',
    );
  }

  let activationEvents: ActivationEvent[] = [];
  if (!Array.isArray(raw.activationEvents)) {
    errors.push("activationEvents: required array");
  } else {
    raw.activationEvents.forEach((event: unknown, i: number) => {
      if (!isActivationEvent(event)) {
        errors.push(
          `activationEvents[${i}]: must be "onStartup", "onCommand:<id>", or ` +
            `"onLanguage:<id>" (got ${JSON.stringify(event)})`,
        );
      }
    });
    activationEvents = raw.activationEvents as ActivationEvent[];
  }

  let contributes: Contributes = {};
  if (raw.contributes === undefined) {
    errors.push("contributes: required object (may be empty {})");
  } else if (!isRecord(raw.contributes)) {
    errors.push("contributes: must be an object");
  } else {
    contributes = validateContributes(raw.contributes, errors);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    manifest: {
      id: raw.id as string,
      version: raw.version as string,
      apiVersion: raw.apiVersion as string,
      activationEvents,
      contributes,
    },
  };
}

function validateContributes(raw: Record<string, unknown>, errors: string[]): Contributes {
  const result: Contributes = {};

  if (raw.commands !== undefined) {
    result.commands = validateArray(
      raw.commands,
      "contributes.commands",
      errors,
      validateCommandContribution,
    );
  }
  if (raw.keybindings !== undefined) {
    result.keybindings = validateArray(
      raw.keybindings,
      "contributes.keybindings",
      errors,
      validateKeybindingContribution,
    );
  }
  if (raw.views !== undefined) {
    result.views = validateArray(raw.views, "contributes.views", errors, validateViewContribution);
  }
  if (raw.languages !== undefined) {
    result.languages = validateArray(
      raw.languages,
      "contributes.languages",
      errors,
      validateLanguageContribution,
    );
  }
  if (raw.themes !== undefined) {
    result.themes = validateArray(
      raw.themes,
      "contributes.themes",
      errors,
      validateThemeContribution,
    );
  }
  if (raw.configuration !== undefined) {
    const configuration = validateConfigurationContribution(
      raw.configuration,
      "contributes.configuration",
      errors,
    );
    if (configuration) result.configuration = configuration;
  }

  return result;
}

/** Validate a `raw` value as an array of entries, each checked by `check`;
 * a non-array `raw` reports once at `path` and yields `[]`. Invalid
 * individual entries are dropped from the returned array (their errors are
 * already recorded by `check`) — the caller only reaches this when the
 * whole manifest is about to be rejected anyway (non-empty `errors`), so
 * the returned array's exact contents don't matter in that case. */
function validateArray<T>(
  raw: unknown,
  path: string,
  errors: string[],
  check: (entry: unknown, path: string, errors: string[]) => T | undefined,
): T[] {
  if (!Array.isArray(raw)) {
    errors.push(`${path}: must be an array`);
    return [];
  }
  const result: T[] = [];
  raw.forEach((entry: unknown, i: number) => {
    const validated = check(entry, `${path}[${i}]`, errors);
    if (validated !== undefined) result.push(validated);
  });
  return result;
}

function validateCommandContribution(
  entry: unknown,
  path: string,
  errors: string[],
): CommandContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.id)) {
    errors.push(`${path}.id: required non-empty string`);
  } else if (!isValidCommandId(entry.id)) {
    errors.push(`${path}.id: must be namespace.verb form (e.g. "editor.action.deleteLine")`);
  }
  if (!isNonEmptyString(entry.title)) {
    errors.push(`${path}.title: required non-empty string`);
  }
  if (entry.category !== undefined && typeof entry.category !== "string") {
    errors.push(`${path}.category: must be a string`);
  }
  if (entry.when !== undefined && typeof entry.when !== "string") {
    errors.push(`${path}.when: must be a string`);
  }
  if (errors.length !== before) return undefined;
  return {
    id: entry.id as string,
    title: entry.title as string,
    category: entry.category as string | undefined,
    when: entry.when as string | undefined,
  };
}

function validateKeybindingContribution(
  entry: unknown,
  path: string,
  errors: string[],
): KeybindingContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.key)) {
    errors.push(`${path}.key: required non-empty string`);
  }
  if (!isNonEmptyString(entry.command)) {
    errors.push(`${path}.command: required non-empty string`);
  }
  if (entry.when !== undefined && typeof entry.when !== "string") {
    errors.push(`${path}.when: must be a string`);
  }
  if (errors.length !== before) return undefined;
  return {
    key: entry.key as string,
    command: entry.command as string,
    when: entry.when as string | undefined,
  };
}

function validateViewContribution(
  entry: unknown,
  path: string,
  errors: string[],
): ViewContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.id)) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (!isNonEmptyString(entry.title)) {
    errors.push(`${path}.title: required non-empty string`);
  }
  if (typeof entry.slot !== "string" || !VIEW_SLOTS.has(entry.slot)) {
    errors.push(`${path}.slot: must be "sidebar" or "panel"`);
  }
  if (entry.icon !== undefined && typeof entry.icon !== "string") {
    errors.push(`${path}.icon: must be a string`);
  }
  if (errors.length !== before) return undefined;
  return {
    id: entry.id as string,
    title: entry.title as string,
    slot: entry.slot as ViewContribution["slot"],
    icon: entry.icon as string | undefined,
  };
}

function validateLanguageComments(
  entry: unknown,
  path: string,
  errors: string[],
): LanguageComments | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (entry.line !== undefined && typeof entry.line !== "string") {
    errors.push(`${path}.line: must be a string`);
  }
  let block: [string, string] | undefined;
  if (entry.block !== undefined) {
    if (
      !Array.isArray(entry.block) ||
      entry.block.length !== 2 ||
      typeof entry.block[0] !== "string" ||
      typeof entry.block[1] !== "string"
    ) {
      errors.push(`${path}.block: must be a [start, end] string pair`);
    } else {
      block = [entry.block[0], entry.block[1]];
    }
  }
  if (errors.length !== before) return undefined;
  return { line: entry.line as string | undefined, block };
}

function validateBracketPair(
  entry: unknown,
  path: string,
  errors: string[],
): BracketPair | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.open)) {
    errors.push(`${path}.open: required non-empty string`);
  }
  if (!isNonEmptyString(entry.close)) {
    errors.push(`${path}.close: required non-empty string`);
  }
  if (errors.length !== before) return undefined;
  return { open: entry.open as string, close: entry.close as string };
}

function validateLanguageContribution(
  entry: unknown,
  path: string,
  errors: string[],
): LanguageContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.id)) {
    errors.push(`${path}.id: required non-empty string`);
  }
  let extensions: string[] = [];
  if (
    !Array.isArray(entry.extensions) ||
    entry.extensions.length === 0 ||
    !entry.extensions.every((ext: unknown) => typeof ext === "string" && ext.startsWith("."))
  ) {
    errors.push(`${path}.extensions: required non-empty array of dot-prefixed extensions (e.g. ".ts")`);
  } else {
    extensions = entry.extensions as string[];
  }
  if (!isNonEmptyString(entry.grammar)) {
    errors.push(`${path}.grammar: required non-empty string`);
  }
  if (!isNonEmptyString(entry.highlights)) {
    errors.push(`${path}.highlights: required non-empty string`);
  }
  let comments: LanguageComments | undefined;
  if (entry.comments !== undefined) {
    comments = validateLanguageComments(entry.comments, `${path}.comments`, errors);
  }
  let brackets: BracketPair[] | undefined;
  if (entry.brackets !== undefined) {
    brackets = validateArray(entry.brackets, `${path}.brackets`, errors, validateBracketPair);
  }
  if (errors.length !== before) return undefined;
  return {
    id: entry.id as string,
    extensions,
    grammar: entry.grammar as string,
    highlights: entry.highlights as string,
    comments,
    brackets,
  };
}

function validateThemeContribution(
  entry: unknown,
  path: string,
  errors: string[],
): ThemeContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (!isNonEmptyString(entry.id)) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (!isNonEmptyString(entry.label)) {
    errors.push(`${path}.label: required non-empty string`);
  }
  if (!isNonEmptyString(entry.path)) {
    errors.push(`${path}.path: required non-empty string`);
  }
  if (errors.length !== before) return undefined;
  return {
    id: entry.id as string,
    label: entry.label as string,
    path: entry.path as string,
  };
}

function validateConfigurationPropertySchema(
  entry: unknown,
  path: string,
  errors: string[],
): ConfigurationPropertySchema | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (typeof entry.type !== "string" || !CONFIG_PROPERTY_TYPES.has(entry.type)) {
    errors.push(`${path}.type: must be one of "string", "number", "boolean", "array", "object"`);
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    errors.push(`${path}.description: must be a string`);
  }
  if (entry.enum !== undefined && !Array.isArray(entry.enum)) {
    errors.push(`${path}.enum: must be an array`);
  }
  if (errors.length !== before) return undefined;
  return {
    type: entry.type as ConfigurationPropertySchema["type"],
    default: entry.default,
    description: entry.description as string | undefined,
    enum: entry.enum as unknown[] | undefined,
  };
}

function validateConfigurationContribution(
  entry: unknown,
  path: string,
  errors: string[],
): ConfigurationContribution | undefined {
  const before = errors.length;
  if (!isRecord(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  if (entry.title !== undefined && typeof entry.title !== "string") {
    errors.push(`${path}.title: must be a string`);
  }
  const properties: Record<string, ConfigurationPropertySchema> = {};
  if (!isRecord(entry.properties)) {
    errors.push(`${path}.properties: required object`);
  } else {
    for (const [key, value] of Object.entries(entry.properties)) {
      const schema = validateConfigurationPropertySchema(value, `${path}.properties.${key}`, errors);
      if (schema) properties[key] = schema;
    }
  }
  if (errors.length !== before) return undefined;
  return {
    title: entry.title as string | undefined,
    properties,
  };
}

/**
 * Whether a manifest's declared `apiVersion` is compatible with the running
 * host's `API_VERSION` (Req 2.7, design.md §4.3): same major version, and
 * the host's minor version is greater than or equal to the requested one.
 * An unparsable version (should not happen for a manifest that already
 * passed {@link validateManifest}, but checked independently here so this
 * function is safe to call on its own) is reported incompatible rather
 * than thrown.
 */
export function checkApiVersionCompatibility(
  requested: string,
  hostVersion: string = API_VERSION,
): ApiVersionCompatibility {
  const req = parseVersion(requested);
  const host = parseVersion(hostVersion);
  if (!req || !host) {
    return {
      compatible: false,
      reason: `could not parse apiVersion "${requested}" against host "${hostVersion}"`,
    };
  }
  if (req.major !== host.major) {
    return {
      compatible: false,
      reason: `major version mismatch: extension requires ${req.major}.x, host is ${host.major}.${host.minor}`,
    };
  }
  if (host.minor < req.minor) {
    return {
      compatible: false,
      reason: `extension requires minor version >= ${req.minor}, host is ${host.major}.${host.minor}`,
    };
  }
  return { compatible: true };
}
