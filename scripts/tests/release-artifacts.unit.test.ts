import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_TARGETS, nativeTargetBinaryPath } from "../native-targets";
import { nativeReleaseAssetName, writeReleaseArtifacts } from "../release-artifacts";

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "mango-release-artifacts-"));
}

async function writeFakeNativeBinaries(rootDir: string): Promise<void> {
  const outputRoot = join(rootDir, "packages", "native");
  for (const target of NATIVE_TARGETS) {
    const path = nativeTargetBinaryPath(outputRoot, target);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `fake binary for ${target.id}\n`);
  }
}

async function writeInstallScripts(rootDir: string): Promise<void> {
  const installDir = join(rootDir, "install");
  await mkdir(installDir, { recursive: true });
  await Bun.write(join(installDir, "install.sh"), "#!/usr/bin/env sh\n");
  await Bun.write(join(installDir, "install.ps1"), "Write-Output install\n");
}

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

  test("packages native binaries, checksums, installers, notes, and winget archive", async () => {
    const rootDir = await tempRoot();
    const outputDir = join(rootDir, "release");
    await writeFakeNativeBinaries(rootDir);
    await writeInstallScripts(rootDir);

    await writeReleaseArtifacts({
      rootDir,
      outputDir,
      displayVersion: "0.1",
      packageVersion: "0.1.0",
      tag: "v0.1",
      sha: "0123456789abcdef",
    });

    expect(await Bun.file(join(outputDir, "mango-lsp-0.1-windows-x64.exe")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "mango-lsp-0.1-linux-x64.tar.gz")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "mango-lsp-0.1-winget-manifests.tar.gz")).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(outputDir, "install.sh")).text()).toContain("/usr/bin/env sh");
    expect(await Bun.file(join(outputDir, "mango-lsp-0.1-checksums.sha256")).text()).toContain(
      "mango-lsp-0.1-windows-x64.exe",
    );
    expect(await Bun.file(join(outputDir, "release-assets.md")).text()).toContain(
      "mango-lsp-0.1-github-sha.txt",
    );
  });
});
