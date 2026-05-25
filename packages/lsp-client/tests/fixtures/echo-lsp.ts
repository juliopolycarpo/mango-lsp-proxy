#!/usr/bin/env bun

import {
  encodeMessage,
  errorResponse,
  isNotification,
  isRequest,
  MessageBuffer,
  successResponse,
} from "@mango-lsp/protocol";

const buffer = new MessageBuffer();
const writer = Bun.stdout.writer();

async function send(
  message: ReturnType<typeof successResponse> | ReturnType<typeof errorResponse>,
) {
  writer.write(encodeMessage(message));
  await writer.flush();
}

for await (const chunk of Bun.stdin.stream()) {
  for (const message of buffer.push(chunk)) {
    if (isNotification(message)) {
      if (message.method === "exit") process.exit(0);
      continue;
    }
    if (!isRequest(message)) continue;

    switch (message.method) {
      case "initialize":
        await send(
          successResponse(message.id, {
            capabilities: {
              hoverProvider: true,
              executeCommandProvider: { commands: ["fixture.apply"] },
            },
          }),
        );
        break;
      case "textDocument/hover":
        await send(
          successResponse(message.id, {
            contents: { kind: "plaintext", value: "fixture hover" },
          }),
        );
        break;
      case "workspace/executeCommand":
        await send(successResponse(message.id, { executed: true }));
        break;
      case "shutdown":
        await send(successResponse(message.id, null));
        break;
      default:
        await send(errorResponse(message.id, -32601, `unknown method: ${message.method}`));
    }
  }
}
