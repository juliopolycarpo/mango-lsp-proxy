import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
    await logger.flush?.();
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

  test("generates default timestamped file name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mango-logger-timestamp-"));
    const logger = await createJsonlLogger({ rootDir, logDir: "logs", level: "info" });
    logger.info("started");
    await logger.close?.();

    const files = Array.from(
      new Bun.Glob("*.jsonl").scanSync({ cwd: join(rootDir, "logs"), absolute: true }),
    );
    expect(files).toHaveLength(1);
    expect(files[0] ?? "").toMatch(/mango-lsp-\d{4}-\d{2}-\d{2}T\d{6}-\d{3}Z\.jsonl$/);
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

  test("default level is info in memory logger", () => {
    const logger = createMemoryLogger();
    logger.trace("trace");
    logger.debug("debug");
    logger.info("reported");
    logger.warn("warn");

    expect(logger.records.map((r) => r.message)).toEqual(["reported", "warn"]);
  });

  test("records have timestamp and exclude optional fields when absent", () => {
    const logger = createMemoryLogger({ level: "trace" });
    logger.trace("no-scope-no-data");

    expect(logger.records[0]).toMatchObject({ level: "trace", message: "no-scope-no-data" });
    expect(logger.records[0]?.timestamp).toBeString();
    expect(logger.records[0]?.scope).toBeUndefined();
    expect(logger.records[0]?.data).toBeUndefined();
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

  test("resolves relative log directories under root", () => {
    const relative = resolveLogDir("/repo", "custom-logs");
    expect(relative).toBe(join("/repo", "custom-logs"));
  });

  test("resolves log dir using cwd when rootDir is omitted", () => {
    const result = resolveLogDir();
    expect(result).toBe(join(process.cwd(), ".mango-lsp", "logs"));
    expect(isAbsolute(result)).toBe(true);
  });

  test("stderr log includes no scope section when scope is unset", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ level: "warn" });

    try {
      logger.warn("bare");
      expect(String(spy.mock.calls[0]?.[0])).toContain(" WARN bare");
    } finally {
      spy.mockRestore();
    }
  });

  test("stderr log with data appends JSON payload", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ level: "info" });

    try {
      logger.info("withData", { key: 1 });
      expect(String(spy.mock.calls[0]?.[0])).toContain('{"key":1}');
    } finally {
      spy.mockRestore();
    }
  });
});
