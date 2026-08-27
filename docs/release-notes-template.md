Self-contained, single-file compiled binaries — no Bun, Node, or any other
runtime needed on the machine that runs them (Req 13.2). Four targets:
`bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`.
No binary is published for Intel macOS or Windows on Arm — no CI runner of
either architecture exists, and cross-compiling them is not possible; run
from source instead (`bun packages/cli/src/main.ts`, see the repository
README's "From source" section).

## Install

1. Download the binary matching your platform from this release's Assets:
   - macOS (Apple Silicon): `tecode-darwin-arm64`
   - Linux (x64): `tecode-linux-x64`
   - Linux (arm64): `tecode-linux-arm64`
   - Windows (x64): `tecode-windows-x64.exe`
2. **Verify the checksum** (recommended) — each binary ships with a
   `<binary>.sha256` sibling asset:
   - macOS/Linux: `shasum -a 256 -c tecode-<platform>-<arch>.sha256`
   - Windows (PowerShell): compare `(Get-FileHash .\tecode-windows-<arch>.exe
     -Algorithm SHA256).Hash` (case-insensitive) against the hex digest
     inside `tecode-windows-<arch>.exe.sha256`.
3. macOS/Linux only: `chmod +x tecode-<platform>-<arch>` before running it.
4. Run it against a file or directory: `./tecode-<platform>-<arch> <path>`
   (or `tecode-windows-<arch>.exe <path>` on Windows).

See the repository README's "Install" section for the full per-platform
walkthrough, the default keybindings and settings reference, the terminal
support matrix, and fallback-keymap notes for terminals without the Kitty
Keyboard Protocol.

## What's in this release

See the compare view / commit log on GitHub for the exact set of changes
since the previous tag.
