# mango-lsp-proxy

One LSP proxy for coding agents. The package installs the `mango-lsp` binary, which exposes one
external LSP server and routes requests internally to multiple child LSP servers such as Biome,
tsgo, dprint, and marksman.

- **Package name:** `mango-lsp-proxy`
- **Binary / CLI name:** `mango-lsp`
- **Internal packages:** `@mango-lsp/*`

> Status: **v0.1 review candidate.** The proxy path is implemented: config loading, JSON-RPC/LSP
> framing, child stdio clients, role-based routing, diagnostics aggregation, code action merging,
> JSONL logs, CLI commands, and Bun tests.

## Why

Coding agents and editors usually talk to one LSP server at a time. Real projects often need several
servers active at once, for example `tsgo` for navigation and `biome` for diagnostics and
formatting. `mango-lsp` solves that by:

- exposing a single external LSP server (`mango-lsp serve-lsp --stdio`) to the agent/editor,
- spawning configured child LSP servers internally,
- routing each request to the right child server or servers based on a role.

## Install and use

The package is installed under one name and the binary is run under another:

```sh
bun install -g mango-lsp-proxy
# or
npm i -g mango-lsp-proxy

mango-lsp init
mango-lsp doctor
mango-lsp serve-lsp --stdio
```

- Install as `mango-lsp-proxy`.
- Run as `mango-lsp`.
- The published package installs the matching native binary for the user's OS/CPU/libc.
- Node or Bun can be used as the installer, but the installed `mango-lsp` command is a native
  executable and does not need a JavaScript runtime to run.
- Project config file is `mango-lsp.toml`.
- Local state and logs live under `.mango-lsp/`.

Installer script options are available for users who do not want npm or Bun. `install.sh` covers
Linux and macOS; `install.ps1` covers Windows:

```sh
curl -fsSL https://github.com/juliopolycarpo/mango-lsp-proxy/releases/latest/download/install.sh | sh
```

```powershell
iwr https://github.com/juliopolycarpo/mango-lsp-proxy/releases/latest/download/install.ps1 -UseBasicParsing | iex
```

macOS binaries are not Apple-notarized. Package-manager and `install.sh` installs are not
quarantined, but a binary downloaded manually through a browser must be cleared with
`xattr -d com.apple.quarantine ./mango-lsp` before first run.

Windows users will be able to install through `winget` after the generated winget manifests are
accepted into the community package repository:

```powershell
winget install JulioPolycarpo.MangoLSP
```

## CLI

```sh
mango-lsp serve-lsp --stdio      Run as an external LSP server over stdio.
mango-lsp doctor                 Validate config, routes, and child server binaries.
mango-lsp init                   Scaffold mango-lsp.toml and .mango-lsp/.
mango-lsp logs                   Show the latest JSONL log file.
mango-lsp test                   Run initialize/shutdown self-test against child servers.
mango-lsp help                   Show help.
```

Common options:

```sh
mango-lsp doctor --config ./mango-lsp.toml --json
mango-lsp logs --lines 100 --raw
mango-lsp init --force
```

`doctor` and `test` report missing child binaries clearly. `serve-lsp` writes protocol traffic only
to stdout and writes runtime logs as JSONL under `.mango-lsp/logs/`.

## v0.1 Scope

Included:

- one package `mango-lsp-proxy` with one binary `mango-lsp`,
- external LSP server: `mango-lsp serve-lsp --stdio`,
- child LSP clients over stdio,
- project config `mango-lsp.toml`,
- role-based routing for `navigation`, `hover`, `references`, `symbols`, `diagnostics`,
  `codeActions`, and `formatting`,
- aggregated `textDocument/publishDiagnostics`,
- merged `textDocument/codeAction` results,
- `codeAction/resolve` routing back to the source child server,
- `workspace/executeCommand` routing for commands returned from merged code actions,
- CLI commands: `serve-lsp`, `doctor`, `init`, `logs`, `test`,
- JSONL logs under `.mango-lsp/logs/`,
- Zod validation for config and JSON-RPC message shape.

Out of scope for v0.1:

- dashboard,
- TUI,
- daemon mode,
- MCP server.

