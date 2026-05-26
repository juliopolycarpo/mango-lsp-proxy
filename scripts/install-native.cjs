const { chmodSync, copyFileSync, existsSync, mkdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");
const targetDataModule = require("./native-target-data.json");
const targetData = Array.isArray(targetDataModule) ? targetDataModule : targetDataModule.default;

function linuxLibc() {
  if (process.platform !== "linux") return undefined;
  const header = process.report?.getReport?.()?.header ?? {};
  return typeof header.glibcVersionRuntime === "string" ||
    typeof header.glibcVersionCompiler === "string"
    ? "glibc"
    : "musl";
}

function hostTarget() {
  const forced = process.env.MANGO_LSP_NATIVE_TARGET;
  if (forced !== undefined) return targetData.find((target) => target.id === forced);
  const libc = linuxLibc();
  return targetData.find(
    (target) =>
      target.platform === process.platform &&
      target.cpu === process.arch &&
      (target.platform !== "linux" || target.libc === libc),
  );
}

function nativePackageRoot(rootDir, target) {
  const localRequire = createRequire(join(rootDir, "package.json"));
  const packageJson = localRequire.resolve(`${target.packageName}/package.json`);
  return dirname(packageJson);
}

function nativeBinaryPath(rootDir, target) {
  const packageRoot = nativePackageRoot(rootDir, target);
  return join(packageRoot, "bin", target.binaryName);
}

function copyNativeBinary(rootDir, target, sourcePath) {
  const binDir = join(rootDir, "bin");
  const commandPath = join(binDir, "mango-lsp");
  mkdirSync(binDir, { recursive: true });
  copyFileSync(sourcePath, commandPath);
  chmodSync(commandPath, 0o755);

  if (target.platform !== "win32") return commandPath;
  copyFileSync(sourcePath, join(binDir, "mango-lsp.exe"));
  return commandPath;
}

function installNative(rootDir = resolve(__dirname, "..")) {
  const target = hostTarget();
  if (target === undefined) return undefined;

  const sourcePath = nativeBinaryPath(rootDir, target);
  if (!existsSync(sourcePath)) return undefined;

  return copyNativeBinary(rootDir, target, sourcePath);
}

if (require.main === module) {
  const target = hostTarget();
  if (target === undefined) {
    process.stdout.write(`mango-lsp: unsupported platform ${process.platform}/${process.arch}\n`);
    process.exit(0);
  }

  const commandPath = installNative();
  if (commandPath === undefined) {
    process.stdout.write(
      `mango-lsp: native binary not available for ${target.id}; skipping postinstall.\n`,
    );
    process.stdout.write(
      "Run `bun run build:current` to build the native binary for this platform.\n",
    );
    process.exit(0);
  }

  process.stdout.write(`installed mango-lsp native binary to ${commandPath}\n`);
}

module.exports = { hostTarget, installNative };
