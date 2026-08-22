/**
 * The when-clause parser and evaluator (Req 4.5, design.md §6.4). A tiny
 * recursive-descent grammar over context-key equality and boolean
 * combinators:
 *
 * ```
 * expr   := or
 * or     := and ("||" and)*
 * and    := unary ("&&" unary)*
 * unary  := "!" unary | primary
 * primary:= key | key "==" value | "(" expr ")"
 * ```
 *
 * {@link compileWhen} parses a clause exactly once into a {@link WhenNode}
 * AST and returns a {@link CompiledWhen} whose `evaluate` re-walks that
 * cached AST — the binding table (Task 1.5) compiles each `when` once at
 * registration and evaluates it on every keystroke without re-parsing.
 */

/* ------------------------------------------------------------------ */
/* AST                                                                 */
/* ------------------------------------------------------------------ */

/** A bare context-key reference (`editorTextFocus`), true when the
 * context value is truthy. */
export interface WhenKeyNode {
  readonly kind: "key";
  readonly key: string;
}

/** A string-equality test (`editorLangId == 'ts'`). The grammar only
 * admits a quoted string literal on the right of `==`, so `value` is a
 * plain `string`, not `unknown` — the *comparison* is against an
 * `unknown` context value at evaluation time. */
export interface WhenEqNode {
  readonly kind: "eq";
  readonly key: string;
  readonly value: string;
}

/** Logical negation (`!editorFocus`). */
export interface WhenNotNode {
  readonly kind: "not";
  readonly operand: WhenNode;
}

/** Logical AND (`a && b`), higher precedence than `||`. */
export interface WhenAndNode {
  readonly kind: "and";
  readonly left: WhenNode;
  readonly right: WhenNode;
}

/** Logical OR (`a || b`), lowest precedence. */
export interface WhenOrNode {
  readonly kind: "or";
  readonly left: WhenNode;
  readonly right: WhenNode;
}

/** The when-clause AST — a discriminated union on `kind` (design.md §6.4). */
export type WhenNode = WhenKeyNode | WhenEqNode | WhenNotNode | WhenAndNode | WhenOrNode;

/**
 * Thrown when a `when` clause fails to tokenize or parse. The message
 * names both what went wrong and the offending clause; callers (the
 * keybinding table, Task 1.5) are expected to catch this, log it, and
 * skip the binding rather than let it crash the process.
 */
export class WhenParseError extends Error {
  /** The full clause text that failed to parse. */
  readonly clause: string;

  constructor(reason: string, clause: string) {
    super(`Invalid when clause "${clause}": ${reason}`);
    this.name = "WhenParseError";
    this.clause = clause;
  }
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokenKind = "id" | "string" | "==" | "&&" | "||" | "!" | "(" | ")" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  /** Character offset in the source clause, for error messages. */
  readonly pos: number;
}

const ID_START = /[A-Za-z_]/;
const ID_CONT = /[A-Za-z0-9_.]/;

/** Split `clause` into a token stream, always terminated by a single
 * `"eof"` sentinel token — this lets the parser index the token array
 * without manual bounds checks (`noUncheckedIndexedAccess` is off
 * project-wide, so the sentinel is what actually keeps lookahead safe). */
function tokenize(clause: string): Token[] {
  const tokens: Token[] = [];
  const n = clause.length;
  let i = 0;

  while (i < n) {
    const ch = clause[i] as string;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: ch, value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "!", value: "!", pos: i });
      i++;
      continue;
    }
    if (ch === "&" && clause[i + 1] === "&") {
      tokens.push({ kind: "&&", value: "&&", pos: i });
      i += 2;
      continue;
    }
    if (ch === "|" && clause[i + 1] === "|") {
      tokens.push({ kind: "||", value: "||", pos: i });
      i += 2;
      continue;
    }
    if (ch === "=" && clause[i + 1] === "=") {
      tokens.push({ kind: "==", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < n && clause[j] !== quote) {
        value += clause[j];
        j++;
      }
      if (j >= n) {
        throw new WhenParseError(
          `unterminated string literal starting at position ${i}`,
          clause,
        );
      }
      tokens.push({ kind: "string", value, pos: i });
      i = j + 1;
      continue;
    }
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < n && ID_CONT.test(clause[j] as string)) j++;
      tokens.push({ kind: "id", value: clause.slice(i, j), pos: i });
      i = j;
      continue;
    }

    throw new WhenParseError(`unrecognized character "${ch}" at position ${i}`, clause);
  }

  tokens.push({ kind: "eof", value: "", pos: n });
  return tokens;
}

/** Render a token for an error message. */
function describeToken(token: Token): string {
  if (token.kind === "eof") return "end of input";
  if (token.kind === "string") return `string literal "${token.value}"`;
  return `"${token.value}"`;
}

