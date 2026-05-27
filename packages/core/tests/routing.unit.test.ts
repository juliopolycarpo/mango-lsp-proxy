import { describe, expect, test } from "bun:test";
import type { MangoLspConfig } from "@mango-lsp/config";
import { createProxy } from "@mango-lsp/core";
import { createMemoryLogger } from "@mango-lsp/logger";
import type { LspClient, LspClientOptions } from "@mango-lsp/lsp-client";
import {
  ErrorCodes,
  errorResponse,
  isErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  notification,
  request,
  successResponse,
} from "@mango-lsp/protocol";
import { MANGO_LSP_EXECUTE_COMMAND, type ServerId } from "@mango-lsp/shared";

type FakeReply =
  | ((req: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse>)
  | Error
  | JsonRpcResponse
  | unknown;

class FakeClient implements LspClient {
  readonly id: ServerId;
  readonly requests: JsonRpcRequest[] = [];
  readonly notifications: JsonRpcNotification[] = [];
  startCount = 0;
  stopCount = 0;
  notifyError: Error | undefined;
  startError: Error | undefined;
  readonly #responses: Record<string, FakeReply>;
  readonly #listeners = new Set<(notification: JsonRpcNotification) => void>();

  constructor(id: ServerId, responses: Record<string, FakeReply>) {
    this.id = id;
    this.#responses = responses;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startError !== undefined) throw this.startError;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  async request<R = unknown>(req: JsonRpcRequest): Promise<JsonRpcResponse<R>> {
    this.requests.push(req);
    const reply = this.#responses[req.method] ?? null;
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return (await reply(req)) as JsonRpcResponse<R>;
    if (isJsonRpcResponse(reply)) return reply as JsonRpcResponse<R>;
    return successResponse(req.id, reply) as JsonRpcResponse<R>;
  }

  notify(note: JsonRpcNotification): void {
    if (this.notifyError !== undefined) throw this.notifyError;
    this.notifications.push(note);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(note: JsonRpcNotification): void {
    for (const listener of this.#listeners) listener(note);
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    "id" in value &&
    ("result" in value || "error" in value)
  );
}

function config(): MangoLspConfig {
  return {
    workspace: { rootMarkers: [".git"], logDir: ".mango-lsp/logs" },
    defaults: { timeout: 500, restartOnCrash: false, maxRestarts: 0 },
    servers: {
      alpha: { command: "alpha", args: [], roles: ["codeActions", "diagnostics"], languages: [] },
      beta: { command: "beta", args: [], roles: ["codeActions", "diagnostics"], languages: [] },
    },
    routes: {
      codeActions: { strategy: "merge", servers: ["alpha", "beta"] },
      diagnostics: { strategy: "aggregate", servers: ["beta", "alpha"] },
    },
  };
}

function fullConfig(): MangoLspConfig {
  return {
    workspace: { rootMarkers: [".git"], logDir: ".mango-lsp/logs" },
    defaults: { timeout: 500, restartOnCrash: false, maxRestarts: 0 },
    servers: {
      alpha: {
        command: "alpha",
        args: ["--alpha"],
        roles: ["navigation", "hover", "references", "symbols"],
        languages: [],
        env: { ALPHA: "1" },
      },
      beta: {
        command: "beta",
        args: ["--beta"],
        roles: ["diagnostics", "codeActions", "formatting"],
        languages: [],
      },
    },
    routes: {
      navigation: { strategy: "firstSuccessful", servers: ["alpha"] },
      hover: { strategy: "preferred", servers: ["alpha"] },
      references: { strategy: "firstSuccessful", servers: ["alpha"] },
      symbols: { strategy: "merge", servers: ["alpha"] },
      diagnostics: { strategy: "aggregate", servers: ["beta"] },
      codeActions: { strategy: "merge", servers: ["beta"] },
      formatting: { strategy: "preferred", servers: ["beta"] },
    },
  };
}

function proxyForClients(cfg: MangoLspConfig, clients: ReadonlyMap<ServerId, FakeClient>) {
  return createProxy({
    config: cfg,
    rootDir: "/workspace",
    logger: createMemoryLogger({ level: "error" }),
    clientFactory: (options) => clients.get(options.id) ?? new FakeClient(options.id, {}),
  });
}

function metadata(serverId: string, originalData?: unknown): Record<string, unknown> {
  return {
    __mangoLsp: originalData === undefined ? { serverId } : { serverId, originalData },
  };
}

function commandMetadata(serverId: string, command: string): Record<string, unknown> {
  return { __mangoLsp: { serverId, command } };
}

describe("@mango-lsp/core routing", () => {
  test("initializes child clients, advertises aggregate capabilities, and routes commands", async () => {
    const alpha = new FakeClient("alpha", {
      initialize: {
        capabilities: { executeCommandProvider: { commands: ["alpha.apply"] } },
      },
    });
    const beta = new FakeClient("beta", {
      initialize: {
        capabilities: { executeCommandProvider: { commands: ["beta.apply"] } },
      },
      "workspace/executeCommand": { applied: "beta" },
    });
    const proxy = proxyForClients(
      fullConfig(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", beta],
      ]),
    );

    const initialized = await proxy.handleRequest(request(1, "initialize", {}));
    const executed = await proxy.handleRequest(
      request(2, "workspace/executeCommand", { command: "beta.apply", arguments: [1] }),
    );

    expect(initialized).toMatchObject({
      result: {
        capabilities: {
          definitionProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          diagnosticProvider: { workspaceDiagnostics: true },
          codeActionProvider: { resolveProvider: true },
          documentFormattingProvider: true,
        },
      },
    });
    expect(executed).toEqual(successResponse(2, { applied: "beta" }));
    expect(beta.requests.at(-1)?.params).toEqual({
      command: "beta.apply",
      arguments: [1],
    });
  });

  test("starts clients once and rolls back clients already started after a failure", async () => {
    const alpha = new FakeClient("alpha", {});
    const beta = new FakeClient("beta", {});
    beta.startError = new Error("beta failed");
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", beta],
      ]),
    );

    await expect(proxy.start()).rejects.toThrow("beta failed");
    expect(alpha.stopCount).toBe(1);
    expect(beta.stopCount).toBe(0);
  });

  test("merges code actions and routes executeCommand to the source server", async () => {
    const clients = new Map<ServerId, FakeClient>([
      [
        "alpha",
        new FakeClient("alpha", {
          "textDocument/codeAction": [
            {
              title: "Alpha fix",
              data: { token: "alpha" },
              command: { title: "Apply", command: "alpha.apply", arguments: [1] },
            },
          ],
          "workspace/executeCommand": { applied: "alpha" },
        }),
      ],
      [
        "beta",
        new FakeClient("beta", {
          "textDocument/codeAction": [{ title: "Beta fix", data: { token: "beta" } }],
        }),
      ],
    ]);
    const proxy = proxyForClients(config(), clients);

    const response = await proxy.handleRequest(request(1, "textDocument/codeAction", {}));
    expect(isErrorResponse(response)).toBe(false);
    if (isErrorResponse(response)) return;
    const actions = response.result as Array<Record<string, unknown>>;

    expect(actions).toHaveLength(2);
    const command = actions[0]?.command as Record<string, unknown>;
    expect(command.command).toBe(MANGO_LSP_EXECUTE_COMMAND);

    const execute = await proxy.handleRequest(
      request(2, "workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      }),
    );

    expect(execute).toEqual(successResponse(2, { applied: "alpha" }));
    expect(clients.get("alpha")?.requests.at(-1)?.params).toEqual({
      command: "alpha.apply",
      arguments: [1],
    });
  });

  test("uses first successful routing and returns the first child error when nothing is usable", async () => {
    const cfg = config();
    cfg.routes.hover = { strategy: "firstSuccessful", servers: ["alpha", "beta"] };
    const alpha = new FakeClient("alpha", {
      "textDocument/hover": (req: JsonRpcRequest) =>
        errorResponse(req.id, ErrorCodes.InternalError, "alpha failed"),
    });
    const beta = new FakeClient("beta", {
      "textDocument/hover": { contents: { kind: "plaintext", value: "beta" } },
    });
    const proxy = proxyForClients(
      cfg,
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", beta],
      ]),
    );

    const success = await proxy.handleRequest(request(1, "textDocument/hover", {}));
    expect(success).toEqual(successResponse(1, { contents: { kind: "plaintext", value: "beta" } }));

    const failed = proxyForClients(
      cfg,
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", new FakeClient("beta", { "textDocument/hover": null })],
      ]),
    );

    const response = await failed.handleRequest(request(2, "textDocument/hover", {}));
    expect(response).toEqual(errorResponse(2, ErrorCodes.InternalError, "alpha failed"));
  });

  test("aggregates arrays, scalar results, and all-empty failures", async () => {
    const cfg = config();
    const clients = new Map<ServerId, FakeClient>([
      ["alpha", new FakeClient("alpha", { "textDocument/diagnostic": [{ message: "alpha" }] })],
      ["beta", new FakeClient("beta", { "textDocument/diagnostic": [{ message: "beta" }] })],
    ]);
    const proxy = proxyForClients(cfg, clients);

    await expect(proxy.handleRequest(request(1, "textDocument/diagnostic", {}))).resolves.toEqual(
      successResponse(1, [{ message: "beta" }, { message: "alpha" }]),
    );

    const scalar = proxyForClients(
      cfg,
      new Map<ServerId, FakeClient>([
        ["alpha", new FakeClient("alpha", { "textDocument/diagnostic": { message: "alpha" } })],
        ["beta", new FakeClient("beta", { "textDocument/diagnostic": { message: "beta" } })],
      ]),
    );
    await expect(scalar.handleRequest(request(2, "textDocument/diagnostic", {}))).resolves.toEqual(
      successResponse(2, [{ message: "beta" }, { message: "alpha" }]),
    );

    const empty = proxyForClients(
      cfg,
      new Map<ServerId, FakeClient>([
        ["alpha", new FakeClient("alpha", { "textDocument/diagnostic": null })],
        ["beta", new FakeClient("beta", { "textDocument/diagnostic": undefined })],
      ]),
    );
    const response = await empty.handleRequest(request(3, "textDocument/diagnostic", {}));
    expect(response).toEqual(
      errorResponse(3, ErrorCodes.InternalError, "no child LSP returned a result"),
    );
  });

  test("resolves code actions with original data restored for the child server", async () => {
    const alpha = new FakeClient("alpha", {
      "codeAction/resolve": (req: JsonRpcRequest) =>
        successResponse(req.id, {
          title: "resolved",
          data: { child: true },
          command: { title: "Apply", command: "alpha.apply", arguments: [2] },
        }),
    });
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", new FakeClient("beta", {})],
      ]),
    );

    const response = await proxy.handleRequest(
      request(1, "codeAction/resolve", {
        title: "resolve me",
        data: metadata("alpha", { child: true }),
      }),
    );

    expect(alpha.requests.at(-1)?.params).toEqual({
      title: "resolve me",
      data: { child: true },
    });
    expect(response).toMatchObject({
      result: {
        data: { __mangoLsp: { serverId: "alpha", originalData: { child: true } } },
        command: { command: MANGO_LSP_EXECUTE_COMMAND },
      },
    });
  });

  test("reports route and metadata errors without contacting children", async () => {
    const proxy = proxyForClients(
      { ...config(), routes: {} },
      new Map<ServerId, FakeClient>([
        ["alpha", new FakeClient("alpha", {})],
        ["beta", new FakeClient("beta", {})],
      ]),
    );

    await expect(proxy.handleRequest(request(1, "custom/request", {}))).resolves.toMatchObject({
      error: { code: ErrorCodes.MethodNotFound, message: "method is not routed: custom/request" },
    });
    await expect(proxy.handleRequest(request(2, "textDocument/hover", {}))).resolves.toMatchObject({
      error: { code: ErrorCodes.MethodNotFound, message: "no route configured for hover" },
    });
    await expect(
      proxy.handleRequest(
        request(3, "workspace/executeCommand", {
          command: MANGO_LSP_EXECUTE_COMMAND,
          arguments: [commandMetadata("missing", "fixture.apply")],
        }),
      ),
    ).resolves.toMatchObject({
      error: { code: ErrorCodes.MethodNotFound, message: "unknown server: missing" },
    });
  });

  test("aggregates diagnostics in configured server order", async () => {
    const alpha = new FakeClient("alpha", {});
    const beta = new FakeClient("beta", {});
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", beta],
      ]),
    );
    const external: JsonRpcNotification[] = [];
    proxy.onNotification((note) => external.push(note));

    await proxy.start();
    alpha.emit(
      notification("textDocument/publishDiagnostics", {
        uri: "file:///x.ts",
        diagnostics: [{ message: "alpha" }],
      }),
    );
    beta.emit(
      notification("textDocument/publishDiagnostics", {
        uri: "file:///x.ts",
        diagnostics: [{ message: "beta" }],
      }),
    );

    const latest = external.at(-1);
    expect(latest?.params).toMatchObject({
      uri: "file:///x.ts",
      diagnostics: [
        { message: "beta", source: "beta" },
        { message: "alpha", source: "alpha" },
      ],
    });
  });

  test("forwards non-diagnostic notifications and ignores one child notification failure", async () => {
    const alpha = new FakeClient("alpha", {});
    const beta = new FakeClient("beta", {});
    alpha.notifyError = new Error("alpha notify failed");
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", beta],
      ]),
    );
    const external: JsonRpcNotification[] = [];
    const unsubscribe = proxy.onNotification((note) => external.push(note));

    await proxy.start();
    alpha.emit(notification("window/logMessage", { message: "child" }));
    await proxy.handleNotification(notification("textDocument/didOpen", {}));
    await proxy.handleNotification(notification("exit"));
    unsubscribe();
    alpha.emit(notification("window/logMessage", { message: "after unsubscribe" }));

    expect(external).toEqual([notification("window/logMessage", { message: "child" })]);
    expect(beta.notifications.map((item) => item.method)).toEqual(["textDocument/didOpen"]);
    expect(alpha.stopCount).toBeGreaterThanOrEqual(1);
    expect(beta.stopCount).toBeGreaterThanOrEqual(1);
  });

  test("handles common child-to-client requests locally", async () => {
    const handlers = new Map<ServerId, NonNullable<LspClientOptions["childRequestHandler"]>>();

    const proxy = createProxy({
      config: config(),
      logger: createMemoryLogger({ level: "error" }),
      clientFactory: (options) => {
        if (options.childRequestHandler !== undefined) {
          handlers.set(options.id, options.childRequestHandler);
        }
        return new FakeClient(options.id, {});
      },
    });

    await proxy.start();
    const handler = handlers.get("alpha");
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    await expect(
      handler(
        request(10, "workspace/configuration", {
          items: [{ section: "alpha" }, { section: "beta" }],
        }),
      ),
    ).resolves.toEqual(successResponse(10, [null, null]));
    await expect(handler(request(11, "client/registerCapability", {}))).resolves.toEqual(
      successResponse(11, null),
    );
    await expect(handler(request(12, "client/unregisterCapability", {}))).resolves.toEqual(
      successResponse(12, null),
    );
    await expect(handler(request(13, "window/workDoneProgress/create", {}))).resolves.toEqual(
      successResponse(13, null),
    );
    await expect(handler(request(14, "unsupported/request", {}))).resolves.toEqual(
      errorResponse(
        14,
        ErrorCodes.MethodNotFound,
        "child-to-client request is not supported: unsupported/request",
      ),
    );

    await proxy.stop();
  });

  test("restores mango-tagged command from codeAction/resolve with nested command", async () => {
    const alpha = new FakeClient("alpha", {
      "codeAction/resolve": (req: JsonRpcRequest) =>
        successResponse(req.id, {
          title: "resolved",
          command: {
            title: "Apply",
            command: "alpha.apply",
            arguments: [2],
          },
        }),
    });
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", new FakeClient("beta", {})],
      ]),
    );

    const response = await proxy.handleRequest(
      request(1, "codeAction/resolve", {
        title: "resolve me",
        data: metadata("alpha"),
        command: {
          title: "Apply",
          command: MANGO_LSP_EXECUTE_COMMAND,
          arguments: [commandMetadata("alpha", "alpha.apply"), 1],
        },
      }),
    );

    expect(alpha.requests.at(-1)?.params).toMatchObject({
      command: { command: "alpha.apply", arguments: [1] },
    });
    expect(response).toMatchObject({
      result: {
        command: { command: MANGO_LSP_EXECUTE_COMMAND },
      },
    });
  });

  test("restoreCommand does not modify non-mango commands", async () => {
    const alpha = new FakeClient("alpha", {
      "codeAction/resolve": (req: JsonRpcRequest) => successResponse(req.id, { title: "resolved" }),
    });
    const proxy = proxyForClients(
      config(),
      new Map<ServerId, FakeClient>([
        ["alpha", alpha],
        ["beta", new FakeClient("beta", {})],
      ]),
    );

    await proxy.handleRequest(
      request(1, "codeAction/resolve", {
        title: "resolve me",
        data: metadata("alpha"),
        command: {
          title: "Apply",
          command: "some.other.command",
          arguments: ["no-mango-key"],
        },
      }),
    );

    expect(alpha.requests.at(-1)?.params).toMatchObject({
      command: { command: "some.other.command", arguments: ["no-mango-key"] },
    });
  });
});
