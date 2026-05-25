# Security Policy

## Supported Versions

Security fixes target the current `main` branch until the project publishes versioned releases.

## Reporting a Vulnerability

Do not open a public issue for suspected vulnerabilities.

Use GitHub's private vulnerability reporting or contact the maintainer privately with:

- a description of the issue,
- affected versions or commits if known,
- reproduction steps or proof of concept,
- expected impact,
- any suggested mitigation.

The maintainer will review the report, ask for clarification when needed, and coordinate a fix and
disclosure timeline based on severity.

## Scope

Relevant security reports include issues in:

- JSON-RPC or LSP message parsing,
- child process spawning and argument handling,
- config loading,
- filesystem access,
- logging of sensitive data.

Reports about unsupported third-party child LSP servers should be sent to those projects unless the
issue is caused by `mango-lsp-proxy` integration behavior.
