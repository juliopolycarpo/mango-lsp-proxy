import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_TARGETS,
  type NativeTarget,
  nativeTargetPackageDir,
} from "../scripts/native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);

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

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly bin?: Record<string, string>;
  readonly files?: string[];
  readonly optionalDependencies?: Record<string, string>;
  readonly os?: string[];
  readonly cpu?: string[];
  readonly libc?: string;
  readonly scripts?: Record<string, string>;
  readonly publishConfig?: Record<string, string>;
}

interface NativeInstaller {
  hostTarget(): NativeTarget | undefined;
  installNative(rootDir: string): string | undefined;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return (await Bun.file(path).json()) as PackageJson;
}

function expectedNativeDescription(target: NativeTarget): string {
  return `Native mango-lsp binary for ${target.description}.`;
}

/* ─── setup helpers ─── */

async function createFakeNativePackage(rootDir: string, target: NativeTarget): Promise<string> {
  const dir = join(rootDir, "node_modules", ...target.packageName.split("/"));
  await mkdir(join(dir, "bin"), { recursive: true });
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: target.packageName }));
  return dir;
}

async function writeFakeBinary(dir: string, target: NativeTarget): Promise<string> {
  const path = join(dir, "bin", target.binaryName);
  await Bun.write(path, `#!/bin/sh\necho "fake native $*"\n`);
  await chmod(path, 0o755);
  return path;
}

/* ─── tests ─── */

describe("native package publishing metadata", () => {
  describe("root package", () => {
    test("declares the native bin entry, optional deps, and postinstall", async () => {
      const pkg = await readPackageJson(join(ROOT_DIR, "package.json"));

      expect(pkg.private).toBe(false);
      expect(pkg.license).toBe("MIT");
      expect(pkg.publishConfig).toEqual({ access: "public" });
      expect(pkg.bin).toEqual({ "mango-lsp": "./bin/mango-lsp" });
      expect(pkg.files).toEqual([
        "bin/",
        "install/",
        "CHANGELOG.md",
        "LICENSE",
        "README.md",
        "scripts/install-native.cjs",
        "scripts/native-target-data.json",
      ]);
      expect(pkg.scripts?.postinstall).toBe(
        "node scripts/install-native.cjs || bun scripts/install-native.cjs",
      );

      const deps = pkg.optionalDependencies ?? {};
      expect(Object.keys(deps).sort()).toEqual(NATIVE_TARGETS.map((t) => t.packageName).sort());
      for (const target of NATIVE_TARGETS) {
        expect(deps[target.packageName]).toBe(pkg.version);
      }
    });
  });

  describe("native package manifests", () => {
    test("each native target has consistent metadata", async () => {
      const rootPkg = await readPackageJson(join(ROOT_DIR, "package.json"));

      for (const target of NATIVE_TARGETS) {
        const pkg = await readPackageJson(
          join(nativeTargetPackageDir(ROOT_DIR, target), "package.json"),
        );

        expect(pkg.name).toBe(target.packageName);
        expect(pkg.version).toBe(rootPkg.version);
        expect(pkg.private).toBe(false);
        expect(pkg.description).toBe(expectedNativeDescription(target));
        expect(pkg.license).toBe("MIT");
        expect(pkg.os).toEqual([target.os]);
        expect(pkg.cpu).toEqual([target.cpu]);
        expect(pkg.files).toEqual(["bin/"]);
        expect(pkg.scripts?.prepack).toBe(`bun ../../../scripts/build.ts --target ${target.id}`);
        expect(pkg.publishConfig).toEqual({ access: "public" });

        const expectedLibc = "libc" in target ? target.libc : undefined;
        expect((pkg as unknown as Record<string, unknown>).libc).toBe(expectedLibc);
      }
    });
  });
});

describe("postinstall binary copy", () => {
  test("copies the native binary from the optional dep into the package bin", async () => {
    const installer = require("../scripts/install-native.cjs") as NativeInstaller;
    const target = installer.hostTarget();
    if (target === undefined) throw new Error("host target should be configured");

    const rootDir = await makeTemp("mango-install-");
    await Bun.write(join(rootDir, "package.json"), "{}\n");

    const pkgDir = await createFakeNativePackage(rootDir, target);
    const fakeBinary = await writeFakeBinary(pkgDir, target);

    const commandPath = installer.installNative(rootDir);
    expect(commandPath).toBe(join(rootDir, "bin", "mango-lsp"));
    if (commandPath === undefined) throw new Error("installNative should return a path");

    expect(await readFile(commandPath, "utf8")).toEqual(await readFile(fakeBinary, "utf8"));

    const proc = Bun.spawn([commandPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe("fake native --version\n");
  });

  test("returns undefined when the native binary file is missing", async () => {
    const installer = require("../scripts/install-native.cjs") as NativeInstaller;
    const target = installer.hostTarget();
    if (target === undefined) throw new Error("host target should be configured");

    const rootDir = await makeTemp("mango-install-");
    await Bun.write(join(rootDir, "package.json"), "{}\n");
    await createFakeNativePackage(rootDir, target);

    expect(installer.installNative(rootDir)).toBeUndefined();
  });

  test("returns undefined when no native package is installed at all", async () => {
    const installer = require("../scripts/install-native.cjs") as NativeInstaller;

    const rootDir = await makeTemp("mango-install-");
    await Bun.write(join(rootDir, "package.json"), "{}\n");

    expect(installer.installNative(rootDir)).toBeUndefined();
  });
});
