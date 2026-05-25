/**
 * @mango-lsp/config
 *
 * Zod-backed schema, TOML loading, and defaults for `mango-lsp.toml`.
 */

import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultStrategyForRole,
  MANGO_LSP_CONFIG_FILE,
  MANGO_LSP_LOGS_DIR,
  ROLES,
  ROUTE_STRATEGIES,
  type Role,
  type RouteStrategy,
} from "@mango-lsp/shared";
import { z } from "zod";

const roleTuple = ROLES as unknown as [Role, ...Role[]];
const strategyTuple = ROUTE_STRATEGIES as unknown as [RouteStrategy, ...RouteStrategy[]];

export const RoleSchema = z.enum(roleTuple);
export const RouteStrategySchema = z.enum(strategyTuple);
export const ServerIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/, "server ids may contain letters, numbers, dot, underscore, dash");

export const WorkspaceConfigSchema = z
  .object({
    rootMarkers: z.array(z.string().min(1)).default([".git", "package.json"]),
    logDir: z.string().min(1).default(MANGO_LSP_LOGS_DIR),
  })
  .strict();

export const DefaultsConfigSchema = z
  .object({
    timeout: z.number().int().positive().default(12_000),
    restartOnCrash: z.boolean().default(true),
    maxRestarts: z.number().int().nonnegative().default(3),
  })
  .strict();

export const ServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
    roles: z.array(RoleSchema).default([]),
    languages: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const RouteConfigSchema = z
  .object({
    strategy: RouteStrategySchema,
    servers: z.array(ServerIdSchema).min(1),
  })
  .strict();

export interface WorkspaceConfig {
  rootMarkers: string[];
  logDir: string;
}

export interface DefaultsConfig {
  timeout: number;
  restartOnCrash: boolean;
  maxRestarts: number;
}

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  roles: Role[];
  languages: string[];
}

export interface RouteConfig {
  strategy: RouteStrategy;
  servers: string[];
}

export interface MangoLspConfig {
  workspace: WorkspaceConfig;
  defaults: DefaultsConfig;
  servers: Record<string, ServerConfig>;
  routes: Partial<Record<Role, RouteConfig>>;
}

export const MangoLspConfigSchema = z
  .object({
    workspace: WorkspaceConfigSchema.default({}),
    defaults: DefaultsConfigSchema.default({}),
    servers: z.record(ServerIdSchema, ServerConfigSchema).default({}),
    routes: z.record(RoleSchema, RouteConfigSchema).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [role, route] of Object.entries(config.routes)) {
      for (const serverId of route.servers) {
        if (!(serverId in config.servers)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", role, "servers"],
            message: `route references unknown server "${serverId}"`,
          });
        }
      }
    }
  });

export const DEFAULT_CONFIG_TEXT = `# mango-lsp.toml

[workspace]
rootMarkers = [".git", "package.json", "tsconfig.json", "biome.json"]
logDir = ".mango-lsp/logs"

[defaults]
timeout = 12000
restartOnCrash = true
maxRestarts = 3

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

[routes.navigation]
strategy = "firstSuccessful"
servers = ["tsgo"]

[routes.hover]
strategy = "firstSuccessful"
servers = ["tsgo"]

[routes.references]
strategy = "firstSuccessful"
servers = ["tsgo"]

[routes.symbols]
strategy = "firstSuccessful"
servers = ["tsgo"]

[routes.diagnostics]
strategy = "aggregate"
servers = ["tsgo", "biome"]

[routes.codeActions]
strategy = "merge"
servers = ["biome", "tsgo"]

[routes.formatting]
strategy = "preferred"
servers = ["biome"]
`;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = [...issues];
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

function deriveRoutes(config: MangoLspConfig): Partial<Record<Role, RouteConfig>> {
  const routes: Partial<Record<Role, RouteConfig>> = { ...config.routes };

  for (const role of ROLES) {
    if (routes[role] !== undefined) continue;
    const servers = Object.entries(config.servers)
      .filter(([, server]) => server.roles.includes(role))
      .map(([serverId]) => serverId);
    if (servers.length === 0) continue;
    routes[role] = { strategy: defaultStrategyForRole(role), servers };
  }

  return routes;
}

function parseConfigObject(raw: unknown): MangoLspConfig {
  const parsed = MangoLspConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError("invalid mango-lsp.toml", zodIssues(parsed.error));
  }
  return { ...parsed.data, routes: deriveRoutes(parsed.data) };
}

export function parseConfigText(text: string): MangoLspConfig {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid TOML";
    throw new ConfigError(`could not parse ${MANGO_LSP_CONFIG_FILE}: ${message}`);
  }
  return parseConfigObject(raw);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigPath(startDir = process.cwd()): Promise<string | undefined> {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, MANGO_LSP_CONFIG_FILE);
    if (await exists(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveConfigPath(pathOrDir?: string): Promise<string> {
  if (pathOrDir === undefined) {
    const found = await findConfigPath();
    if (found === undefined) {
      throw new ConfigError(`could not find ${MANGO_LSP_CONFIG_FILE}`);
    }
    return found;
  }

  const resolved = isAbsolute(pathOrDir) ? pathOrDir : resolve(process.cwd(), pathOrDir);
  const info = await stat(resolved).catch(() => undefined);
  if (info?.isDirectory()) {
    const found = await findConfigPath(resolved);
    if (found === undefined) {
      throw new ConfigError(`could not find ${MANGO_LSP_CONFIG_FILE} from ${resolved}`);
    }
    return found;
  }
  return resolved;
}

export interface LoadedConfig {
  path: string;
  rootDir: string;
  config: MangoLspConfig;
}

export async function loadConfigFile(pathOrDir?: string): Promise<LoadedConfig> {
  const path = await resolveConfigPath(pathOrDir);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`config file does not exist: ${path}`);
  }
  const text = await file.text();
  return { path, rootDir: dirname(path), config: parseConfigText(text) };
}
