#!/usr/bin/env bun
/**
 * @mango-lsp/cli
 *
 * Entry point for the `mango-lsp` binary.
 */

import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG_TEXT,
  type LoadedConfig,
  loadConfigFile,
} from "@mango-lsp/config";
import { createProxy } from "@mango-lsp/core";
import { createJsonlLogger, createLogger, resolveLogDir } from "@mango-lsp/logger";
import { createLspServerAdapter } from "@mango-lsp/lsp-server";
import { isErrorResponse, notification, request } from "@mango-lsp/protocol";
import {
  errorMessage,
  MANGO_LSP_BINARY,
  MANGO_LSP_CONFIG_FILE,
  MANGO_LSP_LOGS_DIR,
  MANGO_LSP_STATE_DIR,
  MANGO_LSP_VERSION,
  ROLES,
  resolveCommandPath,
} from "@mango-lsp/shared";

type CommandName =
  | "serve-lsp"
  | "doctor"
  | "init"
  | "logs"
  | "test"
  | "help"
  | "--help"
  | "-h"
  | "--version"
  | "-v";

interface ParsedArgs {
  command: CommandName | undefined;
  rest: string[];
}

export interface CliIo {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
  cwd: string;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;
  return { command: (first as CommandName | undefined) ?? undefined, rest };
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function intOption(args: readonly string[], flag: string, fallback: number): number {
  const value = optionValue(args, flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configOption(args: readonly string[]): string | undefined {
  return optionValue(args, "--config") ?? optionValue(args, "-c");
}

function configPath(args: readonly string[], io: CliIo): string | undefined {
  const value = configOption(args);
  if (value === undefined) return undefined;
  return isAbsolute(value) ? value : resolve(io.cwd, value);
}

function printHelp(io: CliIo): void {
  const help = `${MANGO_LSP_BINARY} v${MANGO_LSP_VERSION}
One LSP proxy for coding agents. Exposes a single external LSP server
and routes requests to multiple child LSP servers internally.

USAGE
  ${MANGO_LSP_BINARY} <command> [options]

COMMANDS
  serve-lsp --stdio      Run as an LSP server over stdio.
  doctor                 Validate config, routes, and child server binaries.
  init                   Create a starter mango-lsp.toml in the current project.
  logs                   Show JSONL logs from .mango-lsp/logs/.
  test                   Run an initialize/shutdown self-test against child servers.
  help                   Show this help.

OPTIONS
  -c, --config <path>    Use a specific mango-lsp.toml.
  -h, --help             Show help.
  -v, --version          Show version.

EXAMPLES
  ${MANGO_LSP_BINARY} init
  ${MANGO_LSP_BINARY} doctor
  ${MANGO_LSP_BINARY} serve-lsp --stdio
  ${MANGO_LSP_BINARY} logs --lines 100
  ${MANGO_LSP_BINARY} test

Config:   mango-lsp.toml (project root)
Logs:     .mango-lsp/logs/
State:    .mango-lsp/state/
`;
  io.stdout.write(help);
}

function printConfigError(io: CliIo, error: unknown): void {
  if (error instanceof ConfigError) {
    io.stderr.write(`${error.message}\n`);
    for (const issue of error.issues) io.stderr.write(`  - ${issue}\n`);
    return;
  }
  io.stderr.write(`${errorMessage(error)}\n`);
}

async function runServeLsp(rest: readonly string[], io: CliIo): Promise<number> {
  if (!hasFlag(rest, "--stdio")) {
    io.stderr.write("serve-lsp requires --stdio in v0.1\n");
    return 2;
  }

  let loaded: LoadedConfig;
  try {
    loaded = await loadConfigFile(configPath(rest, io) ?? io.cwd);
  } catch (error) {
    printConfigError(io, error);
    return 1;
  }

  let logger: Awaited<ReturnType<typeof createJsonlLogger>> | undefined;
  try {
    logger = await createJsonlLogger({
      rootDir: loaded.rootDir,
      logDir: loaded.config.workspace.logDir,
      level: "debug",
    });
    const proxy = createProxy({ config: loaded.config, rootDir: loaded.rootDir, logger });
    const adapter = createLspServerAdapter({ proxy, transport: "stdio" });
    await adapter.start();
    await logger.close?.();
    return 0;
  } catch (error) {
    logger?.error("serve-lsp failed", { error: errorMessage(error) });
    await logger?.close?.();
    if (logger === undefined) {
      io.stderr.write(`serve-lsp failed: ${errorMessage(error)}\n`);
    }
    return 1;
  }
}

async function runDoctor(rest: readonly string[], io: CliIo): Promise<number> {
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfigFile(configPath(rest, io) ?? io.cwd);
  } catch (error) {
    printConfigError(io, error);
    return 1;
  }

  const json = hasFlag(rest, "--json");
  const commandChecks = await Promise.all(
    Object.entries(loaded.config.servers).map(async ([serverId, server]) => ({
      serverId,
      command: server.command,
      path: await resolveCommandPath(server.command, {
        rootDir: loaded.rootDir,
        cwd: server.cwd ?? loaded.rootDir,
      }),
    })),
  );
  const missing = commandChecks.filter((check) => check.path === null);
  const routeSummary = ROLES.map((role) => ({
    role,
    route: loaded.config.routes[role],
  })).filter((item) => item.route !== undefined);

  if (json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          ok: missing.length === 0,
          configPath: loaded.path,
          servers: commandChecks,
          routes: routeSummary,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout.write(`${MANGO_LSP_BINARY} doctor\n`);
    io.stdout.write(`config: ${loaded.path}\n`);
    io.stdout.write(`servers: ${commandChecks.length}\n`);
    for (const check of commandChecks) {
      io.stdout.write(
        `  ${check.path === null ? "missing" : "ok"} ${check.serverId}: ${check.command}${
          check.path === null ? "" : ` (${check.path})`
        }\n`,
      );
    }
    io.stdout.write(`routes: ${routeSummary.length}\n`);
    for (const item of routeSummary) {
      const route = item.route;
      if (route === undefined) continue;
      io.stdout.write(`  ${item.role}: ${route.strategy} -> ${route.servers.join(", ")}\n`);
    }
  }

  return missing.length === 0 ? 0 : 1;
}

async function runInit(rest: readonly string[], io: CliIo): Promise<number> {
  const force = hasFlag(rest, "--force");
  const configPath = join(io.cwd, MANGO_LSP_CONFIG_FILE);
  const stateDir = join(io.cwd, MANGO_LSP_STATE_DIR);
  const configFile = Bun.file(configPath);

  if ((await configFile.exists()) && !force) {
    io.stderr.write(`${MANGO_LSP_CONFIG_FILE} already exists; pass --force to overwrite\n`);
    return 1;
  }

  await Bun.write(configPath, DEFAULT_CONFIG_TEXT);
  await mkdir(join(stateDir, "logs"), { recursive: true });
  await mkdir(join(stateDir, "state"), { recursive: true });
  await Bun.write(join(stateDir, ".gitignore"), "logs/*\nstate/*\n!.gitignore\n");

  io.stdout.write(`wrote ${configPath}\n`);
  io.stdout.write(`created ${stateDir}/\n`);
  return 0;
}

async function runLogs(rest: readonly string[], io: CliIo): Promise<number> {
  const lines = intOption(rest, "--lines", 50);
  const raw = hasFlag(rest, "--raw");
  let rootDir: string = io.cwd;
  let logDir: string = MANGO_LSP_LOGS_DIR;

  try {
    const loaded = await loadConfigFile(configPath(rest, io) ?? io.cwd);
    rootDir = loaded.rootDir;
    logDir = loaded.config.workspace.logDir;
  } catch {
    // Logs should still be readable before a project config exists.
  }

  const directory = resolveLogDir(rootDir, logDir);
  const files = await readdir(directory).catch(() => []);
  const jsonlFiles = files.filter((file) => file.endsWith(".jsonl")).sort();
  const latest = jsonlFiles.at(-1);

  if (latest === undefined) {
    io.stdout.write(`no logs found in ${directory}\n`);
    return 0;
  }

  const path = join(directory, latest);
  const text = await Bun.file(path).text();
  const selected = text.trimEnd().split("\n").filter(Boolean).slice(-lines);

  if (raw) {
    io.stdout.write(`${selected.join("\n")}${selected.length > 0 ? "\n" : ""}`);
    return 0;
  }

  io.stdout.write(`${path}\n`);
  for (const line of selected) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        level?: unknown;
        scope?: unknown;
        message?: unknown;
      };
      io.stdout.write(
        `[${String(parsed.timestamp ?? "")}] ${String(parsed.level ?? "").toUpperCase()}${
          parsed.scope ? ` (${String(parsed.scope)})` : ""
        } ${String(parsed.message ?? "")}\n`,
      );
    } catch {
      io.stdout.write(`${line}\n`);
    }
  }
  return 0;
}

