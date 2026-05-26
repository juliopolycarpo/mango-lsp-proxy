import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
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
  installNative(rootDir: string): string;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return (await Bun.file(path).json()) as PackageJson;
}

function expectedNativeDescription(target: NativeTarget): string {
  return `Native mango-lsp binary for ${target.description}.`;
}

describe("native package publishing metadata", () => {
  test("root package exposes the native bin path and optional native packages", async () => {
    const pkg = await readPackageJson(join(ROOT_DIR, "package.json"));

    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("MIT");
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
    expect(pkg.scripts?.prepack).toBe("bun run build:current");
    expect(pkg.publishConfig).toEqual({ access: "public" });

    const optionalDependencies = pkg.optionalDependencies ?? {};
    expect(Object.keys(optionalDependencies).sort()).toEqual(
      NATIVE_TARGETS.map((target) => target.packageName).sort(),
    );
    for (const target of NATIVE_TARGETS) {
      expect(optionalDependencies[target.packageName]).toBe(pkg.version);
    }
  });

  test("native package manifests match the target matrix", async () => {
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
      const targetLibc = "libc" in target ? target.libc : undefined;
      if (targetLibc === undefined) {
        expect(pkg.libc).toBeUndefined();
      } else {
        expect(pkg.libc).toBe(targetLibc);
      }
    }
  });

  test("postinstall copies the selected native executable into the package bin", async () => {
    const installer = require("../scripts/install-native.cjs") as NativeInstaller;
    const target = installer.hostTarget();
    if (target === undefined) throw new Error("host target should be configured");

    const rootDir = await mkdtemp(join(tmpdir(), "mango-native-install-"));
    const packageRoot = join(rootDir, "node_modules", ...target.packageName.split("/"));
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await Bun.write(join(rootDir, "package.json"), "{}\n");
    await Bun.write(join(packageRoot, "package.json"), `{"name":"${target.packageName}"}\n`);

    const fakeBinary = join(packageRoot, "bin", target.binaryName);
    await Bun.write(fakeBinary, '#!/bin/sh\necho "fake native $*"\n');
    await chmod(fakeBinary, 0o755);

    const commandPath = installer.installNative(rootDir);
    expect(commandPath).toBe(join(rootDir, "bin", "mango-lsp"));
    expect(await readFile(commandPath, "utf8")).toBe(await readFile(fakeBinary, "utf8"));

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
});