/* ------------------------------------------------------------------ */
/* Recursive-descent parser                                            */
/* ------------------------------------------------------------------ */

/** Parse a full when clause into a {@link WhenNode}, per the §6.4 grammar.
 * Throws {@link WhenParseError} on any lexical or syntactic problem,
 * including trailing input after a complete expression. */
function parseWhen(clause: string): WhenNode {
  const tokens = tokenize(clause);
  let pos = 0;

  const peek = (): Token => tokens[pos] as Token; // safe: eof sentinel
  const advance = (): Token => {
    const token = peek();
    pos++;
    return token;
  };

  function parseOr(): WhenNode {
    let left = parseAnd();
    while (peek().kind === "||") {
      advance();
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  function parseAnd(): WhenNode {
    let left = parseUnary();
    while (peek().kind === "&&") {
      advance();
      const right = parseUnary();
      left = { kind: "and", left, right };
    }
    return left;
  }

  function parseUnary(): WhenNode {
    if (peek().kind === "!") {
      advance();
      return { kind: "not", operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): WhenNode {
    const token = peek();

    if (token.kind === "(") {
      advance();
      const inner = parseOr();
      const close = peek();
      if (close.kind !== ")") {
        throw new WhenParseError(`expected ")" but found ${describeToken(close)}`, clause);
      }
      advance();
      return inner;
    }

    if (token.kind === "id") {
      advance();
      if (peek().kind === "==") {
        advance();
        const value = peek();
        if (value.kind !== "string") {
          throw new WhenParseError(
            `expected a string literal after "==" but found ${describeToken(value)}`,
            clause,
          );
        }
        advance();
        return { kind: "eq", key: token.value, value: value.value };
      }
      return { kind: "key", key: token.value };
    }

    throw new WhenParseError(
      `expected a context key, "!", or "(" but found ${describeToken(token)}`,
      clause,
    );
  }

  const ast = parseOr();
  const trailing = peek();
  if (trailing.kind !== "eof") {
    throw new WhenParseError(`unexpected trailing input at ${describeToken(trailing)}`, clause);
  }
  return ast;
}

/**
 * Indirection around {@link parseWhen} used only so `when.test.ts` can
 * spy on it to prove {@link compileWhen}'s AST-cache guarantee (parse
 * once, evaluate many times) without exporting the parser as public API.
 * Not part of the module's public surface — `packages/core/src/keymap/index.ts`
 * does not re-export it.
 */
export const __whenTestHooks = { parse: parseWhen };

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** Reads a single context value by key, as supplied by the context
 * service (`tecode.context.get`, Req 4.6). Unknown keys return
 * `undefined`. */
export type WhenContextGetter = (key: string) => unknown;

function evaluateNode(node: WhenNode, get: WhenContextGetter): boolean {
  switch (node.kind) {
    case "key":
      return Boolean(get(node.key));
    case "eq": {
      const actual = get(node.key);
      // Unknown keys resolve `undefined` and never satisfy `==` (design.md
      // §6.4) — checked explicitly so a clause like `x == 'undefined'`
      // can't accidentally match an unset key.
      if (actual === undefined) return false;
      // Symbols can't be stringified (String() throws TypeError) and can
      // never equal a string literal — treat as not-equal to keep
      // evaluate's never-throwing contract.
      if (typeof actual === "symbol") return false;
      return String(actual) === node.value;
    }
    case "not":
      return !evaluateNode(node.operand, get);
    case "and":
      return evaluateNode(node.left, get) && evaluateNode(node.right, get);
    case "or":
      return evaluateNode(node.left, get) || evaluateNode(node.right, get);
  }
}

/** A `when` clause parsed once into a cached {@link WhenNode}, ready to be
 * evaluated repeatedly against a context getter. */
export interface CompiledWhen {
  /** The original clause text, e.g. `"editorTextFocus && !explorerFocus"`. */
  readonly source: string;
  /** Evaluate the compiled AST against `get`. Never throws — the AST is
   * already known-valid; unknown keys are simply falsy. */
  evaluate(get: WhenContextGetter): boolean;
}

/**
 * Compile a `when` clause (Req 4.5, design.md §6.4). Parses `clause`
 * exactly once and returns a {@link CompiledWhen} whose `evaluate` walks
 * the cached AST — safe to call on every keystroke. Throws
 * {@link WhenParseError} if `clause` is not valid; callers that register
 * many bindings (Task 1.5) should catch that per-binding and skip it
 * rather than let one bad clause abort startup.
 */
export function compileWhen(clause: string): CompiledWhen {
  const ast = __whenTestHooks.parse(clause);
  return {
    source: clause,
    evaluate(get: WhenContextGetter): boolean {
      return evaluateNode(ast, get);
    },
  };
}