async function runTest(rest: readonly string[], io: CliIo): Promise<number> {
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfigFile(configPath(rest, io) ?? io.cwd);
  } catch (error) {
    printConfigError(io, error);
    return 1;
  }

  const missing: string[] = [];
  for (const [serverId, server] of Object.entries(loaded.config.servers)) {
    if (
      (await resolveCommandPath(server.command, {
        rootDir: loaded.rootDir,
        cwd: server.cwd ?? loaded.rootDir,
      })) === null
    ) {
      missing.push(`${serverId} (${server.command})`);
    }
  }
  if (missing.length > 0) {
    io.stderr.write(`missing child server binaries: ${missing.join(", ")}\n`);
    return 1;
  }

  const logger = createLogger({ level: "warn" });
  const proxy = createProxy({ config: loaded.config, rootDir: loaded.rootDir, logger });

  try {
    await proxy.start();
    const init = await proxy.handleRequest(
      request(1, "initialize", {
        processId: process.pid,
        rootUri: `file://${loaded.rootDir}`,
        capabilities: {},
        protocolVersion: "3.17.0",
      }),
    );
    if (isErrorResponse(init)) {
      io.stderr.write(`initialize failed: ${init.error.message}\n`);
      return 1;
    }
    await proxy.handleNotification(notification("initialized", {}));
    const shutdown = await proxy.handleRequest(request(2, "shutdown"));
    if (isErrorResponse(shutdown)) {
      io.stderr.write(`shutdown failed: ${shutdown.error.message}\n`);
      return 1;
    }
    await proxy.handleNotification(notification("exit"));
    io.stdout.write("self-test passed: child servers completed initialize/shutdown\n");
    return 0;
  } catch (error) {
    io.stderr.write(`self-test failed: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    await proxy.stop();
  }
}

export async function main(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const { command, rest } = parseArgs(argv);

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout.write(`${MANGO_LSP_BINARY} v${MANGO_LSP_VERSION}\n`);
    return 0;
  }

  switch (command) {
    case "serve-lsp":
      return await runServeLsp(rest, io);
    case "doctor":
      return await runDoctor(rest, io);
    case "init":
      return await runInit(rest, io);
    case "logs":
      return await runLogs(rest, io);
    case "test":
      return await runTest(rest, io);
    default:
      io.stderr.write(`${MANGO_LSP_BINARY}: unknown command: ${command}\n\n`);
      printHelp(io);
      return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
