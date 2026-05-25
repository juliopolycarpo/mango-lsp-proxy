import { describe, expect, test } from "bun:test";
import type { MangoProxy, RoutePlan } from "@mango-lsp/core";
import type { LspClient } from "@mango-lsp/lsp-client";
import { createLspServerAdapter, type LspTransport } from "@mango-lsp/lsp-server";
import {
  type ByteBuffer,
  type JsonRpcNotification,
  type JsonRpcRequest,
  notification,
  request,
  successResponse,
} from "@mango-lsp/protocol";
import type { Role, ServerId } from "@mango-lsp/shared";

class FakeProxy implements MangoProxy {
  readonly clients = new Map<ServerId, LspClient>();
  readonly notifications: JsonRpcNotification[] = [];
  readonly requests: JsonRpcRequest[] = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  planFor(_role: Role): RoutePlan | undefined {
    return undefined;
  }

  async handleRequest(req: JsonRpcRequest) {
    this.requests.push(req);
    return successResponse(req.id, { ok: true });
  }

  async handleNotification(note: JsonRpcNotification): Promise<void> {
    this.notifications.push(note);
  }

  onNotification(_listener: (notification: JsonRpcNotification) => void): () => void {
    return () => {};
  }
}

function transport(): LspTransport {
  return {
    input: new ReadableStream<ByteBuffer>(),
    write(): void {},
  };
}

describe("@mango-lsp/lsp-server", () => {
  test("delegates requests and notifications to core", async () => {
    const proxy = new FakeProxy();
    const adapter = createLspServerAdapter({
      proxy,
      transport: transport(),
      startProxy: false,
    });

    await expect(adapter.handleMessage(request(1, "initialize", {}))).resolves.toEqual(
      successResponse(1, { ok: true }),
    );
    await expect(adapter.handleMessage(notification("initialized", {}))).resolves.toBeUndefined();

    expect(proxy.requests.map((item) => item.method)).toEqual(["initialize"]);
    expect(proxy.notifications.map((item) => item.method)).toEqual(["initialized"]);
  });
});
