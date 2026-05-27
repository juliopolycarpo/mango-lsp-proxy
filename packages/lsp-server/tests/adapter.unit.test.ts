import { describe, expect, test } from "bun:test";
import type { MangoProxy, RoutePlan } from "@mango-lsp/core";
import type { LspClient } from "@mango-lsp/lsp-client";
import { createLspServerAdapter, type LspTransport } from "@mango-lsp/lsp-server";
import {
  type ByteBuffer,
  ErrorCodes,
  encodeMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MessageBuffer,
  notification,
  request,
  successResponse,
} from "@mango-lsp/protocol";
import type { Role, ServerId } from "@mango-lsp/shared";

class FakeProxy implements MangoProxy {
  readonly clients = new Map<ServerId, LspClient>();
  readonly notifications: JsonRpcNotification[] = [];
  readonly requests: JsonRpcRequest[] = [];
  startCount = 0;
  stopCount = 0;
  unsubscribeCount = 0;
  #listeners = new Set<(notification: JsonRpcNotification) => void>();

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

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

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.unsubscribeCount += 1;
      this.#listeners.delete(listener);
    };
  }

  emit(note: JsonRpcNotification): void {
    for (const listener of this.#listeners) listener(note);
  }

  listenerCount(): number {
    return this.#listeners.size;
  }
}

class FakeTransport implements LspTransport {
  readonly writes: ByteBuffer[] = [];
  closeCount = 0;
  #controller: ReadableStreamDefaultController<ByteBuffer> | undefined;

  readonly input = new ReadableStream<ByteBuffer>({
    start: (controller) => {
      this.#controller = controller;
    },
  });

  send(chunk: ByteBuffer): void {
    this.#controller?.enqueue(chunk);
  }

  closeInput(): void {
    this.#controller?.close();
  }

  write(chunk: ByteBuffer): void {
    this.writes.push(chunk);
  }

  close(): void {
    this.closeCount += 1;
  }
}

function transport(): LspTransport {
  return new FakeTransport();
}

function writtenMessages(transport: FakeTransport): unknown[] {
  const buffer = new MessageBuffer();
  return transport.writes.flatMap((chunk) => buffer.push(chunk));
}

async function waitForListener(proxy: FakeProxy): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (proxy.listenerCount() > 0) return;
    await Bun.sleep(1);
  }
  throw new Error("adapter did not subscribe to proxy notifications");
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

  test("start reads framed messages, writes responses, and stops cleanly", async () => {
    const proxy = new FakeProxy();
    const fakeTransport = new FakeTransport();
    const adapter = createLspServerAdapter({ proxy, transport: fakeTransport });

    fakeTransport.send(encodeMessage(request(1, "initialize", {})));
    fakeTransport.send(encodeMessage(notification("initialized", {})));
    fakeTransport.closeInput();
    await adapter.start();

    expect(writtenMessages(fakeTransport)).toEqual([successResponse(1, { ok: true })]);
    expect(proxy.requests.map((item) => item.method)).toEqual(["initialize"]);
    expect(proxy.notifications.map((item) => item.method)).toEqual(["initialized"]);
    expect(proxy.startCount).toBe(1);
    expect(proxy.stopCount).toBe(1);
    expect(proxy.unsubscribeCount).toBe(1);
    expect(fakeTransport.closeCount).toBe(1);
  });

  test("start forwards proxy notifications to the transport", async () => {
    const proxy = new FakeProxy();
    const fakeTransport = new FakeTransport();
    const adapter = createLspServerAdapter({ proxy, transport: fakeTransport });
    const running = adapter.start();

    await waitForListener(proxy);
    proxy.emit(notification("window/logMessage", { message: "hello" }));
    fakeTransport.closeInput();
    await running;

    expect(writtenMessages(fakeTransport)).toEqual([
      notification("window/logMessage", { message: "hello" }),
    ]);
  });

  test("start writes parse errors for invalid framed input", async () => {
    const proxy = new FakeProxy();
    const fakeTransport = new FakeTransport();
    const adapter = createLspServerAdapter({ proxy, transport: fakeTransport });

    fakeTransport.send(new TextEncoder().encode("Content-Length: 1\r\n\r\n{"));
    await adapter.start();
    const [response] = writtenMessages(fakeTransport) as JsonRpcResponse[];

    expect(response?.id).toBeNull();
    expect(response && "error" in response ? response.error.code : undefined).toBe(
      ErrorCodes.ParseError,
    );
  });

  test("ignores child responses and rejects invalid messages", async () => {
    const proxy = new FakeProxy();
    const adapter = createLspServerAdapter({
      proxy,
      transport: transport(),
      startProxy: false,
    });

    await expect(adapter.handleMessage(successResponse(1, null))).resolves.toBeUndefined();
    const response = await adapter.handleMessage({ jsonrpc: "2.0" } as never);

    expect(response?.id).toBeNull();
    expect(response && "error" in response ? response.error.code : undefined).toBe(
      ErrorCodes.InvalidRequest,
    );
  });
});
