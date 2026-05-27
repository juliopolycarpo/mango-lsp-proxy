#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { applyReleaseVersion } from "./apply-release-version";
import { buildNativeBinaries } from "./build";
import { type ChangelogOptions, runChangelog } from "./changelog";
import { publishPackages } from "./publish-packages";
import { type ReleaseArtifactOptions, writeReleaseArtifacts } from "./release-artifacts";
import { parseReleaseTag } from "./release-version";
import { smokeNativeBinaries } from "./smoke-native";

const ROOT_DIR = resolve(import.meta.dir, "..");

export interface ReleaseOptions {
  readonly tag: string;
  readonly dryRun: boolean;
  readonly sha?: string;
  readonly skipCheck?: boolean;
  readonly skipTests?: boolean;
  readonly skipBuild?: boolean;
  readonly skipSmoke?: boolean;
  readonly skipArtifacts?: boolean;
  readonly skipReleaseNotes?: boolean;
  readonly skipPublish?: boolean;
  /** Optional override for version application, used in tests. */
  readonly applyVersion?: (
    version: string,
    rootDir: string,
    options: { dryRun: boolean },
  ) => Promise<void>;
  /** Optional override for changelog generation, used in tests. */
  readonly runChangelogFn?: (options: ChangelogOptions) => Promise<void>;
  /** Optional override for release artifacts creation, used in tests. */
  readonly writeReleaseArtifactsFn?: (options: ReleaseArtifactOptions) => Promise<void>;
}

function log(step: string, message: string, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] " : "";
  process.stdout.write(`${prefix}[${step}] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveSha(sha: string | undefined): string {
  if (sha !== undefined) return sha;
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT_DIR, encoding: "utf8" }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

export function buildGhReleaseArgs(
  tag: string,
  displayVersion: string,
  isPrerelease: boolean,
  assetPaths: readonly string[],
): string[] {
  const args = [
    "release",
    "create",
    tag,
    "--verify-tag",
    "--title",
    `mango-lsp ${displayVersion}`,
    "--notes-file",
    `${ROOT_DIR}/dist/release/release-notes.md`,
  ];
  if (isPrerelease) {
    args.push("--prerelease");
  } else {
    args.push("--latest");
  }
  args.push(...assetPaths);
  return args;
}

export function formatGhCommand(
  tag: string,
  displayVersion: string,
  isPrerelease: boolean,
): string {
  const assetPaths = [
    `${ROOT_DIR}/dist/release/mango-lsp-*`,
    `${ROOT_DIR}/dist/release/install.sh`,
    `${ROOT_DIR}/dist/release/install.ps1`,
  ];
  return ["gh", ...buildGhReleaseArgs(tag, displayVersion, isPrerelease, assetPaths)].join(" ");
}

export async function expandAssetPaths(releaseDir: string): Promise<string[]> {
  const glob = new Bun.Glob("mango-lsp-*");
  const resolved: string[] = [];
  for await (const file of glob.scan(releaseDir)) {
    resolved.push(`${releaseDir}/${file}`);
  }
  if (resolved.length === 0) {
    throw new Error("No mango-lsp-* release assets found in dist/release");
  }
  resolved.push(`${releaseDir}/install.sh`, `${releaseDir}/install.ps1`);
  return resolved;
}

async function runGhRelease(
  tag: string,
  displayVersion: string,
  isPrerelease: boolean,
): Promise<void> {
  const assetPaths = await expandAssetPaths(`${ROOT_DIR}/dist/release`);
  const args = buildGhReleaseArgs(tag, displayVersion, isPrerelease, assetPaths);
  const proc = Bun.spawn(["gh", ...args], {
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh release create failed with exit ${code}`);
}

