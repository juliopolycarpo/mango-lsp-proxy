import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlLogger,
  createLogger,
  createMemoryLogger,
  resolveLogDir,
} from "@mango-lsp/logger";

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

  test("filters memory records by level and preserves nested scopes", async () => {
    const logger = createMemoryLogger({ level: "warn", scope: "root" });

    logger.trace("trace");
    logger.debug("debug");
    logger.info("info");
    logger.child("child").warn("warn", { child: true });
    logger.error("error");
    await logger.flush?.();
    await logger.close?.();

    expect(logger.records.map((record) => record.message)).toEqual(["warn", "error"]);
    expect(logger.records[0]).toMatchObject({
      level: "warn",
      scope: "root:child",
      data: { child: true },
    });
  });

  test("writes stderr logs and resolves absolute log directories", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ level: "error", scope: "cli" });

    try {
      logger.error("failed", { code: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("ERROR (cli) failed");
    } finally {
      spy.mockRestore();
    }

    expect(resolveLogDir("/repo", "/var/log/mango")).toBe("/var/log/mango");
  });
});
