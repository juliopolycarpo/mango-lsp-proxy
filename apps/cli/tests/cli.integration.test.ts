import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIo, main } from "@mango-lsp/cli";

class FakeCliIo implements CliIo {
  readonly cwd: string;
  #stdout = "";
  #stderr = "";

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  readonly stdout = {
    write: (chunk: string | Uint8Array): boolean => {
      this.#stdout += decodeOutput(chunk);
      return true;
    },
  };

  readonly stderr = {
    write: (chunk: string | Uint8Array): boolean => {
      this.#stderr += decodeOutput(chunk);
      return true;
    },
  };

  output(): string {
    return this.#stdout;
  }

  error(): string {
    return this.#stderr;
  }
}

function decodeOutput(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

async function tempProject(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeConfig(cwd: string, body: string): Promise<string> {
  const path = join(cwd, "mango-lsp.toml");
  await Bun.write(path, body);
  return path;
}

describe("@mango-lsp/cli", () => {
  test("prints help, version, and unknown-command errors", async () => {
    const cwd = await tempProject("mango-cli-basics-");
    const help = new FakeCliIo(cwd);
    const version = new FakeCliIo(cwd);
    const unknown = new FakeCliIo(cwd);

    await expect(main(["help"], help)).resolves.toBe(0);
    await expect(main(["--version"], version)).resolves.toBe(0);
    await expect(main(["bogus"], unknown)).resolves.toBe(2);

    expect(help.output()).toContain("COMMANDS");
    expect(version.output()).toMatch(/^mango-lsp v/);
    expect(unknown.error()).toContain("unknown command: bogus");
  });

  test("initializes a project config and state directory", async () => {
    const cwd = await tempProject("mango-cli-init-");
    const io = new FakeCliIo(cwd);

    await expect(main(["init"], io)).resolves.toBe(0);
    expect(await Bun.file(join(cwd, "mango-lsp.toml")).exists()).toBe(true);
    expect(await Bun.file(join(cwd, ".mango-lsp", ".gitignore")).exists()).toBe(true);
    expect(io.output()).toContain("wrote");
  });

  test("refuses to overwrite config unless --force is passed", async () => {
    const cwd = await tempProject("mango-cli-init-existing-");
    await Bun.write(join(cwd, "mango-lsp.toml"), "original");
    const refused = new FakeCliIo(cwd);
    const forced = new FakeCliIo(cwd);

    await expect(main(["init"], refused)).resolves.toBe(1);
    await expect(main(["init", "--force"], forced)).resolves.toBe(0);

    expect(refused.error()).toContain("already exists");
    expect(await Bun.file(join(cwd, "mango-lsp.toml")).text()).toContain("[workspace]");
  });

  test("doctor validates a config with an available command", async () => {
    const cwd = await tempProject("mango-cli-doctor-");
    const configPath = await writeConfig(
      cwd,
      `
[servers.fixture]
command = "bun"
args = ["--version"]
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["doctor", "--config", configPath, "--json"], io)).resolves.toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ ok: true, configPath });
  });

  test("doctor reports missing commands in plain text", async () => {
    const cwd = await tempProject("mango-cli-doctor-missing-");
    await writeConfig(
      cwd,
      `
[servers.missing]
command = "mango-lsp-missing-fixture"
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["doctor"], io)).resolves.toBe(1);
    expect(io.output()).toContain("missing missing: mango-lsp-missing-fixture");
  });

  test("doctor resolves child commands from the project node_modules bin", async () => {
    const cwd = await tempProject("mango-cli-local-bin-");
    const binDir = join(cwd, "node_modules", ".bin");
    const script = join(binDir, "fixture-lsp");
    await mkdir(binDir, { recursive: true });
    await Bun.write(script, "#!/usr/bin/env sh\nexit 0\n");
    await chmod(script, 0o755);
    const configPath = await writeConfig(
      cwd,
      `
[servers.fixture]
command = "fixture-lsp"
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["doctor", "--config", configPath, "--json"], io)).resolves.toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({
      ok: true,
      servers: [{ serverId: "fixture", path: script }],
    });
  });

  test("logs prints the latest JSONL log file", async () => {
    const cwd = await tempProject("mango-cli-logs-");
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
    const io = new FakeCliIo(cwd);

    await expect(main(["logs"], io)).resolves.toBe(0);
    expect(io.output()).toContain("hello");
  });

  test("logs supports raw tail output and malformed JSON fallback", async () => {
    const cwd = await tempProject("mango-cli-logs-raw-");
    const logDir = join(cwd, ".mango-lsp", "logs");
    await mkdir(logDir, { recursive: true });
    await Bun.write(join(logDir, "test.jsonl"), '{"message":"older"}\nnot-json\n');
    const io = new FakeCliIo(cwd);

    await expect(main(["logs", "--raw", "--lines", "1"], io)).resolves.toBe(0);
    expect(io.output()).toBe("not-json\n");
  });

  test("logs succeeds when no project logs exist", async () => {
    const cwd = await tempProject("mango-cli-no-logs-");
    const io = new FakeCliIo(cwd);

    await expect(main(["logs"], io)).resolves.toBe(0);
    expect(io.output()).toContain("no logs found");
  });

  test("serve-lsp requires stdio before loading config", async () => {
    const cwd = await tempProject("mango-cli-serve-lsp-");
    const io = new FakeCliIo(cwd);

    await expect(main(["serve-lsp"], io)).resolves.toBe(2);
    expect(io.error()).toContain("requires --stdio");
  });

  test("serve-lsp fails when proxy cannot start child servers", async () => {
    const cwd = await tempProject("mango-cli-serve-lsp-start-");
    await writeConfig(
      cwd,
      `
[servers.missing]
command = "mango-lsp-missing-fixture"
args = []
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["serve-lsp", "--stdio"], io)).resolves.toBe(1);
  });

  test("self-test fails fast when child binaries are missing", async () => {
    const cwd = await tempProject("mango-cli-test-missing-");
    await writeConfig(
      cwd,
      `
[servers.missing]
command = "mango-lsp-missing-fixture"
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["test"], io)).resolves.toBe(1);
    expect(io.error()).toContain("missing child server binaries");
  });

  test("self-test initializes and shuts down a configured child server", async () => {
    const cwd = await tempProject("mango-cli-test-");
    const fixture = join(
      import.meta.dir,
      "../../../packages/lsp-client/tests/fixtures/echo-lsp.ts",
    );
    await writeConfig(
      cwd,
      `
[servers.fixture]
command = "bun"
args = ["${fixture}"]
roles = ["hover"]
`,
    );
    const io = new FakeCliIo(cwd);

    await expect(main(["test"], io)).resolves.toBe(0);
    expect(io.output()).toContain("self-test passed");
  });

  test("serve-lsp shows config error when mango-lsp.toml is missing", async () => {
    const cwd = await tempProject("mango-cli-serve-error-");
    const io = new FakeCliIo(cwd);

    await expect(main(["serve-lsp", "--stdio"], io)).resolves.toBe(1);
    expect(io.error()).toContain("could not find mango-lsp.toml");
  });

  test("serve-lsp shows config error with invalid toml", async () => {
    const cwd = await tempProject("mango-cli-serve-bad-config-");
    await Bun.write(join(cwd, "mango-lsp.toml"), "not = toml [[[");
    const io = new FakeCliIo(cwd);

    await expect(main(["serve-lsp", "--stdio"], io)).resolves.toBe(1);
    expect(io.error()).toContain("TOML");
  });

  test("doctor shows config error in json mode when config is missing", async () => {
    const cwd = await tempProject("mango-cli-doctor-config-err-");
    const io = new FakeCliIo(cwd);

    await expect(main(["doctor", "--json"], io)).resolves.toBe(1);
    expect(io.error()).toContain("could not find mango-lsp.toml");
  });

  test("logs falls back to raw output for unparseable JSON lines", async () => {
    const cwd = await tempProject("mango-cli-logs-fallback-");
    const logDir = join(cwd, ".mango-lsp", "logs");
    await mkdir(logDir, { recursive: true });
    await Bun.write(join(logDir, "test.jsonl"), "not-json-at-all\n");
    const io = new FakeCliIo(cwd);

    await expect(main(["logs"], io)).resolves.toBe(0);
    expect(io.output()).toContain("not-json-at-all");
  });

  test("test command shows config error when no config is present", async () => {
    const cwd = await tempProject("mango-cli-test-no-config-");
    const io = new FakeCliIo(cwd);

    await expect(main(["test"], io)).resolves.toBe(1);
    expect(io.error()).toContain("could not find mango-lsp.toml");
  });
});
