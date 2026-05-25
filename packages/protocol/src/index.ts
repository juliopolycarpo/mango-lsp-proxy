/**
 * @mango-lsp/protocol
 *
 * JSON-RPC 2.0 and LSP Content-Length framing helpers.
 */

import { z } from "zod";

export type ByteBuffer = Uint8Array<ArrayBufferLike>;

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC and LSP error codes (subset). */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
} as const;

const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const JsonRpcBaseSchema = z.object({ jsonrpc: z.literal("2.0") }).passthrough();

export const JsonRpcRequestSchema = JsonRpcBaseSchema.extend({
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).refine((value) => !("result" in value) && !("error" in value), {
  message: "request cannot include result or error",
});

export const JsonRpcNotificationSchema = JsonRpcBaseSchema.extend({
  method: z.string().min(1),
  params: z.unknown().optional(),
}).refine((value) => !("id" in value) && !("result" in value) && !("error" in value), {
  message: "notification cannot include id, result, or error",
});

export const JsonRpcSuccessSchema = JsonRpcBaseSchema.extend({
  id: JsonRpcIdSchema,
  result: z.unknown(),
}).refine((value) => !("method" in value) && !("error" in value), {
  message: "success response cannot include method or error",
});

export const JsonRpcErrorSchema = JsonRpcBaseSchema.extend({
  id: JsonRpcIdSchema,
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .passthrough(),
}).refine((value) => !("method" in value) && !("result" in value), {
  message: "error response cannot include method or result",
});

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorSchema,
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ProtocolError extends Error {
  readonly code: number;

  constructor(message: string, code: number = ErrorCodes.InvalidRequest) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const result = JsonRpcMessageSchema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data as JsonRpcMessage;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message);
}

export function isErrorResponse(response: JsonRpcResponse): response is JsonRpcError {
  return "error" in response;
}

export function successResponse<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error = { code, message, ...(data !== undefined ? { data } : {}) };
  return { jsonrpc: "2.0", id, error };
}

export function notification<P>(method: string, params?: P): JsonRpcNotification<P> {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

export function request<P>(id: JsonRpcId, method: string, params?: P): JsonRpcRequest<P> {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

/** Encode a JSON-RPC message into the LSP `Content-Length` framed wire form. */
export function encodeMessage(message: JsonRpcMessage): ByteBuffer {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const framed = new Uint8Array(header.byteLength + body.byteLength);
  framed.set(header, 0);
  framed.set(body, header.byteLength);
  return framed;
}

function concatBytes(left: ByteBuffer, right: ByteBuffer): ByteBuffer {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function copyBytes(bytes: ByteBuffer): ByteBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function findHeaderEnd(bytes: ByteBuffer): number {
  for (let index = 0; index <= bytes.byteLength - 4; index++) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function parseContentLength(header: string): number {
  const lines = header.split("\r\n");
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== "content-length") continue;
    const rawValue = line.slice(separator + 1).trim();
    const length = Number(rawValue);
    if (!Number.isInteger(length) || length < 0) {
      throw new ProtocolError(`invalid Content-Length header: ${rawValue}`);
    }
    return length;
  }
  throw new ProtocolError("missing Content-Length header");
}

/**
 * Decode as many Content-Length framed JSON-RPC messages as possible.
 *
 * Pass the previous `remainder` concatenated with the next stream chunk. The
 * returned remainder must be retained for the next decode call.
 */
export function decodeMessages(chunk: ByteBuffer): {
  messages: JsonRpcMessage[];
  remainder: ByteBuffer;
} {
  const messages: JsonRpcMessage[] = [];
  let offset = 0;

  while (offset < chunk.byteLength) {
    const view = chunk.subarray(offset);
    const headerEnd = findHeaderEnd(view);
    if (headerEnd === -1) break;

    const header = decoder.decode(view.subarray(0, headerEnd));
    const contentLength = parseContentLength(header);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (view.byteLength < bodyEnd) break;

    const body = decoder.decode(view.subarray(bodyStart, bodyEnd));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new ProtocolError(message, ErrorCodes.ParseError);
    }
    messages.push(parseJsonRpcMessage(parsed));
    offset += bodyEnd;
  }

  return { messages, remainder: copyBytes(chunk.subarray(offset)) };
}

export class MessageBuffer {
  #remainder: ByteBuffer = new Uint8Array();

  push(chunk: ByteBuffer): JsonRpcMessage[] {
    const { messages, remainder } = decodeMessages(concatBytes(this.#remainder, chunk));
    this.#remainder = remainder;
    return messages;
  }

  clear(): void {
    this.#remainder = new Uint8Array();
  }

  get remainderBytes(): number {
    return this.#remainder.byteLength;
  }
}
