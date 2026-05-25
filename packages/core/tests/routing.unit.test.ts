import { describe, expect, test } from "bun:test";
import type { MangoLspConfig } from "@mango-lsp/config";
import { createProxy } from "@mango-lsp/core";
import { createMemoryLogger } from "@mango-lsp/logger";
import type { LspClient, LspClientOptions } from "@mango-lsp/lsp-client";
import {
  isErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  notification,
  request,
  successResponse,
} from "@mango-lsp/protocol";
import { MANGO_LSP_EXECUTE_COMMAND, type ServerId } from "@mango-lsp/shared";

class FakeClient implements LspClient {
  readonly id: ServerId;
  readonly requests: JsonRpcRequest[] = [];
  readonly notifications: JsonRpcNotification[] = [];
  readonly #responses: Record<string, unknown>;
  readonly #listeners = new Set<(notification: JsonRpcNotification) => void>();

  constructor(id: ServerId, responses: Record<string, unknown>) {
    this.id = id;
    this.#responses = responses;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async request<R = unknown>(req: JsonRpcRequest): Promise<JsonRpcResponse<R>> {
    this.requests.push(req);
    return successResponse(req.id, this.#responses[req.method] ?? null) as JsonRpcResponse<R>;
  }

  notify(note: JsonRpcNotification): void {
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

describe("@mango-lsp/core routing", () => {
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
    const proxy = createProxy({
      config: config(),
      logger: createMemoryLogger({ level: "error" }),
      clientFactory: (options) => clients.get(options.id) ?? new FakeClient(options.id, {}),
    });

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

  test("aggregates diagnostics in configured server order", async () => {
    const alpha = new FakeClient("alpha", {});
    const beta = new FakeClient("beta", {});
    const proxy = createProxy({
      config: config(),
      logger: createMemoryLogger({ level: "error" }),
      clientFactory: (options) => (options.id === "alpha" ? alpha : beta),
    });
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

    await proxy.stop();
  });
});
