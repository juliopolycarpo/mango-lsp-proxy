#!/usr/bin/env bun

import {
  encodeMessage,
  errorResponse,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MessageBuffer,
  request,
  successResponse,
} from "@mango-lsp/protocol";

const buffer = new MessageBuffer();
const writer = Bun.stdout.writer();
const pending = new Map<string, (response: JsonRpcResponse) => void>();
let configuration: unknown[] | undefined;

function idKey(id: string | number | null): string {
  return `${typeof id}:${String(id)}`;
}

async function send(
  message:
    | ReturnType<typeof request>
    | ReturnType<typeof successResponse>
    | ReturnType<typeof errorResponse>,
) {
  writer.write(encodeMessage(message));
  await writer.flush();
}

function waitForResponse(id: string | number | null): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    pending.set(idKey(id), resolve);
  });
}

for await (const chunk of Bun.stdin.stream()) {
  for (const message of buffer.push(chunk)) {
    if (isResponse(message)) {
      pending.get(idKey(message.id))?.(message);
      pending.delete(idKey(message.id));
      continue;
    }

    if (isNotification(message)) {
      if (message.method === "exit") process.exit(0);
      continue;
    }

    if (!isRequest(message)) continue;
    const requestMessage = message as JsonRpcRequest;

    switch (requestMessage.method) {
      case "initialize":
        void (async () => {
          await send(
            request(900, "workspace/configuration", {
              items: [{ section: "fixture.alpha" }, { section: "fixture.beta" }],
            }),
          );
          const response = await waitForResponse(900);
          configuration =
            "result" in response && Array.isArray(response.result) ? response.result : [];
          await send(
            successResponse(requestMessage.id, {
              capabilities: { hoverProvider: true },
            }),
          );
        })();
        break;
      case "textDocument/hover":
        await send(
          successResponse(requestMessage.id, {
            contents: {
              kind: "plaintext",
              value: JSON.stringify(configuration ?? []),
            },
          }),
        );
        break;
      case "shutdown":
        await send(successResponse(requestMessage.id, null));
        break;
      default:
        await send(
          errorResponse(requestMessage.id, -32601, `unknown method: ${requestMessage.method}`),
        );
    }
  }
}
