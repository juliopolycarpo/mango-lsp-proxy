import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  asError,
  defaultStrategyForRole,
  errorMessage,
  MANGO_LSP_BINARY,
  MANGO_LSP_CONFIG_FILE,
  nodeModulesBinDirs,
  resolveCommandPath,
  roleForMethod,
  withNodeModulesBinPath,
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

  test("normalizes thrown values into user-facing messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(asError("plain", "fallback").message).toBe("fallback");
  });

  test("prepends workspace node_modules bins without duplicates", () => {
    const env = withNodeModulesBinPath(
      { PATH: "base" },
      { cwd: "/workspace/pkg", rootDir: "/workspace" },
    );

    expect(nodeModulesBinDirs({ cwd: "/workspace", rootDir: "/workspace" })).toEqual([
      join("/workspace", "node_modules", ".bin"),
    ]);
    expect(env.PATH).toBe(
      [
        join("/workspace/pkg", "node_modules", ".bin"),
        join("/workspace", "node_modules", ".bin"),
        "base",
      ].join(delimiter),
    );
  });

  test("resolves relative executable paths from the configured cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mango-shared-command-"));
    const binDir = join(cwd, "bin");
    const command = join(binDir, "tool");
    await mkdir(binDir, { recursive: true });
    await Bun.write(command, "#!/usr/bin/env sh\n");
    await chmod(command, 0o755);

    await expect(resolveCommandPath("./bin/tool", { cwd })).resolves.toBe(command);
    await expect(resolveCommandPath("./bin/missing", { cwd })).resolves.toBeNull();
  });
});
