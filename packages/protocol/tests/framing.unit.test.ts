import { describe, expect, test } from "bun:test";
import {
  decodeMessages,
  encodeMessage,
  MessageBuffer,
  ProtocolError,
  request,
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
});
