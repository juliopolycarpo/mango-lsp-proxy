# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
bun install           # install dependencies
bun run dev help      # run the CLI without building (entry: apps/cli/src/main.ts)
bun test              # run all tests
bun run test:unit                  # unit tests only
bun run test:integration           # integration tests only
bun run test:e2e                   # e2e tests only
bun run check         # typecheck (tsgo) + biome lint + dprint format-check (sequential, stops on first failure)
bun run fmt           # auto-format with biome + dprint
bun run typecheck     # tsgo --noEmit only
bun run lint          # biome check only
bun run build         # compile all native binary package targets
bun run build:bin     # alias for native binary build
bun run build:current # compile only the current host native target
bun run build:js      # bundle to dist/mango-lsp (Bun JS, not compiled)
bun run smoke:bin     # validate built binary headers and run host binary --version
```

`bun run check` is the single pre-commit gate — it runs typecheck, biome, and dprint in sequence.

## Architecture

Bun-first TypeScript monorepo. No ESLint, Prettier, or Turborepo. Packages are under `packages/`,
the CLI entrypoint is under `apps/cli`.

**Request flow:**

```
editor/agent  --stdio-->  @mango-lsp/lsp-server  -->  @mango-lsp/core  -->  N × @mango-lsp/lsp-client  --stdio-->  child LSP servers
```

**Package responsibilities:**

| Package                                         | Role                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/cli` (`@mango-lsp/cli`)                   | `mango-lsp` binary, all CLI commands                                                  |
| `packages/core` (`@mango-lsp/core`)             | Proxy brain: starts clients, role routing, response aggregation/merging               |
| `packages/lsp-server` (`@mango-lsp/lsp-server`) | Content-Length framed stdio adapter facing the editor/agent                           |
| `packages/lsp-client` (`@mango-lsp/lsp-client`) | stdio client for one child LSP server                                                 |
| `packages/protocol` (`@mango-lsp/protocol`)     | JSON-RPC 2.0 framing, Zod schemas, encode/decode                                      |
| `packages/config` (`@mango-lsp/config`)         | `mango-lsp.toml` Zod schema, TOML loader, route derivation                            |
| `packages/shared` (`@mango-lsp/shared`)         | Constants, `Role`, `RouteStrategy`, `ServerId`, `METHOD_ROLES` — no workspace imports |
| `packages/logger` (`@mango-lsp/logger`)         | stderr logger + JSONL file logger                                                     |

## Key design points

**Roles and routing strategies** — every routable LSP method maps to one of seven roles
(`navigation`, `hover`, `references`, `symbols`, `diagnostics`, `codeActions`, `formatting`) defined
in `@mango-lsp/shared`. Each role has a route in `mango-lsp.toml` with a strategy:

- `firstSuccessful` — try servers in order, return first usable result
- `merge` — fan out, concatenate all array results
- `aggregate` — fan out, flatten arrays (used for diagnostics)
- `preferred` — alias for `firstSuccessful`

If `[routes.*]` entries are omitted from the config, `core` derives them automatically from each
server's declared `roles`.

**Code action tagging** — when merging code actions from multiple servers, `core` embeds a
`__mangoLsp` metadata key into each action's `data` field to remember which child server issued it.
`codeAction/resolve` and `workspace/executeCommand` use this metadata to route back to the correct
child. The tag is stripped before forwarding to the child and restored in the response.

**Diagnostics aggregation** — `textDocument/publishDiagnostics` notifications from children are
intercepted, merged per-URI keyed by server ID, and re-emitted as a single combined notification to
the editor.

**Config loading** — `loadConfigFile` walks up directories from a given path looking for
`mango-lsp.toml`. Routes are derived from `servers[*].roles` when not explicitly set.

## Tooling

- **Formatter/linter:** Biome handles TS/JS/JSON/CSS. dprint handles Markdown and TOML.
- **Type checker:** `@typescript/native-preview` (`tsgo`) — not `tsc`.
- **Test naming:** `.unit.test.ts` for unit tests, `.integration.test.ts` for integration tests.
- **Runtime:** Bun 1.3+. Uses `Bun.TOML.parse`, `Bun.spawn`, `Bun.file`, `Bun.which`.
