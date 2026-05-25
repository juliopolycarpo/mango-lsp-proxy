/**
 * @mango-lsp/core
 *
 * The proxy brain: starts child LSP clients, routes requests by role, merges
 * multi-server responses, and aggregates diagnostics.
 */

import type { MangoLspConfig } from "@mango-lsp/config";
import { createLogger, type Logger } from "@mango-lsp/logger";
import { createLspClient, type LspClient, type LspClientOptions } from "@mango-lsp/lsp-client";
import {
  ErrorCodes,
  errorResponse,
  isErrorResponse,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  notification,
  request,
  successResponse,
} from "@mango-lsp/protocol";
import {
  errorMessage,
  MANGO_LSP_BINARY,
  MANGO_LSP_EXECUTE_COMMAND,
  MANGO_LSP_VERSION,
  ROLES,
  type Role,
  type RouteStrategy,
  roleForMethod,
  type ServerId,
} from "@mango-lsp/shared";

type JsonObject = Record<string, unknown>;
type ClientFactory = (options: LspClientOptions) => LspClient;

const MANGO_METADATA_KEY = "__mangoLsp";

interface MangoActionMetadata {
  serverId: ServerId;
  originalData?: unknown;
}

interface MangoCommandMetadata {
  serverId: ServerId;
  command: string;
}

export interface ProxyOptions {
  config: MangoLspConfig;
  rootDir?: string;
  logger?: Logger;
  clientFactory?: ClientFactory;
}

export interface RoutePlan {
  role: Role;
  strategy: RouteStrategy;
  servers: readonly ServerId[];
}

