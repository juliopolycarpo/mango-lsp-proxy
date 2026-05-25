import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryLogger } from "@mango-lsp/logger";
import { createLspClient, type LspClient } from "@mango-lsp/lsp-client";
import { isErrorResponse, notification, request, successResponse } from "@mango-lsp/protocol";

describe("@mango-lsp/lsp-client", () => {
  let client: LspClient | undefined;

  afterEach(async () => {
    await client?.stop();
    client = undefined;
  });

  test("spawns a child LSP process and completes request/response framing", async () => {
    client = createLspClient({
      id: "fixture",
      command: "bun",
      args: [join(import.meta.dir, "fixtures", "echo-lsp.ts")],
      timeout: 2_000,
      logger: createMemoryLogger({ level: "debug" }),
    });

    await client.start();
    const initialize = await client.request(request(1, "initialize", { capabilities: {} }));
    expect(isErrorResponse(initialize)).toBe(false);

    const hover = await client.request(request(2, "textDocument/hover", {}));
    expect(hover).toMatchObject({
      result: { contents: { kind: "plaintext", value: "fixture hover" } },
    });

    client.notify(notification("initialized", {}));
    const shutdown = await client.request(request(3, "shutdown"));
    expect(shutdown).toMatchObject({ result: null });
    client.notify(notification("exit"));
  });

  test("resolves a child command from cwd node_modules bin", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-lsp-client-bin-"));
    const binDir = join(cwd, "node_modules", ".bin");
    const script = join(binDir, "fixture-lsp");
    await mkdir(binDir, { recursive: true });
    await Bun.write(
      script,
      `#!/usr/bin/env sh\nexec bun "${join(import.meta.dir, "fixtures", "echo-lsp.ts")}" "$@"\n`,
    );
    await chmod(script, 0o755);

    client = createLspClient({
      id: "fixture",
      command: "fixture-lsp",
      args: [],
      cwd,
      timeout: 2_000,
      logger: createMemoryLogger({ level: "debug" }),
    });

    await client.start();
    const initialize = await client.request(request(1, "initialize", { capabilities: {} }));
    expect(isErrorResponse(initialize)).toBe(false);

    const hover = await client.request(request(2, "textDocument/hover", {}));
    expect(hover).toMatchObject({
      result: { contents: { kind: "plaintext", value: "fixture hover" } },
    });

    client.notify(notification("initialized", {}));
    const shutdown = await client.request(request(3, "shutdown"));
    expect(shutdown).toMatchObject({ result: null });
    client.notify(notification("exit"));
  });

  test("handles child-to-client requests with the configured handler", async () => {
    client = createLspClient({
      id: "fixture",
      command: "bun",
      args: [join(import.meta.dir, "fixtures", "requesting-lsp.ts")],
      timeout: 2_000,
      childRequestHandler: async (req) => {
        if (req.method !== "workspace/configuration") return undefined;
        return successResponse(req.id, [{ enabled: true }, null]);
      },
      logger: createMemoryLogger({ level: "debug" }),
    });

    await client.start();
    const initialize = await client.request(request(1, "initialize", { capabilities: {} }));
    expect(isErrorResponse(initialize)).toBe(false);

    const hover = await client.request(request(2, "textDocument/hover", {}));
    expect(hover).toMatchObject({
      result: { contents: { kind: "plaintext", value: '[{"enabled":true},null]' } },
    });

    const shutdown = await client.request(request(3, "shutdown"));
    expect(shutdown).toMatchObject({ result: null });
    client.notify(notification("exit"));
  });
});
