import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { NATIVE_TARGETS, type NativeTarget, nativeTargetBinaryPath } from "./native-targets";
import { writeWingetManifests } from "./winget-manifests";

const ROOT_DIR = resolve(import.meta.dir, "..");

export interface ReleaseArtifactOptions {
  readonly displayVersion: string;
  readonly packageVersion: string;
  readonly tag: string;
  readonly sha: string;
  readonly rootDir?: string;
  readonly outputDir?: string;
}

interface ReleaseAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

function assetExtension(target: NativeTarget): "exe" | "tar.gz" {
  return target.platform === "win32" ? "exe" : "tar.gz";
}

/** Return the GitHub release asset name for a native target.
 *
 * Example: nativeReleaseAssetName("0.1", linuxTarget) === "mango-lsp-0.1-linux-x64.tar.gz"
 */
export function nativeReleaseAssetName(version: string, target: NativeTarget): string {
  return `mango-lsp-${version}-${target.id}.${assetExtension(target)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex").toUpperCase();
}

async function runTar(sourceDir: string, binaryName: string, assetPath: string): Promise<void> {
  const proc = Bun.spawn(["tar", "-C", sourceDir, "-czf", assetPath, binaryName], {
    stderr: "inherit",
    stdout: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed for ${assetPath}`);
}

async function packageTarget(
  outputDir: string,
  outputRoot: string,
  displayVersion: string,
  target: NativeTarget,
): Promise<ReleaseAsset> {
  const sourcePath = nativeTargetBinaryPath(outputRoot, target);
  const name = nativeReleaseAssetName(displayVersion, target);
  const path = join(outputDir, name);

  if (target.platform === "win32") {
    await Bun.write(path, Bun.file(sourcePath));
  } else {
    await runTar(dirname(sourcePath), target.binaryName, path);
  }

  return { name, path, sha256: await sha256File(path) };
}

async function writeChecksums(
  outputDir: string,
  displayVersion: string,
  assets: readonly ReleaseAsset[],
): Promise<string> {
  const path = join(outputDir, `mango-lsp-${displayVersion}-checksums.sha256`);
  const lines = assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n");
  await writeFile(path, `${lines}\n`);
  return path;
}

async function writeShaFile(
  outputDir: string,
  displayVersion: string,
  sha: string,
): Promise<ReleaseAsset> {
  const name = `mango-lsp-${displayVersion}-github-sha.txt`;
  const path = join(outputDir, name);
  await writeFile(path, `${sha}\n`);
  return { name, path, sha256: await sha256File(path) };
}

async function copyInstallerScripts(rootDir: string, outputDir: string): Promise<ReleaseAsset[]> {
  const scripts = ["install.sh", "install.ps1"];
  const assets: ReleaseAsset[] = [];
  for (const script of scripts) {
    const path = join(outputDir, script);
    await Bun.write(path, Bun.file(join(rootDir, "install", script)));
    assets.push({ name: script, path, sha256: await sha256File(path) });
  }
  return assets;
}

async function writeReleaseAssetNotes(
  outputDir: string,
  displayVersion: string,
  packageVersion: string,
  tag: string,
  sha: string,
  assets: readonly ReleaseAsset[],
): Promise<void> {
  const names = assets.map((asset) => `- \`${asset.name}\``).join("\n");
  await writeFile(
    join(outputDir, "release-assets.md"),
    `## Release Assets

- Version: \`${displayVersion}\`
- Package version: \`${packageVersion}\`
- Git tag: \`${tag}\`
- Commit SHA: \`${sha}\`
- Source code: GitHub attaches the tagged source archives to this release.

## Assets

${names}
`,
  );
}

async function archiveWingetManifests(
  outputDir: string,
  displayVersion: string,
): Promise<ReleaseAsset> {
  const name = `mango-lsp-${displayVersion}-winget-manifests.tar.gz`;
  const path = join(outputDir, name);
  await runTar(join(outputDir, "winget"), "j", path);
  return { name, path, sha256: await sha256File(path) };
}

/** Create GitHub release assets and winget manifests from built binaries.
 *
 * Example: await writeReleaseArtifacts({ displayVersion: "0.1", packageVersion: "0.1.0", tag, sha })
 */
export async function writeReleaseArtifacts(options: ReleaseArtifactOptions): Promise<void> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const outputDir = options.outputDir ?? join(rootDir, "dist", "release");
  const outputRoot = join(rootDir, "packages", "native");

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  const nativeAssets = await Promise.all(
    NATIVE_TARGETS.map((target) =>
      packageTarget(outputDir, outputRoot, options.displayVersion, target),
    ),
  );
  const shaAsset = await writeShaFile(outputDir, options.displayVersion, options.sha);
  const installerAssets = await copyInstallerScripts(rootDir, outputDir);
  const assets = [...nativeAssets, shaAsset, ...installerAssets];
  await writeWingetManifests({
    outputDir,
    packageVersion: options.packageVersion,
    tag: options.tag,
    assets: nativeAssets,
  });
  const wingetAsset = await archiveWingetManifests(outputDir, options.displayVersion);
  const checksumPath = await writeChecksums(outputDir, options.displayVersion, [
    ...assets,
    wingetAsset,
  ]);
  await writeReleaseAssetNotes(
    outputDir,
    options.displayVersion,
    options.packageVersion,
    options.tag,
    options.sha,
    [
      ...assets,
      wingetAsset,
      { name: basename(checksumPath), path: checksumPath, sha256: await sha256File(checksumPath) },
    ],
  );
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  try {
    const displayVersion = optionValue(process.argv, "--display-version");
    const packageVersion = optionValue(process.argv, "--package-version");
    const tag = optionValue(process.argv, "--tag");
    const sha = optionValue(process.argv, "--sha");
    if (
      displayVersion === undefined ||
      packageVersion === undefined ||
      tag === undefined ||
      sha === undefined
    ) {
      throw new Error(
        "usage: bun scripts/release-artifacts.ts --display-version <version> --package-version <semver> --tag <tag> --sha <sha>",
      );
    }
    await writeReleaseArtifacts({ displayVersion, packageVersion, tag, sha });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