async function runBun(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bun ${args.join(" ")} failed with exit ${code}`);
}

export async function runRelease(options: ReleaseOptions): Promise<void> {
  const dryRun = options.dryRun;
  const tag = options.tag;
  const sha = resolveSha(options.sha);

  log("version", `parsing tag ${tag}`, dryRun);
  const version = parseReleaseTag(tag);
  log(
    "version",
    `display: ${version.displayVersion}, package: ${version.packageVersion}, prerelease: ${version.isPrerelease}`,
    dryRun,
  );

  log("version", "applying version to package manifests", dryRun);
  const applyVersion = options.applyVersion ?? applyReleaseVersion;
  const runChangelogFn = options.runChangelogFn ?? runChangelog;
  const writeReleaseArtifactsFn = options.writeReleaseArtifactsFn ?? writeReleaseArtifacts;
  await applyVersion(version.packageVersion, ROOT_DIR, { dryRun });

  if (!options.skipCheck) {
    log("check", "running typecheck, lint, and format checks", dryRun);
    await runBun(["run", "check"]);
  }

  if (!options.skipTests) {
    log("test", "running tests", dryRun);
    await runBun(["test"]);
  }

  if (!options.skipBuild) {
    log("build", "building native binaries", dryRun);
    const outputs = await buildNativeBinaries({ clean: true });
    for (const output of outputs) {
      log("build", `built ${output.target.id}`, dryRun);
    }
  }

  if (!options.skipSmoke) {
    log("smoke", "validating native binaries", dryRun);
    await smokeNativeBinaries();
    log("smoke", "native binaries validated", dryRun);
  }

  if (!options.skipArtifacts) {
    log("artifacts", "packaging release assets", dryRun);
    await writeReleaseArtifactsFn({
      displayVersion: version.displayVersion,
      packageVersion: version.packageVersion,
      tag,
      sha,
    });
    log("artifacts", "release assets packaged", dryRun);
  }

  const shouldSkipReleaseNotes = options.skipReleaseNotes || options.skipArtifacts;
  if (options.skipArtifacts && !options.skipReleaseNotes) {
    log("release-notes", "skipping (artifacts skipped, no assets file available)", dryRun);
  }

  if (!shouldSkipReleaseNotes) {
    log("release-notes", "generating release notes", dryRun);
    await runChangelogFn({
      command: "release-notes",
      tag,
      outputPath: "dist/release/release-notes.md",
      assetsPath: "dist/release/release-assets.md",
    });
    log("release-notes", "release notes generated", dryRun);
  }

  if (dryRun) {
    const ghCmd = formatGhCommand(tag, version.displayVersion, version.isPrerelease);
    log("github-release", `would run: ${ghCmd}`, dryRun);
  } else {
    log("github-release", "creating GitHub release", dryRun);
    await runGhRelease(tag, version.displayVersion, version.isPrerelease);
    log("github-release", "GitHub release created", dryRun);
  }

  if (!options.skipPublish) {
    log("npm", `publishing packages (tag: ${version.isPrerelease ? "next" : "latest"})`, dryRun);
    const result = await publishPackages({
      npmTag: version.isPrerelease ? "next" : "latest",
      dryRun,
    });
    if (dryRun) {
      log(
        "npm",
        `would publish ${result.published.length} package(s): ${result.published.join(", ")}`,
        dryRun,
      );
    } else {
      log(
        "npm",
        `published ${result.published.length} package(s): ${result.published.join(", ")}`,
        dryRun,
      );
    }
  }

  if (dryRun) {
    process.stdout.write("\n[dry-run] Release pipeline completed successfully.\n");
    process.stdout.write(
      "[dry-run] No GitHub release was created and no packages were published.\n",
    );
    process.stdout.write("[dry-run] To revert version changes: git checkout .\n");
  } else {
    process.stdout.write("Release completed successfully.\n");
  }
}

function parseArgv(argv: readonly string[]): ReleaseOptions {
  let tag: string | undefined;
  let sha: string | undefined;
  let dryRun = false;
  let skipCheck = false;
  let skipTests = false;
  let skipBuild = false;
  let skipSmoke = false;
  let skipArtifacts = false;
  let skipReleaseNotes = false;
  let skipPublish = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--tag":
        if (next === undefined) throw new Error("--tag requires a value");
        tag = next;
        index += 1;
        break;
      case "--sha":
        if (next === undefined) throw new Error("--sha requires a value");
        sha = next;
        index += 1;
        break;
      case "--skip-check":
        skipCheck = true;
        break;
      case "--skip-tests":
        skipTests = true;
        break;
      case "--skip-build":
        skipBuild = true;
        break;
      case "--skip-smoke":
        skipSmoke = true;
        break;
      case "--skip-artifacts":
        skipArtifacts = true;
        break;
      case "--skip-release-notes":
        skipReleaseNotes = true;
        break;
      case "--skip-publish":
        skipPublish = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (tag === undefined) {
    throw new Error("usage: bun scripts/release.ts --tag <tag> [--dry-run]");
  }

  return {
    tag,
    dryRun,
    ...(sha === undefined ? {} : { sha }),
    skipCheck,
    skipTests,
    skipBuild,
    skipSmoke,
    skipArtifacts,
    skipReleaseNotes,
    skipPublish,
  };
}

if (import.meta.main) {
  try {
    await runRelease(parseArgv(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  }
}
