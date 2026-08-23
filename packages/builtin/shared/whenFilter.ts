/**
 * A minimal `when`-clause evaluator (Task 3.2, Req 11.3; design.md §13:
 * "`ctrl+shift+p` lists `commands.list()` filtered by `when`") plus a
 * helper that filters a `CommandDescriptor[]` list by it — the command
 * palette's "should this command even be offered right now" check.
 *
 * **Independently implemented, deliberately** (this task's plan): the
 * ESLint layering rule forbids anything under `packages/builtin/**` from
 * importing `@tecode/core`, so this cannot simply reuse
 * `@tecode/core`'s `keymap/when.ts` (`compileWhen`/`evaluateNode`) even
 * though the grammar and evaluation rules below are written to match it
 * EXACTLY — same tokens (`||`, `&&`, `!`, `==`, parentheses, bare-key
 * truthiness), same precedence (`||` lowest, then `&&`, then unary `!`),
 * same `==` semantics (string-only comparison against `String(value)`,
 * unknown/`undefined` keys never equal anything, a non-stringifable value
 * — e.g. a `Symbol` — never equals anything either). Keeping these two
 * evaluators in lockstep is what makes "the palette only shows a command
 * whose keybinding would actually fire right now" a true statement — a
 * command whose `when` disagrees between the keybinding table and the
 * palette would be a confusing, silent inconsistency. If `@tecode/core`'s
 * grammar ever changes, this module needs the same change made here too.
 *
 * **Malformed clause -> `false`, never throws** (this task's plan): unlike
 * `@tecode/core`'s `compileWhen` (which throws `WhenParseError` for the
 * keybinding table to catch once, at registration time — design.md §6.4),
 * this evaluator runs on every command list refresh against contributions
 * this module has no earlier chance to validate, so it swallows a parse
 * failure at the point of use and treats the command as not-currently-shown
 * rather than ever letting a bad `when` string break the palette.
 */

/* ------------------------------------------------------------------ */
/* AST (private — mirrors @tecode/core's keymap/when.ts one-for-one)   */
/* ------------------------------------------------------------------ */

interface KeyNode {
  readonly kind: "key";
  readonly key: string;
}
interface EqNode {
  readonly kind: "eq";
  readonly key: string;
  readonly value: string;
}
interface NotNode {
  readonly kind: "not";
  readonly operand: WhenNode;
}
interface AndNode {
  readonly kind: "and";
  readonly left: WhenNode;
  readonly right: WhenNode;
}
interface OrNode {
  readonly kind: "or";
  readonly left: WhenNode;
  readonly right: WhenNode;
}
type WhenNode = KeyNode | EqNode | NotNode | AndNode | OrNode;

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokenKind = "id" | "string" | "==" | "&&" | "||" | "!" | "(" | ")" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const ID_START = /[A-Za-z_]/;
const ID_CONT = /[A-Za-z0-9_.]/;

/** Thrown internally while tokenizing/parsing — never escapes
 * {@link evaluateWhen}, which catches it and reports `false`. */
class WhenSyntaxError extends Error {}

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
      tokens.push({ kind: ch, value: ch });
      i++;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "!", value: "!" });
      i++;
      continue;
    }
    if (ch === "&" && clause[i + 1] === "&") {
      tokens.push({ kind: "&&", value: "&&" });
      i += 2;
      continue;
    }
    if (ch === "|" && clause[i + 1] === "|") {
      tokens.push({ kind: "||", value: "||" });
      i += 2;
      continue;
    }
    if (ch === "=" && clause[i + 1] === "=") {
      tokens.push({ kind: "==", value: "==" });
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
      if (j >= n) throw new WhenSyntaxError(`unterminated string literal in "${clause}"`);
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < n && ID_CONT.test(clause[j] as string)) j++;
      tokens.push({ kind: "id", value: clause.slice(i, j) });
      i = j;
      continue;
    }
    throw new WhenSyntaxError(`unrecognized character "${ch}" in "${clause}"`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Recursive-descent parser (grammar matches @tecode/core's when.ts)   */
/* ------------------------------------------------------------------ */

function parseWhen(clause: string): WhenNode {
  const tokens = tokenize(clause);
  let pos = 0;
  const peek = (): Token => tokens[pos] as Token;
  const advance = (): Token => {
    const token = peek();
    pos++;
    return token;
  };

  function parseOr(): WhenNode {
    let left = parseAnd();
    while (peek().kind === "||") {
      advance();
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): WhenNode {
    let left = parseUnary();
    while (peek().kind === "&&") {
      advance();
      left = { kind: "and", left, right: parseUnary() };
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
      if (peek().kind !== ")") throw new WhenSyntaxError(`expected ")" in "${clause}"`);
      advance();
      return inner;
    }
    if (token.kind === "id") {
      advance();
      if (peek().kind === "==") {
        advance();
        const value = peek();
        if (value.kind !== "string") {
          throw new WhenSyntaxError(`expected a string literal after "==" in "${clause}"`);
        }
        advance();
        return { kind: "eq", key: token.value, value: value.value };
      }
      return { kind: "key", key: token.value };
    }
    throw new WhenSyntaxError(`unexpected token in "${clause}"`);
  }

  const ast = parseOr();
  if (peek().kind !== "eof") throw new WhenSyntaxError(`unexpected trailing input in "${clause}"`);
  return ast;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** Reads a single context value by key (`tecode.context.get`'s shape). */
export type WhenContextGetter = (key: string) => unknown;

function evaluateNode(node: WhenNode, get: WhenContextGetter): boolean {
  switch (node.kind) {
    case "key":
      return Boolean(get(node.key));
    case "eq": {
      const actual = get(node.key);
      if (actual === undefined) return false;
      if (typeof actual === "symbol") return false;
      try {
        return String(actual) === node.value;
      } catch {
        return false;
      }
    }
    case "not":
      return !evaluateNode(node.operand, get);
    case "and":
      return evaluateNode(node.left, get) && evaluateNode(node.right, get);
    case "or":
      return evaluateNode(node.left, get) || evaluateNode(node.right, get);
  }
}

/**
 * Evaluate a `when` clause against `get` (this module's TSDoc). An
 * `undefined`/empty clause means "no restriction" — always `true`, matching
 * `CommandMeta.when`'s "declaring nothing means always visible" contract.
 * A clause that fails to tokenize or parse resolves `false` rather than
 * throwing — this function never throws.
 */
export function evaluateWhen(clause: string | undefined, get: WhenContextGetter): boolean {
  if (clause === undefined || clause.trim().length === 0) return true;
  try {
    const ast = parseWhen(clause);
    return evaluateNode(ast, get);
  } catch {
    return false;
  }
}

/**
 * Filter a list of `when`-bearing items down to those currently visible
 * (this module's TSDoc) — the command palette's use of {@link evaluateWhen}
 * over `commands.list()`. Generic over any `{ when?: string }`-shaped item
 * so it works directly against `@tecode/api`'s `CommandDescriptor` without
 * this module needing to import that type.
 */
export function filterByWhen<T extends { when?: string }>(
  items: readonly T[],
  get: WhenContextGetter,
): T[] {
  return items.filter((item) => evaluateWhen(item.when, get));
}
