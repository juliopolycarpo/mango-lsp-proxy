import { describe, expect, test } from "bun:test";
import { NATIVE_TARGETS } from "../native-targets";
import { nativeReleaseAssetName } from "../release-artifacts";

describe("release artifact names", () => {
  test("uses raw exe assets for Windows and tarballs for Linux and macOS", () => {
    const windows = NATIVE_TARGETS.find((target) => target.id === "windows-x64");
    const linux = NATIVE_TARGETS.find((target) => target.id === "linux-arm64-musl");
    const darwin = NATIVE_TARGETS.find((target) => target.id === "darwin-arm64");
    if (windows === undefined || linux === undefined || darwin === undefined) {
      throw new Error("missing test targets");
    }

    expect(nativeReleaseAssetName("0.1-pre", windows)).toBe("mango-lsp-0.1-pre-windows-x64.exe");
    expect(nativeReleaseAssetName("0.1-pre", linux)).toBe(
      "mango-lsp-0.1-pre-linux-arm64-musl.tar.gz",
    );
    expect(nativeReleaseAssetName("0.1-pre", darwin)).toBe("mango-lsp-0.1-pre-darwin-arm64.tar.gz");
  });
});
