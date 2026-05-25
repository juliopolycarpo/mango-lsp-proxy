import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_CONFIG_TEXT, parseConfigText } from "@mango-lsp/config";

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
});
