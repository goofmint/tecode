; Markdown highlight query (Req 8.2, 8.4) — targets the tree-sitter-grammars/
; tree-sitter-markdown BLOCK grammar only (`markdown.wasm`; the sibling
; `markdown_inline` grammar, which colors emphasis/strong/links/code spans
; *inside* paragraph text, is intentionally not wired up — `LanguageContribution`
; (Req 8.2) has exactly one `grammar`/`highlights` pair per language, with no
; injection-query mechanism to hand inline spans to a second grammar, so this
; MVP colors block structure only; see NOTICE.md).
;
; Captures are this project's own vocabulary (design.md §9's `keyword`,
; `string`, `comment`, `function`, `type`, `variable`, `number`, `operator`,
; `punctuation`, plus dotted refinements) rather than nvim-treesitter's
; upstream `@text.*` names (`text.title`, `text.literal`, `text.uri`, ...) —
; those resolve to nothing via `themeLoader.ts`'s longest-prefix fallback
; (no `text` base key exists), so this query re-targets the same node types
; nvim-treesitter's markdown query highlights, using node names confirmed
; against `tree-sitter-markdown`'s `node-types.json`.

(atx_heading (inline) @keyword)
(setext_heading (paragraph) @keyword)

[
  (atx_h1_marker)
  (atx_h2_marker)
  (atx_h3_marker)
  (atx_h4_marker)
  (atx_h5_marker)
  (atx_h6_marker)
  (setext_h1_underline)
  (setext_h2_underline)
] @punctuation.special

[
  (indented_code_block)
  (fenced_code_block)
] @string

(fenced_code_block_delimiter) @punctuation.delimiter
(info_string) @type

(link_destination) @string
(link_label) @variable
(link_title) @string

[
  (list_marker_plus)
  (list_marker_minus)
  (list_marker_star)
  (list_marker_dot)
  (list_marker_parenthesis)
  (thematic_break)
] @punctuation.special

[
  (task_list_marker_checked)
  (task_list_marker_unchecked)
] @keyword

[
  (block_continuation)
  (block_quote_marker)
] @comment

(html_block) @comment

(backslash_escape) @string.escape

[
  (pipe_table_delimiter_row)
  (pipe_table_delimiter_cell)
] @punctuation.special
