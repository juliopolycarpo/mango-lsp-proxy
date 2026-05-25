import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlLogger } from "@mango-lsp/logger";

describe("@mango-lsp/logger", () => {
  test("writes scoped JSONL records", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mango-logger-"));
    const logger = await createJsonlLogger({
      rootDir,
      logDir: "logs",
      fileName: "test.jsonl",
      level: "debug",
    });

    logger.info("started");
    logger.child("child").debug("ready", { pid: 123 });
    await logger.close?.();

    const lines = (await Bun.file(join(rootDir, "logs", "test.jsonl")).text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "info", message: "started" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      level: "debug",
      scope: "child",
      message: "ready",
      data: { pid: 123 },
    });
  });
});
