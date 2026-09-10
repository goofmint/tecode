/**
 * Binary-content detection (Issue #137 — "opening a binary file corrupts
 * subsequent rendering"). `documentManager.ts`'s `openDocumentUncached`
 * calls {@link isBinaryContent} on a file's raw bytes BEFORE ever decoding
 * anything as UTF-8 text, and aborts the open entirely on a positive result
 * (see that module's own `Cannot open binary file` branch) — a binary file
 * was previously decoded as UTF-8 lossy text (each invalid byte sequence
 * becoming `�`, and NUL/other C0 control bytes passed through
 * verbatim) and handed to a `CoreDocument`, which then corrupted the
 * terminal's rendering for everything drawn after it once those raw control
 * bytes reached OpenTUI's `<text>` output.
 *
 * A pure, synchronous function — no I/O of its own — so `documentManager.ts`
 * (the only real caller) fully controls how many bytes are actually read
 * off disk before calling this; `terminal/ptyService.ts`'s `PtySession.
 * onData` is this codebase's existing precedent for treating raw process/
 * file bytes as a plain `Uint8Array` rather than a Node `Buffer`-specific
 * type, which is why this module's signature does the same.
 */

/**
 * How many leading bytes {@link isBinaryContent} inspects. Mirrors
 * `documentManager.ts`'s own `LARGE_FILE_THRESHOLD_BYTES` design principle —
 * a cheap, bounded-prefix heuristic rather than one that has to read (or in
 * this case, scan) an entire multi-megabyte file just to decide whether to
 * proceed. 8 KB is the same order of magnitude `file(1)`-style content
 * sniffing conventionally uses: large enough that a genuine text file's
 * leading bytes are extremely unlikely to contain a stray NUL by chance,
 * small enough to stay cheap on every single `openDocument` call.
 */
export const BINARY_DETECTION_SAMPLE_BYTES = 8192;

/**
 * `true` when `bytes` looks like binary content rather than text: a NUL
 * byte (`0x00`) anywhere in the first {@link BINARY_DETECTION_SAMPLE_BYTES}
 * bytes. NUL is the sole signal (not, say, "any non-UTF-8 byte sequence" or
 * "a high proportion of control bytes") because it is unambiguous: a NUL
 * byte essentially never appears in genuine UTF-8 text (every real text
 * format either forbids it outright or reserves it as a true end-of-string
 * sentinel that text editors never intentionally embed), while almost every
 * binary format — executables, images, archives, serialized data — pads,
 * aligns, or terminates with NUL bytes within its first few kilobytes. This
 * keeps the heuristic simple and free of false positives on legitimate text
 * containing unusual-but-valid bytes (e.g. a UTF-8 BOM, or content in an
 * encoding `documentManager.ts` doesn't otherwise validate).
 *
 * Synchronous and side-effect-free: `bytes.subarray` is a view, not a copy,
 * so scanning even a very large `bytes` array costs only the bounded
 * `BINARY_DETECTION_SAMPLE_BYTES`-byte scan, never proportional to the
 * whole file.
 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, BINARY_DETECTION_SAMPLE_BYTES);
  for (let i = 0; i < sampleLength; i++) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}
