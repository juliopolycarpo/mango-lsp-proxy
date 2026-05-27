import { describe, expect, test } from "bun:test";
import {
  decodeMessages,
  ErrorCodes,
  encodeMessage,
  errorResponse,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  MessageBuffer,
  notification,
  ProtocolError,
  parseJsonRpcMessage,
  request,
  successResponse,
} from "@mango-lsp/protocol";

describe("@mango-lsp/protocol framing", () => {
  test("encodes and decodes a framed request", () => {
    const original = request(1, "initialize", { capabilities: {} });
    const { messages, remainder } = decodeMessages(encodeMessage(original));

    expect(remainder.byteLength).toBe(0);
    expect(messages).toEqual([original]);
  });

  test("buffers partial frames until a whole message is available", () => {
    const buffer = new MessageBuffer();
    const frame = encodeMessage(request("abc", "textDocument/hover", { uri: "file:///a.ts" }));
    const splitAt = 10;

    expect(buffer.push(frame.subarray(0, splitAt))).toEqual([]);
    expect(buffer.remainderBytes).toBe(splitAt);
    expect(buffer.push(frame.subarray(splitAt))).toHaveLength(1);
    expect(buffer.remainderBytes).toBe(0);
  });

  test("rejects frames without Content-Length", () => {
    expect(() => decodeMessages(new TextEncoder().encode("Header: 1\r\n\r\n{}"))).toThrow(
      ProtocolError,
    );
  });

  test("rejects invalid JSON and invalid Content-Length values", () => {
    expect(() =>
      decodeMessages(new TextEncoder().encode("Content-Length: nope\r\n\r\n{}")),
    ).toThrow("invalid Content-Length");
    expect(() => decodeMessages(new TextEncoder().encode("Content-Length: 1\r\n\r\n{"))).toThrow(
      ProtocolError,
    );
  });

  test("classifies JSON-RPC messages and error responses", () => {
    const req = request(1, "initialize");
    const note = notification("initialized");
    const ok = successResponse(1, null);
    const err = errorResponse(1, ErrorCodes.InvalidParams, "bad params", { field: "rootUri" });

    expect(isRequest(req)).toBe(true);
    expect(isNotification(note)).toBe(true);
    expect(isResponse(ok)).toBe(true);
    expect(isErrorResponse(err)).toBe(true);
    expect(err.error.data).toEqual({ field: "rootUri" });
  });

  test("validates parsed JSON-RPC message shapes and clears buffered bytes", () => {
    const buffer = new MessageBuffer();
    buffer.push(encodeMessage(request(1, "initialize")).subarray(0, 8));
    expect(buffer.remainderBytes).toBe(8);
    buffer.clear();

    expect(buffer.remainderBytes).toBe(0);
    expect(parseJsonRpcMessage({ jsonrpc: "2.0", method: "initialized" })).toEqual(
      notification("initialized"),
    );
    expect(() => parseJsonRpcMessage({ jsonrpc: "2.0", method: "" })).toThrow(ProtocolError);
  });
});
