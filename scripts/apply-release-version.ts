import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NATIVE_TARGETS } from "./native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");
const PACKAGE_PATHS = [
  "package.json",
  "apps/cli/package.json",
  "packages/config/package.json",
  "packages/core/package.json",
  "packages/logger/package.json",
  "packages/lsp-client/package.json",
  "packages/lsp-server/package.json",
  "packages/protocol/package.json",
  "packages/shared/package.json",
  ...NATIVE_TARGETS.map((target) => `packages/native/${target.id}/package.json`),
];

interface PackageJson {
  version?: string;
  optionalDependencies?: Record<string, string>;
}

async function readJson(path: string): Promise<PackageJson> {
  return (await Bun.file(path).json()) as PackageJson;
}

async function writeJson(path: string, value: PackageJson): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function updatePackage(path: string, version: string): Promise<void> {
  const pkg = await readJson(path);
  pkg.version = version;

  if (pkg.optionalDependencies !== undefined) {
    for (const target of NATIVE_TARGETS) {
      pkg.optionalDependencies[target.packageName] = version;
    }
  }

  await writeJson(path, pkg);
}

async function updateSharedVersion(rootDir: string, version: string): Promise<void> {
  const path = join(rootDir, "packages", "shared", "src", "index.ts");
  const source = await readFile(path, "utf8");
  const updated = source.replace(
    /export const MANGO_LSP_VERSION = "([^"]+)" as const;/,
    `export const MANGO_LSP_VERSION = "${version}" as const;`,
  );
  if (source === updated) throw new Error("MANGO_LSP_VERSION was not found");
  await writeFile(path, updated);
}

/** Apply a release version across package manifests and runtime output.
 *
 * Example: await applyReleaseVersion("0.1.0-pre")
 */
export async function applyReleaseVersion(
  version: string,
  rootDir: string = ROOT_DIR,
): Promise<void> {
  await Promise.all(PACKAGE_PATHS.map((path) => updatePackage(join(rootDir, path), version)));
  await updateSharedVersion(rootDir, version);
}

if (import.meta.main) {
  try {
    const version = process.argv[2];
    if (version === undefined || version.trim() === "") {
      throw new Error("usage: bun scripts/apply-release-version.ts <semver>");
    }
    await applyReleaseVersion(version);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
