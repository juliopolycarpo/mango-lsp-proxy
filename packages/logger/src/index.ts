/**
 * @mango-lsp/logger
 *
 * Small logger abstraction with stderr and JSONL file sinks.
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MANGO_LSP_LOGS_DIR } from "@mango-lsp/shared";
import type { FileSink } from "bun";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
}

interface LoggerSink {
  emit(record: LogRecord): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

function childScope(parent: string | undefined, child: string): string {
  return parent === undefined ? child : `${parent}:${child}`;
}

class BaseLogger implements Logger {
  readonly #level: LogLevel;
  readonly #scope: string | undefined;
  readonly #sink: LoggerSink;

  constructor(sink: LoggerSink, options: LoggerOptions = {}) {
    this.#sink = sink;
    this.#level = options.level ?? "info";
    this.#scope = options.scope;
  }

  #emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(this.#scope !== undefined ? { scope: this.#scope } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    this.#sink.emit(record);
  }

  trace(message: string, data?: Record<string, unknown>): void {
    this.#emit("trace", message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.#emit("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.#emit("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.#emit("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.#emit("error", message, data);
  }

  child(scope: string): Logger {
    return new BaseLogger(this.#sink, {
      level: this.#level,
      scope: childScope(this.#scope, scope),
    });
  }

  async flush(): Promise<void> {
    await this.#sink.flush?.();
  }

  async close(): Promise<void> {
    await this.#sink.close?.();
  }
}

class StderrSink implements LoggerSink {
  emit(record: LogRecord): void {
    const line = `[${record.timestamp}] ${record.level.toUpperCase()}${
      record.scope ? ` (${record.scope})` : ""
    } ${record.message}${record.data ? ` ${JSON.stringify(record.data)}` : ""}`;
    console.error(line);
  }
}

class MemorySink implements LoggerSink {
  readonly records: LogRecord[] = [];

  emit(record: LogRecord): void {
    this.records.push(record);
  }
}

class JsonlFileSink implements LoggerSink {
  readonly path: string;
  readonly #writer: FileSink;

  constructor(path: string) {
    this.path = path;
    this.#writer = Bun.file(path).writer();
  }

  emit(record: LogRecord): void {
    this.#writer.write(`${JSON.stringify(record)}\n`);
  }

  async flush(): Promise<void> {
    await this.#writer.flush();
  }

  async close(): Promise<void> {
    await this.#writer.end();
  }
}

export interface JsonlLoggerOptions extends LoggerOptions {
  rootDir?: string;
  logDir?: string;
  fileName?: string;
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "-");
}

export function resolveLogDir(
  rootDir: string = process.cwd(),
  logDir: string = MANGO_LSP_LOGS_DIR,
): string {
  return isAbsolute(logDir) ? logDir : join(rootDir, logDir);
}

export async function createJsonlLogger(options: JsonlLoggerOptions = {}): Promise<Logger> {
  const directory = resolveLogDir(options.rootDir, options.logDir);
  await mkdir(directory, { recursive: true });
  const fileName = options.fileName ?? `mango-lsp-${timestampForFileName()}.jsonl`;
  const sink = new JsonlFileSink(join(directory, fileName));
  return new BaseLogger(sink, options);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new BaseLogger(new StderrSink(), options);
}

export interface MemoryLogger extends Logger {
  readonly records: readonly LogRecord[];
}

export function createMemoryLogger(options: LoggerOptions = {}): MemoryLogger {
  const sink = new MemorySink();
  const logger = new BaseLogger(sink, options);
  return Object.assign(logger, {
    get records(): readonly LogRecord[] {
      return sink.records;
    },
  });
}
