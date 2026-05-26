import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
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

async function writePackage(rootDir: string, path: string): Promise<void> {
  const fullPath = join(rootDir, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, '{"version":"0.0.0"}\n');
}

describe("release version application", () => {
  test("updates package manifests and runtime version", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mango-release-version-"));
    await Promise.all(PACKAGE_PATHS.map((path) => writePackage(rootDir, path)));

    const rootPackage = join(rootDir, "package.json");
    await Bun.write(
      rootPackage,
      JSON.stringify({
        version: "0.0.0",
        optionalDependencies: Object.fromEntries(
          NATIVE_TARGETS.map((target) => [target.packageName, "0.0.0"]),
        ),
      }),
    );

    const sharedPath = join(rootDir, "packages", "shared", "src", "index.ts");
    await mkdir(dirname(sharedPath), { recursive: true });
    await Bun.write(sharedPath, 'export const MANGO_LSP_VERSION = "0.0.0" as const;\n');

    await applyReleaseVersion("1.2.3-pre", rootDir);

    const updatedRoot = (await Bun.file(rootPackage).json()) as {
      version: string;
      optionalDependencies: Record<string, string>;
    };
    expect(updatedRoot.version).toBe("1.2.3-pre");
    expect(new Set(Object.values(updatedRoot.optionalDependencies))).toEqual(
      new Set(["1.2.3-pre"]),
    );
    expect(await Bun.file(sharedPath).text()).toContain('"1.2.3-pre"');
  });

  test("dryRun logs intent without rewriting files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mango-release-version-"));
    await Promise.all(PACKAGE_PATHS.map((path) => writePackage(rootDir, path)));

    const rootPackage = join(rootDir, "package.json");
    const sharedPath = join(rootDir, "packages", "shared", "src", "index.ts");
    await mkdir(dirname(sharedPath), { recursive: true });
    await Bun.write(sharedPath, 'export const MANGO_LSP_VERSION = "0.0.0" as const;\n');

    const logs: string[] = [];
    await applyReleaseVersion("9.9.9", rootDir, { dryRun: true, log: (msg) => logs.push(msg) });

    // Package files untouched
    const rootJson = (await Bun.file(rootPackage).json()) as { version: string };
    expect(rootJson.version).toBe("0.0.0");

    // Shared version untouched
    expect(await Bun.file(sharedPath).text()).toBe(
      'export const MANGO_LSP_VERSION = "0.0.0" as const;\n',
    );

    // Intent was logged
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("9.9.9");
    expect(logs[0]).toContain("dry-run");
  });
});
