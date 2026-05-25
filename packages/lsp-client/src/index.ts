/**
 * @mango-lsp/lsp-client
 *
 * One stdio JSON-RPC client per child LSP server.
 */

import type { Logger } from "@mango-lsp/logger";
import {
  ErrorCodes,
  encodeMessage,
  errorResponse,
  isNotification,
  isResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MessageBuffer,
} from "@mango-lsp/protocol";
import {
  asError,
  errorMessage,
  resolveCommandPath,
  type ServerId,
  withNodeModulesBinPath,
} from "@mango-lsp/shared";
import type { FileSink } from "bun";

export interface LspClientOptions {
  id: ServerId;
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  logger?: Logger;
  childRequestHandler?:
    | ((request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>)
    | ((request: JsonRpcRequest) => JsonRpcResponse | undefined);
}

export interface LspClient {
  readonly id: ServerId;
  start(): Promise<void>;
  stop(): Promise<void>;
  request<R = unknown>(req: JsonRpcRequest): Promise<JsonRpcResponse<R>>;
  notify(note: JsonRpcNotification): void;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
}

interface PendingRequest {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function idKey(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

function environment(
  overrides: Record<string, string> | undefined,
  cwd: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return withNodeModulesBinPath(env, { cwd });
}

class ProcessLspClient implements LspClient {
  readonly id: ServerId;
  readonly #options: LspClientOptions;
  readonly #logger: Logger | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  readonly #childRequestHandler;
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  #stdin: FileSink | undefined;
  #started = false;

  constructor(options: LspClientOptions) {
    this.id = options.id;
    this.#options = options;
    this.#logger = options.logger;
    this.#childRequestHandler = options.childRequestHandler;
  }

  async start(): Promise<void> {
    if (this.#started) return;

    const resolvedCommand = await resolveCommandPath(this.#options.command, {
      cwd: this.#options.cwd,
    });
    if (resolvedCommand === null) {
      throw new Error(`child LSP ${this.id} command not found: ${this.#options.command}`);
    }

    this.#logger?.info("starting child LSP", {
      command: resolvedCommand,
      args: [...this.#options.args],
    });

    this.#proc = Bun.spawn([resolvedCommand, ...this.#options.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: environment(this.#options.env, this.#options.cwd),
      ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {}),
    });
    this.#stdin = this.#proc.stdin;
    this.#started = true;

    void this.#readStdout(this.#proc.stdout);
    void this.#readStderr(this.#proc.stderr);
    void this.#watchExit(this.#proc);
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    const proc = this.#proc;
    this.#started = false;
    this.#stdin = undefined;
    this.#proc = undefined;

    if (proc !== undefined && proc.exitCode === null) {
      proc.kill();
      await proc.exited.catch(() => 1);
    }

    this.#rejectAllPending(new Error(`child LSP ${this.id} stopped`));
  }

  request<R = unknown>(req: JsonRpcRequest): Promise<JsonRpcResponse<R>> {
    if (!this.#started || this.#stdin === undefined) {
      return Promise.reject(new Error(`child LSP ${this.id} is not started`));
    }

    const key = idKey(req.id);
    if (this.#pending.has(key)) {
      return Promise.reject(new Error(`duplicate pending JSON-RPC id for ${this.id}: ${key}`));
    }

    const timeout = this.#options.timeout ?? 12_000;
    const promise = new Promise<JsonRpcResponse<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(`child LSP ${this.id} request timed out: ${req.method}`));
      }, timeout);

      this.#pending.set(key, {
        timer,
        resolve: (response) => resolve(response as JsonRpcResponse<R>),
        reject,
      });
    });

    try {
      this.#write(req);
    } catch (error) {
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.reject(asError(error, "failed to write request"));
      }
      this.#pending.delete(key);
    }

    return promise;
  }

  notify(note: JsonRpcNotification): void {
    if (!this.#started || this.#stdin === undefined) {
      throw new Error(`child LSP ${this.id} is not started`);
    }
    this.#write(note);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.#stdin === undefined) {
      throw new Error(`child LSP ${this.id} stdin is unavailable`);
    }
    this.#stdin.write(encodeMessage(message));
    void this.#stdin.flush();
  }

  async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const buffer = new MessageBuffer();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const messages = buffer.push(value);
        for (const message of messages) {
          if (isResponse(message)) {
            const key = idKey(message.id);
            const pending = this.#pending.get(key);
            if (pending === undefined) {
              this.#logger?.warn("received response for unknown request id", { id: message.id });
              continue;
            }
            clearTimeout(pending.timer);
            this.#pending.delete(key);
            pending.resolve(message);
          } else if (isNotification(message)) {
            for (const listener of this.#notificationListeners) listener(message);
          } else {
            const requestMessage = message as JsonRpcRequest;
            await this.#handleChildRequest(requestMessage);
          }
        }
      }
    } catch (error) {
      this.#logger?.error("failed to read child stdout", {
        error: errorMessage(error),
      });
      this.#rejectAllPending(asError(error, "child stdout failed"));
    }
  }

  async #handleChildRequest(requestMessage: JsonRpcRequest): Promise<void> {
    const handler = this.#childRequestHandler;
    if (handler === undefined) {
      this.#logger?.debug("rejecting child-to-client request", {
        method: requestMessage.method,
      });
      this.#write(
        errorResponse(
          requestMessage.id,
          ErrorCodes.MethodNotFound,
          `child-to-client request is not supported: ${requestMessage.method}`,
        ),
      );
      return;
    }

    try {
      const response = await handler(requestMessage);
      this.#write(
        response ??
          errorResponse(
            requestMessage.id,
            ErrorCodes.MethodNotFound,
            `child-to-client request is not supported: ${requestMessage.method}`,
          ),
      );
    } catch (error) {
      this.#logger?.warn("child request handler failed", {
        method: requestMessage.method,
        error: errorMessage(error),
      });
      this.#write(
        errorResponse(
          requestMessage.id,
          ErrorCodes.InternalError,
          `child-to-client request failed: ${requestMessage.method}`,
        ),
      );
    }
  }

  async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const text = decoder.decode(value).trim();
      if (text.length > 0) this.#logger?.debug("child stderr", { text });
    }
  }

  async #watchExit(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const code = await proc.exited.catch(() => 1);
    if (this.#proc === proc) {
      this.#logger?.warn("child LSP exited", { code });
      this.#started = false;
      this.#stdin = undefined;
      this.#proc = undefined;
      this.#rejectAllPending(new Error(`child LSP ${this.id} exited with code ${code}`));
    }
  }
}

export function createLspClient(options: LspClientOptions): LspClient {
  return new ProcessLspClient(options);
}
