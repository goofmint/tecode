# tecode

## Release

`bun run release [target ...]` builds the compiled-binary release matrix
(see `scripts/release.ts`'s TSDoc for the full embedding story and why
cross-compilation is not possible from a single machine). Three of Issue
#35's completion requirements need a platform or a real terminal this repo's
own CI/dev environment doesn't have — see
[`docs/manual-release-verification.md`](docs/manual-release-verification.md)
for the exact procedure.