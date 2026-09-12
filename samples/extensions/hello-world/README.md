# Hello World sample extension

The smallest possible tecode extension: a manifest plus one command, with
no sidebar view, configuration key, or keybinding. Copy this directory
into place to see the discover → validate → register → activate pipeline
work end to end before reaching for anything more elaborate.

## Where to put it

Copy `hello-world/` into one of:

- `~/.config/tecode/extensions/hello-world/` (or
  `%APPDATA%\tecode\extensions\hello-world\` on Windows) — loads for
  every workspace you open.
- `<workspace-root>/.tecode/extensions/hello-world/` — loads only when
  tecode is opened on that workspace.

## Running it

Open the command palette (`ctrl+shift+p`) and run **Hello World: Say
Hello**. A "Hello, World!" notification appears — that's the whole
sample.

## Next steps

For a fuller walkthrough — a sidebar view, a configuration key, a
keybinding, and the complete `tecode.*` API reference — see
[`docs/extension-authoring-guide.md`](../../../docs/extension-authoring-guide.md).
