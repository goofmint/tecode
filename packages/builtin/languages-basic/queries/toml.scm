; Properties
;-----------

; Table/table-array headers: the key names a section, so it is `@type`
; (matches upstream tree-sitter-toml's own highlights.scm convention: table
; names are `@type`, pair keys are `@property`). Scoped to `table`/
; `table_array_element`'s own header key (not their nested `pair`s' keys,
; which the `pair`-scoped rules below capture instead) so a `bare_key` node
; never receives two conflicting captures.
(table (bare_key) @type)
(table (dotted_key (bare_key) @type))
(table_array_element (bare_key) @type)
(table_array_element (dotted_key (bare_key) @type))

(quoted_key) @string

; Pair keys: `@property` attaches to the key node itself, never to the
; enclosing `pair` (which also spans "= value") — capturing the whole `pair`
; would style the value too and fight the value's own capture (`@string`/
; `@number`/etc.) for the same span.
(pair
  (bare_key) @property)

(pair
  (dotted_key
    (bare_key) @property))

; Literals
;---------

(boolean) @boolean

(comment) @comment

(string) @string

[
  (integer)
  (float)
] @number

[
  (offset_date_time)
  (local_date_time)
  (local_date)
  (local_time)
] @string.special

; Punctuation
;------------

[
  "."
  ","
] @punctuation.delimiter

"=" @operator

[
  "["
  "]"
  "[["
  "]]"
  "{"
  "}"
] @punctuation.bracket
