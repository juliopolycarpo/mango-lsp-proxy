import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = "juliopolycarpo/mango-lsp-proxy";
const WINGET_ID = "JulioPolycarpo.MangoLSP";
const WINGET_SCHEMA_VERSION = "1.10.0";

export interface WingetAsset {
  readonly name: string;
  readonly sha256: string;
}

export interface WingetManifestOptions {
  readonly outputDir: string;
  readonly packageVersion: string;
  readonly tag: string;
  readonly assets: readonly WingetAsset[];
}

function releaseDownloadUrl(tag: string, assetName: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;
}

function requiredAsset(assets: readonly WingetAsset[], targetId: string): WingetAsset {
  const asset = assets.find((item) => item.name.includes(`-${targetId}.`));
  if (asset === undefined) throw new Error(`missing release asset for ${targetId}`);
  return asset;
}

function wingetInstaller(tag: string, asset: WingetAsset, architecture: string): string {
  return `- Architecture: ${architecture}
  InstallerUrl: ${releaseDownloadUrl(tag, asset.name)}
  InstallerSha256: ${asset.sha256}
  PortableCommandAlias: mango-lsp`;
}

function installerManifest(
  packageVersion: string,
  tag: string,
  assets: readonly WingetAsset[],
): string {
  const windowsX64 = requiredAsset(assets, "windows-x64");
  const windowsArm64 = requiredAsset(assets, "windows-arm64");
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${packageVersion}
InstallerType: portable
Commands:
- mango-lsp
Installers:
${wingetInstaller(tag, windowsX64, "x64")}
${wingetInstaller(tag, windowsArm64, "arm64")}
ManifestType: installer
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

function localeManifest(packageVersion: string): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${packageVersion}
PackageLocale: en-US
Publisher: Julio Polycarpo
PackageName: Mango LSP
License: MIT
ShortDescription: One LSP proxy for coding agents.
PackageUrl: https://github.com/${REPO}
ManifestType: defaultLocale
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

function versionManifest(packageVersion: string): string {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${WINGET_SCHEMA_VERSION}.schema.json
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${packageVersion}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${WINGET_SCHEMA_VERSION}
`;
}

/** Write winget manifests that point to release Windows portable binaries.
 *
 * Example: await writeWingetManifests({ outputDir, packageVersion, tag, assets })
 */
export async function writeWingetManifests(options: WingetManifestOptions): Promise<string> {
  const manifestDir = join(
    options.outputDir,
    "winget",
    "j",
    "JulioPolycarpo",
    "MangoLSP",
    options.packageVersion,
  );
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `${WINGET_ID}.yaml`), versionManifest(options.packageVersion));
  await writeFile(
    join(manifestDir, `${WINGET_ID}.installer.yaml`),
    installerManifest(options.packageVersion, options.tag, options.assets),
  );
  await writeFile(
    join(manifestDir, `${WINGET_ID}.locale.en-US.yaml`),
    localeManifest(options.packageVersion),
  );
  return manifestDir;
}
