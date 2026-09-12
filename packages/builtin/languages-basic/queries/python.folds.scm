; Block-statement folding (Issue #150) — Python has no brace containers,
; so the statements that own an indented suite are the fold regions.
(function_definition) @fold
(class_definition) @fold
(if_statement) @fold
(for_statement) @fold
(while_statement) @fold
(with_statement) @fold
(try_statement) @fold
