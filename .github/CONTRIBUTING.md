# Contributing

Thanks for taking the time to improve `mango-lsp-proxy`.

## Development Setup

Requirements:

- Bun 1.3 or newer
- Git

Install dependencies:

```sh
bun install
```

Useful commands:

```sh
bun run dev help
bun test
bun run test:coverage
bun run check
bun run fmt
bun run build
```

`bun run check` is the pre-commit gate. It runs typechecking, Biome, and dprint checks.

## Project Conventions

- Keep runtime code Bun-first.
- Use `tsgo` through `bun run typecheck`; do not add `tsc` as a parallel gate.
- Use Biome for TypeScript, JavaScript, JSON, and CSS.
- Use dprint for Markdown, TOML, and YAML.
- Name unit tests `*.unit.test.ts`.
- Name integration tests `*.integration.test.ts`.
- Keep package boundaries aligned with the architecture in `README.md` and `AGENTS.md`.

## Pull Requests

Before opening a pull request:

- run `bun run check`,
- run `bun run test:coverage`,
- update documentation when behavior or commands change,
- include tests for routing, protocol, config, or CLI behavior when applicable.

Coverage should move toward 90%+ lines and functions. When a change improves either metric above the
current floor, raise the matching coverage gate threshold in `scripts/coverage-gate.ts`.

Small, focused pull requests are easier to review. If a change affects the LSP request flow or route
semantics, explain the behavior change clearly in the pull request description.
