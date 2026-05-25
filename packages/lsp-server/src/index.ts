/**
 * @mango-lsp/lsp-server
 *
 * External LSP adapter. It speaks Content-Length framed JSON-RPC to the
 * editor/agent and delegates all behavior to @mango-lsp/core.
 */

import type { MangoProxy } from "@mango-lsp/core";
import {
  type ByteBuffer,
  ErrorCodes,
  encodeMessage,
  errorResponse,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcResponse,
  MessageBuffer,
} from "@mango-lsp/protocol";
import { errorMessage } from "@mango-lsp/shared";

export interface LspTransport {
  input: ReadableStream<ByteBuffer>;
  write(chunk: ByteBuffer): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface LspServerAdapterOptions {
  proxy: MangoProxy;
  transport: "stdio" | LspTransport;
  startProxy?: boolean;
}

export interface LspServerAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined>;
}

class RuntimeLspServerAdapter implements LspServerAdapter {
  readonly #proxy: MangoProxy;
  readonly #transport: LspTransport;
  readonly #startProxy: boolean;
  #unsubscribe: (() => void) | undefined;
  #stopped = false;

  constructor(options: LspServerAdapterOptions) {
    this.#proxy = options.proxy;
    this.#transport = options.transport === "stdio" ? createStdioTransport() : options.transport;
    this.#startProxy = options.startProxy ?? true;
  }

  async start(): Promise<void> {
    if (this.#startProxy) await this.#proxy.start();
    this.#unsubscribe = this.#proxy.onNotification(async (notification) => {
      await this.#write(notification);
    });

    const reader = this.#transport.input.getReader();
    const buffer = new MessageBuffer();

    try {
      while (!this.#stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;

        const messages = buffer.push(value);
        for (const message of messages) {
          const response = await this.handleMessage(message);
          if (response !== undefined) await this.#write(response);
        }
      }
    } catch (error) {
      await this.#write(errorResponse(null, ErrorCodes.ParseError, errorMessage(error)));
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#startProxy) await this.#proxy.stop();
    await this.#transport.close?.();
  }

  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    if (isRequest(message)) return await this.#proxy.handleRequest(message);
    if (isNotification(message)) {
      await this.#proxy.handleNotification(message);
      return undefined;
    }
    if (isResponse(message)) return undefined;
    return errorResponse(null, ErrorCodes.InvalidRequest, "unknown JSON-RPC message");
  }

  async #write(message: JsonRpcMessage): Promise<void> {
    await this.#transport.write(encodeMessage(message));
  }
}

export function createStdioTransport(): LspTransport {
  const writer = Bun.stdout.writer();
  return {
    input: Bun.stdin.stream(),
    async write(chunk: ByteBuffer): Promise<void> {
      writer.write(chunk);
      await writer.flush();
    },
    async close(): Promise<void> {
      await writer.flush();
    },
  };
}

export function createLspServerAdapter(options: LspServerAdapterOptions): LspServerAdapter {
  return new RuntimeLspServerAdapter(options);
}
