import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_TARGETS,
  type NativeTarget,
  nativeTargetPackageDir,
} from "../scripts/native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");

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

async function readPackageJson(path: string): Promise<PackageJson> {
  return (await Bun.file(path).json()) as PackageJson;
}

function expectedNativeDescription(target: NativeTarget): string {
  return `Native mango-lsp binary for ${target.description}.`;
}

describe("native package publishing metadata", () => {
  test("root package exposes the mango-lsp launcher and optional native packages", async () => {
    const pkg = await readPackageJson(join(ROOT_DIR, "package.json"));

    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin).toEqual({ "mango-lsp": "./bin/mango-lsp" });
    expect(pkg.files).toEqual(["bin/", "LICENSE", "README.md"]);
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
    for (const target of NATIVE_TARGETS) {
      const pkg = await readPackageJson(
        join(nativeTargetPackageDir(ROOT_DIR, target), "package.json"),
      );

      expect(pkg.name).toBe(target.packageName);
      expect(pkg.version).toBe("0.1.0");
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

  test("launcher delegates to the selected native executable", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error("node is required to exercise the npm launcher");
    }

    const cwd = await mkdtemp(join(tmpdir(), "mango-launcher-"));
    const fakeBinary = join(cwd, "fake-mango-lsp");
    await Bun.write(
      fakeBinary,
      '#!/usr/bin/env node\nconsole.log("fake native " + process.argv.slice(2).join(" "));\n',
    );
    await chmod(fakeBinary, 0o755);

    const proc = Bun.spawn([node, join(ROOT_DIR, "bin", "mango-lsp"), "--version"], {
      env: {
        ...process.env,
        MANGO_LSP_NATIVE_PATH: fakeBinary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
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
