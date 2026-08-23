/**
 * A small, hand-written, tolerant JSONC parser (Req 9.1, design.md §11,
 * §15): strips `//` line comments, block comments, and trailing
 * commas — all while tracking string-literal state so a comment marker or
 * comma that merely *appears inside a string* survives untouched — then
 * delegates to `JSON.parse`. No JSON/JSONC library dependency (house
 * convention, design.md §11/§15): this is the whole implementation.
 *
 * Never throws: {@link parseJsonc} always returns a
 * {@link JsoncParseResult}, so callers (the config service) can report a
 * failure through a `StatusSink` instead of crashing.
 */

/** A successful parse: the decoded value. */
export interface JsoncSuccess<T = unknown> {
  ok: true;
  value: T;
}

/** A failed parse: a message plus the best-effort 1-based line/column of
 * the problem, for forwarding to a `StatusSink`/status bar (Req 9.1,
 * design.md §14). */
export interface JsoncFailure {
  ok: false;
  message: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export type JsoncParseResult<T = unknown> = JsoncSuccess<T> | JsoncFailure;

/**
 * Blank out `//` line comments and block comments in `text`, replacing every commented
 * character with a space (newlines inside block comments are preserved as
 * newlines). Tracks JSON string-literal state (with `\"`-escape awareness)
 * so `//`/`/*` sequences *inside* a string are left untouched.
 *
 * Replacing rather than deleting keeps every remaining character at its
 * original offset, so line/column arithmetic on the sanitized text matches
 * the original file exactly — this is what lets {@link lineColAt} below
 * work directly against the post-strip text.
 *
 * Exported so other modules that need to scan JSONC text without mistaking
 * a comment's contents for real syntax (`themeSettingsWriter.ts`'s
 * comment-aware search for the object's opening `{`) can reuse this same
 * comment/string tracking rather than re-implementing it.
 */
export function stripComments(text: string): string {
  const n = text.length;
  const out: string[] = new Array(n);
  let i = 0;
  let inString = false;

  while (i < n) {
    const ch = text[i]!;

    if (inString) {
      out[i] = ch;
      if (ch === "\\" && i + 1 < n) {
        // Copy the escaped character verbatim too (notably `\"`, which
        // must not be mistaken for the string's closing quote).
        out[i + 1] = text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out[i] = ch;
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out[i] = text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        // Blank the closing `*/` itself.
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      // An unterminated block comment (no closing `*/`) blanks to EOF —
      // JSON.parse reports whatever remains (typically nothing useful),
      // which is an acceptable MVP outcome for a malformed file.
      continue;
    }

    out[i] = ch;
    i++;
  }

  return out.join("");
}

/**
 * Blank a trailing comma — one whose next non-whitespace character (outside
 * a string) is `}` or `]` — to a space, again preserving every other
 * character's offset. Must run *after* {@link stripComments} so a comma
 * inside a now-blanked comment can never be mistaken for a real one.
 */
function stripTrailingCommas(text: string): string {
  const n = text.length;
  const out = text.split("");
  let inString = false;

  for (let i = 0; i < n; i++) {
    const ch = out[i]!;

    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(out[j]!)) j++;
      if (j < n && (out[j] === "}" || out[j] === "]")) {
        out[i] = " ";
      }
    }
  }

  return out.join("");
}

/** 1-based line/column of `offset` within `text`. */
function lineColAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches registry.ts's/documentManager.ts's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/**
 * Best-effort extraction of a character offset from a `JSON.parse` error
 * message. Engines built on V8 (Node, and Bun's `Response`/`fetch` JSON
 * paths) sometimes format this as `"... at position N"`; Bun's own
 * `JSON.parse` (JavaScriptCore) does not include a position at all as of
 * this writing. When no offset can be recovered, {@link parseJsonc} falls
 * back to reporting line 1, column 1 alongside the raw message — still
 * useful for the status bar, just not pinpoint-accurate (documented
 * trade-off, design.md §11).
 */
function extractOffset(message: string): number | undefined {
  const match = /\bat position\s+(\d+)/i.exec(message);
  if (!match) return undefined;
  const offset = Number(match[1]);
  return Number.isFinite(offset) ? offset : undefined;
}

/**
 * Parse JSONC text: comments and trailing commas are stripped (Req 9.1),
 * then the result is handed to `JSON.parse`. Never throws — parse failures
 * come back as a {@link JsoncFailure} with a 1-based line/column the caller
 * can forward to a `StatusSink` (design.md §11, §14).
 */
export function parseJsonc<T = unknown>(text: string): JsoncParseResult<T> {
  let sanitized: string;
  try {
    sanitized = stripTrailingCommas(stripComments(text));
  } catch (cause) {
    // Stripping is pure string scanning and should never throw, but a
    // parser is a public boundary (house convention) — guard it anyway.
    return { ok: false, message: describeError(cause), line: 1, column: 1 };
  }

  try {
    const value = JSON.parse(sanitized) as T;
    return { ok: true, value };
  } catch (cause) {
    const message = describeError(cause);
    const offset = extractOffset(message);
    const { line, column } =
      offset === undefined ? { line: 1, column: 1 } : lineColAt(sanitized, offset);
    return { ok: false, message, line, column };
  }
}
