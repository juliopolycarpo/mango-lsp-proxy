import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cliOptions, help, parseTargetList } from "../build";

describe("native build CLI options", () => {
  test("parses comma-separated target lists and rejects unknown targets", () => {
    expect(parseTargetList(" linux-x64, darwin-arm64 ")).toEqual(["linux-x64", "darwin-arm64"]);
    expect(() => parseTargetList("missing-target")).toThrow("unknown native target");
  });

  test("parses help, list, clean, target, and output flags", () => {
    expect(cliOptions(["--help"])).toBe("help");
    expect(cliOptions(["--list"])).toBe("list");
    expect(cliOptions(["--clean", "--target", "linux-x64", "--targets", "darwin-arm64"])).toEqual({
      clean: true,
      targetIds: ["linux-x64", "darwin-arm64"],
    });
    expect(cliOptions(["--output-root", "tmp/native"])).toEqual({
      clean: false,
      outputRoot: resolve(import.meta.dir, "..", "..", "tmp/native"),
    });
  });

  test("rejects incomplete and unknown build flags", () => {
    expect(() => cliOptions(["--target"])).toThrow("--target requires a value");
    expect(() => cliOptions(["--targets"])).toThrow("--targets requires a value");
    expect(() => cliOptions(["--output-root"])).toThrow("--output-root requires a value");
    expect(() => cliOptions(["--missing"])).toThrow("unknown option");
  });

  test("renders help with every configured native target", () => {
    expect(help()).toContain("Build standalone mango-lsp binaries");
    expect(help()).toContain("linux-x64-musl");
    expect(help()).toContain("windows-arm64");
  });
});