## Architecture

```text
+-------------------+        stdio        +-------------------+
|  editor / agent   | <-----------------> |  mango-lsp (CLI)  |
+-------------------+   LSP / JSON-RPC    +---------+---------+
                                                    |
                                                    v
                                          +-------------------+
                                          |  @mango-lsp/      |
                                          |   lsp-server      |   external adapter
                                          +---------+---------+
                                                    |
                                                    v
                                          +-------------------+
                                          |  @mango-lsp/core  |   routing / aggregation
                                          +---------+---------+
                                                    |
                                          +---------+---------+
                                          |  @mango-lsp/      |
                                          |   lsp-client      |   one per child server
                                          +---------+---------+
                                                    |
                                  stdio / JSON-RPC  |
                            +-----------+-----------+
                            |           |           |
                            v           v           v
                        biome lsp-proxy  tsgo --lsp --stdio  ...
```

Workspace packages:

- `apps/cli` (`@mango-lsp/cli`) - the `mango-lsp` binary entry point.
- `packages/core` (`@mango-lsp/core`) - proxy brain, role routing, aggregation, merging.
- `packages/lsp-server` (`@mango-lsp/lsp-server`) - external LSP server adapter.
- `packages/lsp-client` (`@mango-lsp/lsp-client`) - stdio client for one child LSP server.
- `packages/protocol` (`@mango-lsp/protocol`) - JSON-RPC validation and LSP framing.
- `packages/config` (`@mango-lsp/config`) - `mango-lsp.toml` schema and loader.
- `packages/logger` (`@mango-lsp/logger`) - stderr and JSONL loggers.
- `packages/shared` (`@mango-lsp/shared`) - constants and shared primitives.

## Configuration

See [`mango-lsp.toml`](./mango-lsp.toml) for the full sample. Excerpt:

```toml
[servers.biome]
command = "biome"
args = ["lsp-proxy"]
roles = ["diagnostics", "codeActions", "formatting"]
languages = ["javascript", "typescript", "javascriptreact", "typescriptreact", "json", "css"]

[servers.tsgo]
command = "tsgo"
args = ["--lsp", "--stdio"]
roles = ["navigation", "hover", "references", "symbols", "diagnostics"]
languages = ["javascript", "typescript", "javascriptreact", "typescriptreact"]

[routes.diagnostics]
strategy = "aggregate"
servers = ["tsgo", "biome"]
```

`command` and `args` are kept separate so child servers are spawned without a shell command string.
If `[routes.*]` entries are omitted, `mango-lsp` derives conservative defaults from each server's
declared `roles`.

## Development

This is a Bun-first TypeScript monorepo. Required tooling:

