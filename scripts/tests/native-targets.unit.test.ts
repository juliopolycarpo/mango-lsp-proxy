import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  detectHostNativeTarget,
  detectLinuxLibcFromReport,
  getNativeTarget,
  NATIVE_TARGETS,
  nativeTargetBinaryPath,
  nativeTargetIds,
} from "../native-targets";

describe("native binary target matrix", () => {
  test("defines the requested Bun compile targets", () => {
    expect(nativeTargetIds()).toEqual([
      "windows-x64",
      "windows-arm64",
      "linux-x64",
      "linux-arm64",
      "linux-x64-musl",
      "linux-arm64-musl",
      "darwin-x64",
      "darwin-arm64",
    ]);
    expect(NATIVE_TARGETS.map((target) => target.bunTarget)).toEqual([
      "bun-windows-x64",
      "bun-windows-arm64",
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-linux-x64-musl",
      "bun-linux-arm64-musl",
      "bun-darwin-x64",
      "bun-darwin-arm64",
    ]);
    expect(new Set(NATIVE_TARGETS.map((target) => target.packageName)).size).toBe(
      NATIVE_TARGETS.length,
    );
  });

  test("maps target ids to package output paths", () => {
    const windows = getNativeTarget("windows-x64");
    const linux = getNativeTarget("linux-arm64-musl");

    expect(windows).toBeDefined();
    expect(linux).toBeDefined();
    if (windows === undefined || linux === undefined) throw new Error("missing test targets");

    expect(nativeTargetBinaryPath("/tmp/native", windows)).toBe(
      join("/tmp/native", "windows-x64", "bin", "mango-lsp.exe"),
    );
    expect(nativeTargetBinaryPath("/tmp/native", linux)).toBe(
      join("/tmp/native", "linux-arm64-musl", "bin", "mango-lsp"),
    );
  });

  test("detects glibc and musl from process report shape", () => {
    expect(
      detectLinuxLibcFromReport({
        header: { glibcVersionRuntime: "2.39" },
      }),
    ).toBe("glibc");
    expect(
      detectLinuxLibcFromReport({
        header: { glibcVersionCompiler: "2.39" },
      }),
    ).toBe("glibc");
    expect(detectLinuxLibcFromReport({ header: {} })).toBe("musl");
    expect(detectLinuxLibcFromReport(undefined)).toBe("musl");
  });

  test("detects configured host targets by platform, architecture, and libc", () => {
    expect(detectHostNativeTarget("win32", "x64")?.id).toBe("windows-x64");
    expect(detectHostNativeTarget("win32", "arm64")?.id).toBe("windows-arm64");
    expect(detectHostNativeTarget("linux", "x64", "glibc")?.id).toBe("linux-x64");
    expect(detectHostNativeTarget("linux", "arm64", "glibc")?.id).toBe("linux-arm64");
    expect(detectHostNativeTarget("linux", "x64", "musl")?.id).toBe("linux-x64-musl");
    expect(detectHostNativeTarget("linux", "arm64", "musl")?.id).toBe("linux-arm64-musl");
    expect(detectHostNativeTarget("darwin", "x64")?.id).toBe("darwin-x64");
    expect(detectHostNativeTarget("darwin", "arm64")?.id).toBe("darwin-arm64");
  });
});
