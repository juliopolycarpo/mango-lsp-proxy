import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostNativeTarget } from "../native-targets";

const require = createRequire(import.meta.url);

interface NativeInstaller {
  hostTarget(): { id: string; packageName: string; binaryName: string } | undefined;
  installNative(rootDir: string): string | undefined;
}

function loadInstaller(): NativeInstaller {
  return require("../install-native.cjs") as NativeInstaller;
}

async function fakePackageRoot(
  rootDir: string,
  target: { packageName: string; binaryName: string },
): Promise<string> {
  const segments = target.packageName.split("/");
  const packageRoot = join(rootDir, "node_modules", ...segments);
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: target.packageName }));
  return packageRoot;
}

async function writeFakeBinary(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\necho "fake native $*"\n');
  await chmod(path, 0o755);
}

describe("install-native.cjs", () => {
  let installer: NativeInstaller;
  let tmpDir: string;

  beforeEach(async () => {
    installer = loadInstaller();
    tmpDir = await mkdtemp(join(tmpdir(), "mango-install-"));
    await writeFile(join(tmpDir, "package.json"), "{}");
  });

  describe("installNative", () => {
    test("copies the native binary into bin/ when the source exists", async () => {
      const host = detectHostNativeTarget();
      if (host === undefined) throw new Error("host target should be configured");

      const packageRoot = await fakePackageRoot(tmpDir, host);
      await writeFakeBinary(join(packageRoot, "bin", host.binaryName));

      const commandPath = installer.installNative(tmpDir);
      expect(commandPath).toBe(join(tmpDir, "bin", "mango-lsp"));
    });

    test("returns undefined when the native binary is missing", async () => {
      const host = detectHostNativeTarget();
      if (host === undefined) throw new Error("host target should be configured");

      await fakePackageRoot(tmpDir, host);
      // intentionally skip creating the binary

      const commandPath = installer.installNative(tmpDir);
      expect(commandPath).toBeUndefined();
    });
  });

  describe("CLI entrypoint", () => {
    async function copyScriptToTmp(): Promise<string> {
      const scriptDir = join(tmpDir, "scripts");
      await mkdir(scriptDir, { recursive: true });
      const scriptSrc = join(import.meta.dir, "../install-native.cjs");
      const dataSrc = join(import.meta.dir, "../native-target-data.json");
      await copyFile(scriptSrc, join(scriptDir, "install-native.cjs"));
      await copyFile(dataSrc, join(scriptDir, "native-target-data.json"));
      return scriptDir;
    }

    test("exits 0 and prints a hint when the binary is missing", async () => {
      const host = detectHostNativeTarget();
      if (host === undefined) throw new Error("host target should be configured");

      await fakePackageRoot(tmpDir, host);
      // binary intentionally missing
      const scriptDir = await copyScriptToTmp();

      const proc = Bun.spawn({
        cmd: ["node", join(scriptDir, "install-native.cjs")],
        env: { ...process.env, MANGO_LSP_NATIVE_TARGET: host.id },
        stdout: "pipe",
        stderr: "pipe",
      });

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

      const proc = Bun.spawn({
        cmd: ["node", join(scriptDir, "install-native.cjs")],
        env: { ...process.env, MANGO_LSP_NATIVE_TARGET: "unsupported-fake-id" },
        stdout: "pipe",
        stderr: "pipe",
      });

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

      const packageRoot = await fakePackageRoot(tmpDir, host);
      await writeFakeBinary(join(packageRoot, "bin", host.binaryName));
      const scriptDir = await copyScriptToTmp();

      const proc = Bun.spawn({
        cmd: ["node", join(scriptDir, "install-native.cjs")],
        env: { ...process.env, MANGO_LSP_NATIVE_TARGET: host.id },
        stdout: "pipe",
        stderr: "pipe",
      });

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
