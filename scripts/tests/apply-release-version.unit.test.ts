import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyReleaseVersion } from "../apply-release-version";
import { NATIVE_TARGETS } from "../native-targets";

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

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mango-release-"));
}

async function seedPackage(rootDir: string, relativePath: string, extra?: object): Promise<void> {
  const fullPath = join(rootDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  const content = { version: "0.0.0", ...extra };
  await writeFile(fullPath, `${JSON.stringify(content, null, 2)}\n`);
}

async function seedSharedVersion(rootDir: string, version: string): Promise<void> {
  const path = join(rootDir, "packages", "shared", "src", "index.ts");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `export const MANGO_LSP_VERSION = "${version}" as const;\n`);
}

async function readPackageVersion(rootDir: string, relativePath: string): Promise<string> {
  const pkg = (await Bun.file(join(rootDir, relativePath)).json()) as { version?: string };
  return pkg.version ?? "";
}

async function readSharedVersion(rootDir: string): Promise<string> {
  const text = await Bun.file(join(rootDir, "packages", "shared", "src", "index.ts")).text();
  const match = /export const MANGO_LSP_VERSION = "([^"]+)" as const;/.exec(text);
  return match?.[1] ?? "";
}

describe("applyReleaseVersion", () => {
  test("bumps every package.json and the runtime constant", async () => {
    const root = await makeTempRoot();
    await Promise.all(PACKAGE_PATHS.map((p) => seedPackage(root, p)));
    await seedSharedVersion(root, "0.0.0");

    await applyReleaseVersion("1.2.3", root);

    for (const p of PACKAGE_PATHS) {
      expect(await readPackageVersion(root, p)).toBe("1.2.3");
    }
    expect(await readSharedVersion(root)).toBe("1.2.3");
  });

  test("does not abort when the new version equals the current one", async () => {
    const root = await makeTempRoot();
    await Promise.all(PACKAGE_PATHS.map((p) => seedPackage(root, p)));
    await seedSharedVersion(root, "0.1.0");

    await applyReleaseVersion("0.1.0", root);

    expect(await readSharedVersion(root)).toBe("0.1.0");
  });

  test("rejects when MANGO_LSP_VERSION is missing from shared/src/index.ts", async () => {
    const root = await makeTempRoot();
    await Promise.all(PACKAGE_PATHS.map((p) => seedPackage(root, p)));
    const sharedPath = join(root, "packages", "shared", "src", "index.ts");
    await mkdir(dirname(sharedPath), { recursive: true });
    await writeFile(sharedPath, "export const OTHER = 'x';\n");

    await expect(applyReleaseVersion("1.0.0", root)).rejects.toThrow(
      "MANGO_LSP_VERSION was not found",
    );
  });

  test("dryRun logs intent and touches nothing", async () => {
    const root = await makeTempRoot();
    await Promise.all(PACKAGE_PATHS.map((p) => seedPackage(root, p)));
    await seedSharedVersion(root, "0.0.0");

    const logs: string[] = [];
    await applyReleaseVersion("9.9.9", root, { dryRun: true, log: (msg) => logs.push(msg) });

    for (const p of PACKAGE_PATHS) {
      expect(await readPackageVersion(root, p)).toBe("0.0.0");
    }
    expect(await readSharedVersion(root)).toBe("0.0.0");
    expect(logs).toEqual([
      `[dry-run] would apply version 9.9.9 to ${PACKAGE_PATHS.length} package manifests and runtime version`,
    ]);
  });

  test("updates optionalDependencies for native packages", async () => {
    const root = await makeTempRoot();
    await Promise.all(PACKAGE_PATHS.map((p) => seedPackage(root, p)));
    await seedSharedVersion(root, "0.0.0");

    const rootPackage = join(root, "package.json");
    const rootPkg = (await Bun.file(rootPackage).json()) as {
      optionalDependencies?: Record<string, string>;
    };
    rootPkg.optionalDependencies = Object.fromEntries(
      NATIVE_TARGETS.map((t) => [t.packageName, "0.0.0"]),
    );
    await writeFile(rootPackage, `${JSON.stringify(rootPkg, null, 2)}\n`);

    await applyReleaseVersion("2.0.0", root);

    const updated = (await Bun.file(rootPackage).json()) as {
      optionalDependencies: Record<string, string>;
    };
    expect(new Set(Object.values(updated.optionalDependencies))).toEqual(new Set(["2.0.0"]));
  });
});
