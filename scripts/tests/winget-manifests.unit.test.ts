import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWingetManifests } from "../winget-manifests";

describe("winget manifest generation", () => {
  test("writes portable manifests for Windows release assets", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mango-winget-"));
    const manifestDir = await writeWingetManifests({
      outputDir,
      packageVersion: "0.1.0",
      tag: "0.1",
      assets: [
        { name: "mango-lsp-0.1-windows-x64.exe", sha256: "A".repeat(64) },
        { name: "mango-lsp-0.1-windows-arm64.exe", sha256: "B".repeat(64) },
      ],
    });

    const installer = await Bun.file(
      join(manifestDir, "JulioPolycarpo.MangoLSP.installer.yaml"),
    ).text();
    expect(installer).toContain("InstallerType: portable");
    expect(installer).toContain("PortableCommandAlias: mango-lsp");
    expect(installer).toContain("mango-lsp-0.1-windows-x64.exe");
    expect(installer).toContain("mango-lsp-0.1-windows-arm64.exe");
  });
});
