import { describe, expect, test } from "bun:test";
import {
  defaultStrategyForRole,
  MANGO_LSP_BINARY,
  MANGO_LSP_CONFIG_FILE,
  roleForMethod,
} from "@mango-lsp/shared";

describe("@mango-lsp/shared", () => {
  test("keeps user-facing names stable", () => {
    expect(MANGO_LSP_BINARY).toBe("mango-lsp");
    expect(MANGO_LSP_CONFIG_FILE).toBe("mango-lsp.toml");
  });

  test("maps LSP methods to routing roles", () => {
    expect(roleForMethod("textDocument/hover")).toBe("hover");
    expect(roleForMethod("textDocument/codeAction")).toBe("codeActions");
    expect(roleForMethod("workspace/unknown")).toBeUndefined();
  });

  test("uses aggregate and merge defaults for multi-server roles", () => {
    expect(defaultStrategyForRole("diagnostics")).toBe("aggregate");
    expect(defaultStrategyForRole("codeActions")).toBe("merge");
    expect(defaultStrategyForRole("hover")).toBe("firstSuccessful");
  });
});
