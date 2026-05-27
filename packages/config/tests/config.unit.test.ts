import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG_TEXT,
  loadConfigFile,
  parseConfigText,
} from "@mango-lsp/config";

describe("@mango-lsp/config", () => {
  test("parses the default TOML with zod defaults", () => {
    const config = parseConfigText(DEFAULT_CONFIG_TEXT);

    expect(config.defaults.timeout).toBe(12_000);
    expect(config.servers.biome?.args).toEqual(["lsp-proxy"]);
    expect(config.servers.tsgo?.args).toEqual(["--lsp", "--stdio"]);
    expect(config.routes.codeActions?.strategy).toBe("merge");
  });

  test("derives routes from server roles when routes are omitted", () => {
    const config = parseConfigText(`
[servers.fake]
command = "fake-lsp"
roles = ["hover", "diagnostics"]
`);

    expect(config.routes.hover).toEqual({
      strategy: "firstSuccessful",
      servers: ["fake"],
    });
    expect(config.routes.diagnostics).toEqual({
      strategy: "aggregate",
      servers: ["fake"],
    });
  });

  test("rejects routes that reference unknown servers", () => {
    expect(() =>
      parseConfigText(`
[routes.hover]
strategy = "firstSuccessful"
servers = ["missing"]
`),
    ).toThrow(ConfigError);
  });

  test("loads a config file from a project directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-config-load-"));
    await Bun.write(join(cwd, "mango-lsp.toml"), DEFAULT_CONFIG_TEXT);

    const loaded = await loadConfigFile(cwd);

    expect(loaded.path).toBe(join(cwd, "mango-lsp.toml"));
    expect(loaded.rootDir).toBe(cwd);
    expect(loaded.config.servers.biome?.roles).toContain("diagnostics");
  });

  test("loadConfigFile throws ConfigError for missing config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-config-missing-"));
    await expect(loadConfigFile(cwd)).rejects.toThrow(ConfigError);
  });
});
