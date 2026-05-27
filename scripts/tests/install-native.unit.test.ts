import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostNativeTarget } from "../native-targets";

const require = createRequire(import.meta.url);

interface NativeInstaller {
  hostTarget(): { id: string; packageName: string; binaryName: string } | undefined;
  installNative(rootDir: string): string | undefined;
}

interface NativeTargetShape {
  readonly packageName: string;
  readonly binaryName: string;
}

const installer = require("../install-native.cjs") as NativeInstaller;
const CONTENT = '#!/bin/sh\necho "fake binary $*"\n';

async function fakePackageRoot(rootDir: string, target: NativeTargetShape): Promise<string> {
  const dir = join(rootDir, "node_modules", ...target.packageName.split("/"));
  await mkdir(join(dir, "bin"), { recursive: true });
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: target.packageName }));
  return dir;
}

async function writeFakeBinary(dir: string, binaryName: string): Promise<string> {
  const path = join(dir, "bin", binaryName);
  await Bun.write(path, CONTENT);
  await chmod(path, 0o755);
  return path;
}

describe("install-native.cjs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mango-install-"));
    await Bun.write(join(tmpDir, "package.json"), "{}");
  });

  describe("installNative", () => {
    const host = detectHostNativeTarget();

    test("copies the native binary into bin/ when the source exists", async () => {
      if (host === undefined) throw new Error("host target should be configured");
      const pkgDir = await fakePackageRoot(tmpDir, host);
      await writeFakeBinary(pkgDir, host.binaryName);

      const commandPath = installer.installNative(tmpDir);
      expect(commandPath).toBe(join(tmpDir, "bin", "mango-lsp"));
      if (commandPath === undefined) throw new Error("installNative should return a path");
      expect(await Bun.file(commandPath).text()).toBe(CONTENT);
    });

    test("returns undefined when the native binary file is missing", async () => {
      if (host === undefined) throw new Error("host target should be configured");
      await fakePackageRoot(tmpDir, host);

      expect(installer.installNative(tmpDir)).toBeUndefined();
    });
  });

  describe("CLI entrypoint", () => {
    async function copyScriptToTmp(): Promise<string> {
      const scriptDir = join(tmpDir, "scripts");
      await mkdir(scriptDir, { recursive: true });
      await copyFile(
        join(import.meta.dir, "../install-native.cjs"),
        join(scriptDir, "install-native.cjs"),
      );
      await copyFile(
        join(import.meta.dir, "../native-target-data.json"),
        join(scriptDir, "native-target-data.json"),
      );
      return scriptDir;
    }

    function spawn(scriptDir: string, env: Record<string, string>) {
      return Bun.spawn({
        cmd: ["node", join(scriptDir, "install-native.cjs")],
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    test("exits 0 and prints a hint when the binary is missing", async () => {
      const host = detectHostNativeTarget();
      if (host === undefined) throw new Error("host target should be configured");
      await fakePackageRoot(tmpDir, host);

      const scriptDir = await copyScriptToTmp();
      const proc = spawn(scriptDir, { MANGO_LSP_NATIVE_TARGET: host.id });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("skipping postinstall");
      expect(stdout).toContain("bun run build:current");
    });

    test("exits 0 with a message for unsupported platforms", async () => {
      const scriptDir = await copyScriptToTmp();
      const proc = spawn(scriptDir, { MANGO_LSP_NATIVE_TARGET: "unsupported-fake-id" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("unsupported platform");
    });

    test("exits 0 and prints the installed path on success", async () => {
      const host = detectHostNativeTarget();
      if (host === undefined) throw new Error("host target should be configured");
      const pkgDir = await fakePackageRoot(tmpDir, host);
      await writeFakeBinary(pkgDir, host.binaryName);

      const scriptDir = await copyScriptToTmp();
      const proc = spawn(scriptDir, { MANGO_LSP_NATIVE_TARGET: host.id });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("installed mango-lsp native binary to");
      expect(stdout).toContain(join(tmpDir, "bin", "mango-lsp"));
    });
  });
});
