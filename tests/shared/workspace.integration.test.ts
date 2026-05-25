import { describe, expect, test } from "bun:test";
import { loadConfigFile } from "@mango-lsp/config";
import { routedRoles } from "@mango-lsp/core";

describe("workspace sample configuration", () => {
  test("loads mango-lsp.toml and exposes all v0.1 routed roles", async () => {
    const loaded = await loadConfigFile("mango-lsp.toml");

    expect(Object.keys(loaded.config.servers).sort()).toEqual(["biome", "tsgo"]);
    expect(routedRoles(loaded.config)).toEqual([
      "navigation",
      "hover",
      "references",
      "symbols",
      "diagnostics",
      "codeActions",
      "formatting",
    ]);
  });
});
