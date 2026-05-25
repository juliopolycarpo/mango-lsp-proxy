import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIo, main } from "@mango-lsp/cli";

function testIo(cwd: string): CliIo & { output(): string; error(): string } {
  let stdout = "";
  let stderr = "";
  const decode = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

  return {
    cwd,
    stdout: {
      write(chunk: string | Uint8Array): boolean {
        stdout += decode(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array): boolean {
        stderr += decode(chunk);
        return true;
      },
    },
    output: () => stdout,
    error: () => stderr,
  };
}

describe("@mango-lsp/cli", () => {
  test("initializes a project config and state directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-cli-init-"));
    const io = testIo(cwd);

    await expect(main(["init"], io)).resolves.toBe(0);
    expect(await Bun.file(join(cwd, "mango-lsp.toml")).exists()).toBe(true);
    expect(await Bun.file(join(cwd, ".mango-lsp", ".gitignore")).exists()).toBe(true);
    expect(io.output()).toContain("wrote");
  });

  test("doctor validates a config with an available command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-cli-doctor-"));
    const configPath = join(cwd, "mango-lsp.toml");
    await Bun.write(
      configPath,
      `
[servers.fixture]
command = "bun"
args = ["--version"]
roles = ["hover"]
`,
    );
    const io = testIo(cwd);

    await expect(main(["doctor", "--config", configPath, "--json"], io)).resolves.toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ ok: true, configPath });
  });

  test("doctor resolves child commands from the project node_modules bin", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-cli-local-bin-"));
    const binDir = join(cwd, "node_modules", ".bin");
    const script = join(binDir, "fixture-lsp");
    const configPath = join(cwd, "mango-lsp.toml");
    await mkdir(binDir, { recursive: true });
    await Bun.write(script, "#!/usr/bin/env sh\nexit 0\n");
    await chmod(script, 0o755);
    await Bun.write(
      configPath,
      `
[servers.fixture]
command = "fixture-lsp"
roles = ["hover"]
`,
    );
    const io = testIo(cwd);

    await expect(main(["doctor", "--config", configPath, "--json"], io)).resolves.toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({
      ok: true,
      servers: [{ serverId: "fixture", path: script }],
    });
  });

  test("logs prints the latest JSONL log file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-cli-logs-"));
    const logDir = join(cwd, ".mango-lsp", "logs");
    await mkdir(logDir, { recursive: true });
    await Bun.write(
      join(logDir, "test.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        level: "info",
        message: "hello",
      })}\n`,
    );
    const io = testIo(cwd);

    await expect(main(["logs"], io)).resolves.toBe(0);
    expect(io.output()).toContain("hello");
  });
});
