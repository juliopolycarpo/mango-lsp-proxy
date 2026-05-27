import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWingetManifests } from "../winget-manifests";

let tempDirs: string[] = [];

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

const WINGET_ID = "JulioPolycarpo.MangoLSP";

describe("winget manifest generation", () => {
  test("writes portable manifests for Windows release assets", async () => {
    const outputDir = await makeTemp("mango-winget-");
    const sha = (char: string) => char.repeat(64);
    const assets = [
      { name: "mango-lsp-0.1-windows-x64.exe", sha256: sha("A") },
      { name: "mango-lsp-0.1-windows-arm64.exe", sha256: sha("B") },
    ];

    const manifestDir = await writeWingetManifests({
      outputDir,
      packageVersion: "0.1.0",
      tag: "0.1",
      assets,
    });

    expect(manifestDir).toBe(join(outputDir, "winget", "j", "JulioPolycarpo", "MangoLSP", "0.1.0"));

    const installer = await Bun.file(join(manifestDir, `${WINGET_ID}.installer.yaml`)).text();
    expect(installer).toContain("PackageIdentifier: JulioPolycarpo.MangoLSP");
    expect(installer).toContain("PackageVersion: 0.1.0");
    expect(installer).toContain("InstallerType: portable");
    expect(installer).toContain("PortableCommandAlias: mango-lsp");
    expect(installer).toContain(
      "https://github.com/juliopolycarpo/mango-lsp-proxy/releases/download/0.1/mango-lsp-0.1-windows-x64.exe",
    );
    expect(installer).toContain(
      "https://github.com/juliopolycarpo/mango-lsp-proxy/releases/download/0.1/mango-lsp-0.1-windows-arm64.exe",
    );
    expect(installer).toContain(`InstallerSha256: ${sha("A")}`);
    expect(installer).toContain(`InstallerSha256: ${sha("B")}`);

    const locale = await Bun.file(join(manifestDir, `${WINGET_ID}.locale.en-US.yaml`)).text();
    expect(locale).toContain("PackageIdentifier: JulioPolycarpo.MangoLSP");
    expect(locale).toContain("PackageVersion: 0.1.0");
    expect(locale).toContain("PackageLocale: en-US");
    expect(locale).toContain("Publisher: Julio Polycarpo");
    expect(locale).toContain("PackageName: Mango LSP");
    expect(locale).toContain("License: MIT");

    const version = await Bun.file(join(manifestDir, `${WINGET_ID}.yaml`)).text();
    expect(version).toContain("PackageIdentifier: JulioPolycarpo.MangoLSP");
    expect(version).toContain("PackageVersion: 0.1.0");
    expect(version).toContain("DefaultLocale: en-US");
    expect(version).toContain("ManifestType: version");
  });

  test("throws when a Windows release asset is missing", async () => {
    const outputDir = await makeTemp("mango-winget-");
    const assets = [{ name: "mango-lsp-0.1-windows-x64.exe", sha256: "A".repeat(64) }];

    await expect(
      writeWingetManifests({
        outputDir,
        packageVersion: "0.1.0",
        tag: "0.1",
        assets,
      }),
    ).rejects.toThrow("missing release asset for windows-arm64");
  });
});
