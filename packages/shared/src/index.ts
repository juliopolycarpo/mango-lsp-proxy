/**
 * @mango-lsp/shared
 *
 * Shared primitives that any other workspace package may use without
 * pulling in heavier dependencies. Keep this package free of imports
 * from other workspace packages.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Semantic version of the mango-lsp product. */
export const MANGO_LSP_VERSION = "0.1.0" as const;

/** The user-facing binary name. */
export const MANGO_LSP_BINARY = "mango-lsp" as const;

/** The published package name (npm). */
export const MANGO_LSP_PACKAGE = "mango-lsp-proxy" as const;

/** Default local-state directory (relative to project root). */
export const MANGO_LSP_STATE_DIR = ".mango-lsp" as const;

/** Default logs directory (relative to project root). */
export const MANGO_LSP_LOGS_DIR = ".mango-lsp/logs" as const;

/** Default project config filename. */
export const MANGO_LSP_CONFIG_FILE = "mango-lsp.toml" as const;

/** Roles that requests can be routed by. */
export const ROLES = [
  "navigation",
  "hover",
  "references",
  "symbols",
  "diagnostics",
  "codeActions",
  "formatting",
] as const;

export type Role = (typeof ROLES)[number];

/** Routing strategies supported by the proxy. */
export const ROUTE_STRATEGIES = ["firstSuccessful", "aggregate", "merge", "preferred"] as const;

export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

/** A stable identifier for a configured child LSP server. */
export type ServerId = string;

/** Current LSP protocol version advertised by mango-lsp. */
export const LSP_PROTOCOL_VERSION = "3.17.0" as const;

/** Synthetic command used when routing child executeCommand requests back to their source server. */
export const MANGO_LSP_EXECUTE_COMMAND = "mango-lsp.execute" as const;

/** Request methods that need role-based routing. */
export const METHOD_ROLES = {
  "textDocument/definition": "navigation",
  "textDocument/declaration": "navigation",
  "textDocument/implementation": "navigation",
  "textDocument/typeDefinition": "navigation",
  "textDocument/hover": "hover",
  "textDocument/references": "references",
  "textDocument/documentSymbol": "symbols",
  "workspace/symbol": "symbols",
  "textDocument/codeAction": "codeActions",
  "codeAction/resolve": "codeActions",
  "workspace/executeCommand": "codeActions",
  "textDocument/formatting": "formatting",
  "textDocument/rangeFormatting": "formatting",
  "textDocument/onTypeFormatting": "formatting",
  "textDocument/diagnostic": "diagnostics",
  "workspace/diagnostic": "diagnostics",
} as const satisfies Record<string, Role>;

export type RoutableMethod = keyof typeof METHOD_ROLES;

export function roleForMethod(method: string): Role | undefined {
  return METHOD_ROLES[method as RoutableMethod];
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coerce an unknown thrown value into an Error, using `fallback` for non-Errors. */
export function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function executableCandidates(path: string): string[] {
  if (process.platform !== "win32") return [path];
  return [path, `${path}.cmd`, `${path}.exe`, `${path}.bat`];
}

function looksLikePath(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandResolutionOptions {
  rootDir?: string | undefined;
  cwd?: string | undefined;
}

export function nodeModulesBinDirs(options: CommandResolutionOptions = {}): string[] {
  return uniqueStrings([options.cwd, options.rootDir]).map((directory) =>
    join(directory, "node_modules", ".bin"),
  );
}

export function withNodeModulesBinPath(
  env: Record<string, string>,
  options: CommandResolutionOptions = {},
): Record<string, string> {
  const directories = nodeModulesBinDirs(options);
  if (directories.length === 0) return env;

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existing = env[pathKey] ?? env.PATH ?? env.Path ?? "";
  return {
    ...env,
    [pathKey]: [...directories, existing].filter((value) => value.length > 0).join(delimiter),
  };
}

export async function resolveCommandPath(
  command: string,
  options: CommandResolutionOptions = {},
): Promise<string | null> {
  if (looksLikePath(command)) {
    const baseDir = options.cwd ?? options.rootDir ?? process.cwd();
    const candidate = isAbsolute(command) ? command : resolve(baseDir, command);
    for (const path of executableCandidates(candidate)) {
      if (await isExecutableFile(path)) return path;
    }
    return null;
  }

  const systemPath = await Bun.which(command);
  if (systemPath !== null) return systemPath;

  for (const directory of nodeModulesBinDirs(options)) {
    for (const path of executableCandidates(join(directory, command))) {
      if (await isExecutableFile(path)) return path;
    }
  }

  return null;
}

export function defaultStrategyForRole(role: Role): RouteStrategy {
  switch (role) {
    case "diagnostics":
      return "aggregate";
    case "codeActions":
      return "merge";
    case "formatting":
      return "preferred";
    case "navigation":
    case "hover":
    case "references":
    case "symbols":
      return "firstSuccessful";
  }
}