- [Bun](https://bun.sh) 1.3+
- [`@biomejs/biome`](https://biomejs.dev/) for TS/JS/JSON/CSS lint + format
- [`dprint`](https://dprint.dev/) for Markdown, TOML, YAML format
- [`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview) (`tsgo`)
  for fast typechecking

Common commands:

```sh
bun install
bun run dev help
bun test
bun run test:coverage
bun run check
bun run fmt
bun run changelog
bun run changelog:check
bun run build
bun run build:bin
bun run build:current
bun run smoke:bin
```

Test files use:

- `.unit.test.ts` for unit tests,
- `.integration.test.ts` for integration tests.
- `.e2e.test.ts` for end-to-end tests.

Coverage gate:

```sh
bun run test:coverage
```

The coverage gate runs `bun test --coverage`, writes `coverage/lcov.info`, and fails if coverage
drops below the current project floor. The long-term target is 90%+ line and function coverage. When
a PR raises either metric above the configured floor, raise that floor in `scripts/coverage-gate.ts`
before merging so the gain is preserved.

## Changelog

The canonical changelog is [`CHANGELOG.md`](./CHANGELOG.md). It is generated with
[`git-cliff`](https://git-cliff.org/) from conventional commits using [`cliff.toml`](./cliff.toml).

Regenerate it after release-facing changes:

```sh
bun run changelog
```

Validate the git-cliff config without rewriting the tracked changelog:

```sh
bun run changelog:check
```

There is intentionally **no ESLint**, **no Prettier**, and **no Turborepo** in v0.1.

## Native Releases

`mango-lsp-proxy` publishes one root package and one optional native package per supported target.
The root package owns the `mango-lsp` bin path. During package installation, its postinstall step
copies the correct optional native package into that path, so package-manager installs still produce
a standalone executable:

```text
@mango-lsp/mango-lsp-proxy-windows-x64
@mango-lsp/mango-lsp-proxy-windows-arm64
@mango-lsp/mango-lsp-proxy-linux-x64
@mango-lsp/mango-lsp-proxy-linux-arm64
@mango-lsp/mango-lsp-proxy-linux-x64-musl
@mango-lsp/mango-lsp-proxy-linux-arm64-musl
@mango-lsp/mango-lsp-proxy-darwin-x64
@mango-lsp/mango-lsp-proxy-darwin-arm64
```

Build all release binaries:

```sh
bun run build
bun run smoke:bin
```

Build only the current host binary:

```sh
bun run build:current
```

GitHub binary releases are created by pushing a version tag. Tags without a prerelease suffix create
official releases; tags with a hyphenated suffix create GitHub prereleases.

```sh
git tag -s 0.1 -m "Release 0.1"
git push origin 0.1

git tag -s 0.1-pre -m "Release 0.1-pre"
git push origin 0.1-pre
```

The release workflow validates the tag, runs checks and tests, builds every native binary target,
smoke-checks the binaries, generates structured git-cliff release notes, uploads binary release
assets, uploads SHA-256 checksums, uploads the GitHub commit SHA, uploads standalone installer
scripts, generates winget manifests, publishes the native npm packages, publishes the root npm
package, and uses GitHub's built-in source archives for source code.

GitHub tags may use `0.1` or `0.1-pre` form. The npm package version is normalized to semver, so
those tags publish as `0.1.0` and `0.1.0-pre`. Prereleases publish to the npm `next` dist-tag;
official releases publish to `latest`. Bun installs from the npm registry, so the same publish step
supports both `npm install -g mango-lsp-proxy` and `bun install -g mango-lsp-proxy`.

For npm trusted publishing, configure each published package on npmjs.com to trust the
`.github/workflows/release.yml` workflow for this repository. The workflow uses GitHub Actions OIDC
and `npm publish --provenance`.

`bun scripts/publish-packages.ts --tag <dist-tag>` performs the publish. It publishes every native
package first and the root package last, so the metapackage never resolves to native versions that
are not yet live. Each package is retried up to three times with exponential backoff, and a version
that npm reports as already published is treated as a skip rather than a failure — so re-running the
release after a partial publish picks up where it left off instead of erroring on the live packages.
On failure it logs which packages are already live, which one failed, and which were not attempted,
so manual recovery is straightforward.

Publish order:

```sh
bun scripts/publish-packages.ts --tag latest
# 1. @mango-lsp/mango-lsp-proxy-windows-x64
# 2. @mango-lsp/mango-lsp-proxy-windows-arm64
# 3. @mango-lsp/mango-lsp-proxy-linux-x64
# 4. @mango-lsp/mango-lsp-proxy-linux-arm64
# 5. @mango-lsp/mango-lsp-proxy-linux-x64-musl
# 6. @mango-lsp/mango-lsp-proxy-linux-arm64-musl
# 7. @mango-lsp/mango-lsp-proxy-darwin-x64
# 8. @mango-lsp/mango-lsp-proxy-darwin-arm64
# 9. mango-lsp-proxy (root, published last)
```

Before publishing, run:

```sh
bun run check
bun run test:coverage
bun run changelog
bun run build
bun run smoke:bin
npm pack --dry-run
```

### Editor Integration

No editor-specific settings are required for v0.1. If your editor supports TypeScript Native
Preview, point it at the workspace `@typescript/native-preview` install using settings supported by
your editor version.

## Roadmap

Post-v0.1 candidates:

- richer child-to-editor request forwarding,
- restart policy enforcement for crashed child servers,
- configuration presets per language/tool,
- MCP adapter,
- daemon mode,
- richer log inspection UI.