export interface MangoProxy {
  readonly clients: ReadonlyMap<ServerId, LspClient>;
  start(): Promise<void>;
  stop(): Promise<void>;
  planFor(role: Role): RoutePlan | undefined;
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  handleNotification(note: JsonRpcNotification): Promise<void>;
  onNotification(listener: (note: JsonRpcNotification) => void): () => void;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasUsableResult(response: JsonRpcResponse): response is JsonRpcSuccess {
  return !isErrorResponse(response) && response.result !== null && response.result !== undefined;
}

function firstError(id: JsonRpcRequest["id"], responses: readonly JsonRpcResponse[]): JsonRpcError {
  const found = responses.find(isErrorResponse);
  return found ?? errorResponse(id, ErrorCodes.InternalError, "no child LSP returned a result");
}

function readMangoMetadata(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = value[MANGO_METADATA_KEY];
  return isRecord(metadata) ? metadata : undefined;
}

function actionMetadata(data: unknown): MangoActionMetadata | undefined {
  const metadata = readMangoMetadata(data);
  if (metadata === undefined) return undefined;
  const serverId = metadata.serverId;
  if (typeof serverId !== "string") return undefined;
  return {
    serverId,
    ...(Object.hasOwn(metadata, "originalData") ? { originalData: metadata.originalData } : {}),
  };
}

function commandMetadata(value: unknown): MangoCommandMetadata | undefined {
  const metadata = readMangoMetadata(value);
  if (metadata === undefined) return undefined;
  const serverId = metadata.serverId;
  const command = metadata.command;
  if (typeof serverId !== "string" || typeof command !== "string") return undefined;
  return { serverId, command };
}

function cloneObject(value: JsonObject): JsonObject {
  return { ...value };
}

function tagCommand(serverId: ServerId, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const command = value.command;
  if (typeof command !== "string") return value;
  const originalArguments = Array.isArray(value.arguments) ? value.arguments : [];
  return {
    ...value,
    command: MANGO_LSP_EXECUTE_COMMAND,
    arguments: [
      { [MANGO_METADATA_KEY]: { serverId, command } satisfies MangoCommandMetadata },
      ...originalArguments,
    ],
  };
}

function restoreCommand(value: unknown): unknown {
  if (!isRecord(value) || value.command !== MANGO_LSP_EXECUTE_COMMAND) return value;
  const args = Array.isArray(value.arguments) ? value.arguments : [];
  const metadata = commandMetadata(args[0]);
  if (metadata === undefined) return value;
  return {
    ...value,
    command: metadata.command,
    arguments: args.slice(1),
  };
}

function tagCodeAction(serverId: ServerId, value: unknown): unknown {
  if (!isRecord(value)) return value;

  // A bare Command (string `command`) routes back via workspace/executeCommand.
  if (typeof value.command === "string") return tagCommand(serverId, value);

  // A CodeAction routes back via codeAction/resolve using tagged `data`; its
  // nested Command, if present, routes via workspace/executeCommand.
  const action = cloneObject(value);
  action.data = {
    [MANGO_METADATA_KEY]: {
      serverId,
      ...(Object.hasOwn(action, "data") ? { originalData: action.data } : {}),
    } satisfies MangoActionMetadata,
  };
  if (isRecord(action.command)) action.command = tagCommand(serverId, action.command);
  return action;
}

function restoreCodeAction(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const action = cloneObject(value);
  const metadata = actionMetadata(action.data);
  if (metadata !== undefined) {
    if (Object.hasOwn(metadata, "originalData")) {
      action.data = metadata.originalData;
    } else {
      delete action.data;
    }
  }
  if (Object.hasOwn(action, "command")) action.command = restoreCommand(action.command);
  return action;
}

function initializeResult(config: MangoLspConfig): JsonObject {
  const hasRoute = (role: Role): boolean => config.routes[role] !== undefined;
  const capabilities: JsonObject = {
    textDocumentSync: 1,
  };

  if (hasRoute("hover")) capabilities.hoverProvider = true;
  if (hasRoute("navigation")) {
    capabilities.definitionProvider = true;
    capabilities.declarationProvider = true;
    capabilities.implementationProvider = true;
    capabilities.typeDefinitionProvider = true;
  }
  if (hasRoute("references")) capabilities.referencesProvider = true;
  if (hasRoute("symbols")) {
    capabilities.documentSymbolProvider = true;
    capabilities.workspaceSymbolProvider = true;
  }
  if (hasRoute("diagnostics")) {
    capabilities.diagnosticProvider = {
      interFileDependencies: true,
      workspaceDiagnostics: true,
    };
  }
  if (hasRoute("codeActions")) {
    capabilities.codeActionProvider = { resolveProvider: true };
    capabilities.executeCommandProvider = { commands: [MANGO_LSP_EXECUTE_COMMAND] };
  }
  if (hasRoute("formatting")) {
    capabilities.documentFormattingProvider = true;
    capabilities.documentRangeFormattingProvider = true;
  }

  return {
    capabilities,
    serverInfo: { name: MANGO_LSP_BINARY, version: MANGO_LSP_VERSION },
  };
}

class RuntimeMangoProxy implements MangoProxy {
  readonly clients = new Map<ServerId, LspClient>();
  readonly #config: MangoLspConfig;
  readonly #logger: Logger;
  readonly #clientFactory: ClientFactory;
  readonly #notificationListeners = new Set<(note: JsonRpcNotification) => void>();
  readonly #diagnostics = new Map<string, Map<ServerId, unknown[]>>();
  readonly #capabilities = new Map<ServerId, JsonObject>();
  #started = false;

  constructor(options: ProxyOptions) {
    this.#config = options.config;
    this.#logger = (options.logger ?? createLogger()).child("core");
    this.#clientFactory = options.clientFactory ?? createLspClient;

    for (const [id, server] of Object.entries(this.#config.servers)) {
      const cwd = server.cwd ?? options.rootDir;
      this.clients.set(
        id,
        this.#clientFactory({
          id,
          command: server.command,
          args: server.args,
          timeout: this.#config.defaults.timeout,
          ...(server.env !== undefined ? { env: server.env } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          childRequestHandler: async (req) => await this.#handleChildRequest(id, req),
          logger: this.#logger.child(`client:${id}`),
        }),
      );
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const started: LspClient[] = [];
    try {
      for (const [serverId, client] of this.clients) {
        client.onNotification((message) => this.#handleChildNotification(serverId, message));
        await client.start();
        started.push(client);
      }
      this.#started = true;
      this.#logger.info("proxy started", { servers: [...this.clients.keys()] });
    } catch (error) {
      await Promise.allSettled(started.map((client) => client.stop()));
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((client) => client.stop()));
    this.#started = false;
    await this.#logger.flush?.();
  }

  planFor(role: Role): RoutePlan | undefined {
    const route = this.#config.routes[role];
    if (route === undefined) return undefined;
    const servers = route.servers.filter((serverId) => this.clients.has(serverId));
    if (servers.length === 0) return undefined;
    return { role, strategy: route.strategy, servers };
  }

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (req.method === "initialize") return await this.#initialize(req);
    if (req.method === "shutdown") return await this.#shutdown(req);
    if (req.method === "codeAction/resolve") return await this.#resolveCodeAction(req);
    if (req.method === "workspace/executeCommand") return await this.#executeCommand(req);

    const role = roleForMethod(req.method);
    if (role === undefined) {
      return errorResponse(
        req.id,
        ErrorCodes.MethodNotFound,
        `method is not routed: ${req.method}`,
      );
    }

    const plan = this.planFor(role);
    if (plan === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, `no route configured for ${role}`);
    }

    return await this.#routeRequest(plan, req);
  }

  async handleNotification(note: JsonRpcNotification): Promise<void> {
    if (note.method === "exit") {
      await this.stop();
      return;
    }

    for (const client of this.clients.values()) {
      try {
        client.notify(note);
      } catch (error) {
        this.#logger.warn("failed to forward notification to child", {
          method: note.method,
          error: errorMessage(error),
        });
      }
    }
  }

  onNotification(listener: (note: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  async #initialize(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const childRequest = request(req.id, "initialize", req.params);
    const results = await Promise.allSettled(
      [...this.clients.entries()].map(async ([serverId, client]) => {
        const response = await client.request(childRequest);
        if (!isErrorResponse(response) && isRecord(response.result)) {
          const capabilities = response.result.capabilities;
          if (isRecord(capabilities)) this.#capabilities.set(serverId, capabilities);
        } else if (isErrorResponse(response)) {
          this.#logger.warn("child initialize failed", {
            serverId,
            message: response.error.message,
          });
        }
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        this.#logger.warn("child initialize rejected", {
          error: errorMessage(result.reason),
        });
      }
    }

    return successResponse(req.id, initializeResult(this.#config));
  }

  async #shutdown(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.request(request(req.id, "shutdown"))),
    );
    return successResponse(req.id, null);
  }

  async #resolveCodeAction(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const metadata = actionMetadata(isRecord(req.params) ? req.params.data : undefined);
    const plan = this.planFor("codeActions");
    const serverId = metadata?.serverId ?? plan?.servers[0];
    if (serverId === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, "no code action route configured");
    }
    const client = this.clients.get(serverId);
    if (client === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, `unknown server: ${serverId}`);
    }

    const restored = restoreCodeAction(req.params);
    const response = await client.request({ ...req, params: restored });
    if (isErrorResponse(response)) return response;
    return successResponse(req.id, tagCodeAction(serverId, response.result));
  }

  async #executeCommand(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = isRecord(req.params) ? req.params : {};
    const command = typeof params.command === "string" ? params.command : undefined;
    const args = Array.isArray(params.arguments) ? params.arguments : [];
    const metadata = command === MANGO_LSP_EXECUTE_COMMAND ? commandMetadata(args[0]) : undefined;

    const forwardedParams: JsonObject =
      metadata !== undefined
        ? { ...params, command: metadata.command, arguments: args.slice(1) }
        : params;

    const serverId =
      metadata?.serverId ??
      (command !== undefined ? this.#serverForCommand(command) : undefined) ??
      this.planFor("codeActions")?.servers[0];
    if (serverId === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, "no executeCommand route configured");
    }

    const client = this.clients.get(serverId);
    if (client === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, `unknown server: ${serverId}`);
    }

    return await client.request({ ...req, params: forwardedParams });
  }

  async #routeRequest(plan: RoutePlan, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (plan.strategy) {
      case "preferred":
      case "firstSuccessful":
        return await this.#firstSuccessful(plan, req);
      case "merge":
        return await this.#merge(plan, req);
      case "aggregate":
        return await this.#aggregate(plan, req);
    }
  }

  async #firstSuccessful(plan: RoutePlan, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const responses: JsonRpcResponse[] = [];
    for (const serverId of plan.servers) {
      const response = await this.#requestServer(serverId, req);
      responses.push(response);
      if (hasUsableResult(response)) {
        if (req.method === "textDocument/codeAction") {
          return successResponse(
            req.id,
            asArray(response.result).map((item) => tagCodeAction(serverId, item)),
          );
        }
        return response;
      }
    }
    return firstError(req.id, responses);
  }

  async #merge(plan: RoutePlan, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const responses = await Promise.all(
      plan.servers.map((serverId) => this.#requestServer(serverId, req)),
    );
    const merged: unknown[] = [];

    for (const [index, response] of responses.entries()) {
      const serverId = plan.servers[index];
      if (serverId === undefined || isErrorResponse(response) || response.result === null) continue;
      if (req.method === "textDocument/codeAction") {
        merged.push(...asArray(response.result).map((item) => tagCodeAction(serverId, item)));
      } else {
        merged.push(...asArray(response.result));
      }
    }

    return successResponse(req.id, merged);
  }

  async #aggregate(plan: RoutePlan, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const responses = await Promise.all(
      plan.servers.map((serverId) => this.#requestServer(serverId, req)),
    );
    const values = responses
      .filter((response): response is JsonRpcSuccess => !isErrorResponse(response))
      .map((response) => response.result)
      .filter((result) => result !== null && result !== undefined);

    if (values.length === 0) return firstError(req.id, responses);
    if (values.every(Array.isArray)) {
      return successResponse(
        req.id,
        values.flatMap((value) => value as unknown[]),
      );
    }
    return successResponse(req.id, values);
  }

  async #requestServer(serverId: ServerId, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const client = this.clients.get(serverId);
    if (client === undefined) {
      return errorResponse(req.id, ErrorCodes.MethodNotFound, `unknown server: ${serverId}`);
    }
    try {
      return await client.request(req);
    } catch (error) {
      return errorResponse(req.id, ErrorCodes.InternalError, errorMessage(error));
    }
  }

  #serverForCommand(command: string): ServerId | undefined {
    for (const [serverId, capabilities] of this.#capabilities) {
      const provider = capabilities.executeCommandProvider;
      if (!isRecord(provider)) continue;
      const commands = provider.commands;
      if (Array.isArray(commands) && commands.includes(command)) return serverId;
    }
    return undefined;
  }

  #handleChildNotification(serverId: ServerId, note: JsonRpcNotification): void {
    if (note.method === "textDocument/publishDiagnostics") {
      this.#aggregateDiagnostics(serverId, note);
      return;
    }
    this.#emit(note);
  }

  #aggregateDiagnostics(serverId: ServerId, note: JsonRpcNotification): void {
    const params = isRecord(note.params) ? note.params : undefined;
    const uri = typeof params?.uri === "string" ? params.uri : undefined;
    if (uri === undefined) {
      this.#emit(note);
      return;
    }

    const diagnostics = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
    let byServer = this.#diagnostics.get(uri);
    if (byServer === undefined) {
      byServer = new Map();
      this.#diagnostics.set(uri, byServer);
    }
    byServer.set(serverId, diagnostics);

    const plan = this.planFor("diagnostics");
    const serverOrder = plan?.servers ?? [...this.clients.keys()];
    const merged = serverOrder.flatMap((id) => {
      const items = byServer.get(id) ?? [];
      return items.map((item) => {
        if (!isRecord(item) || item.source !== undefined) return item;
        return { ...item, source: id };
      });
    });

    this.#emit(
      notification("textDocument/publishDiagnostics", {
        ...params,
        uri,
        diagnostics: merged,
      }),
    );
  }

  #emit(note: JsonRpcNotification): void {
    for (const listener of this.#notificationListeners) listener(note);
  }

  async #handleChildRequest(serverId: ServerId, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "workspace/configuration": {
        const params = isRecord(req.params) ? req.params : {};
        const items = Array.isArray(params.items) ? params.items : [];
        return successResponse(
          req.id,
          items.map(() => null),
        );
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return successResponse(req.id, null);
      default:
        this.#logger.debug("unsupported child-to-client request", {
          serverId,
          method: req.method,
        });
        return errorResponse(
          req.id,
          ErrorCodes.MethodNotFound,
          `child-to-client request is not supported: ${req.method}`,
        );
    }
  }
}

export function createProxy(options: ProxyOptions): MangoProxy {
  return new RuntimeMangoProxy(options);
}

export function routedRoles(config: MangoLspConfig): Role[] {
  return ROLES.filter((role) => config.routes[role] !== undefined);
}
