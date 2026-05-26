import { join } from "node:path";

export type LinuxLibc = "glibc" | "musl";

export type NativeTargetId =
  | "windows-x64"
  | "windows-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl";

export interface NativeTarget {
  readonly id: NativeTargetId;
  readonly bunTarget:
    | "bun-windows-x64"
    | "bun-windows-arm64"
    | "bun-linux-x64"
    | "bun-linux-arm64"
    | "bun-linux-x64-musl"
    | "bun-linux-arm64-musl";
  readonly packageName: string;
  readonly platform: "win32" | "linux";
  readonly os: "win32" | "linux";
  readonly cpu: "x64" | "arm64";
  readonly libc?: LinuxLibc;
  readonly binaryName: "mango-lsp" | "mango-lsp.exe";
  readonly description: string;
}

export const NATIVE_TARGETS = [
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    packageName: "@mango-lsp/mango-lsp-proxy-windows-x64",
    platform: "win32",
    os: "win32",
    cpu: "x64",
    binaryName: "mango-lsp.exe",
    description: "Windows x64",
  },
  {
    id: "windows-arm64",
    bunTarget: "bun-windows-arm64",
    packageName: "@mango-lsp/mango-lsp-proxy-windows-arm64",
    platform: "win32",
    os: "win32",
    cpu: "arm64",
    binaryName: "mango-lsp.exe",
    description: "Windows ARM64",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    packageName: "@mango-lsp/mango-lsp-proxy-linux-x64",
    platform: "linux",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    binaryName: "mango-lsp",
    description: "Linux x64 glibc",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    packageName: "@mango-lsp/mango-lsp-proxy-linux-arm64",
    platform: "linux",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    binaryName: "mango-lsp",
    description: "Linux ARM64 glibc",
  },
  {
    id: "linux-x64-musl",
    bunTarget: "bun-linux-x64-musl",
    packageName: "@mango-lsp/mango-lsp-proxy-linux-x64-musl",
    platform: "linux",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    binaryName: "mango-lsp",
    description: "Linux x64 musl",
  },
  {
    id: "linux-arm64-musl",
    bunTarget: "bun-linux-arm64-musl",
    packageName: "@mango-lsp/mango-lsp-proxy-linux-arm64-musl",
    platform: "linux",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    binaryName: "mango-lsp",
    description: "Linux ARM64 musl",
  },
] as const satisfies readonly NativeTarget[];

export function nativeTargetIds(): NativeTargetId[] {
  return NATIVE_TARGETS.map((target) => target.id);
}

export function getNativeTarget(id: string): NativeTarget | undefined {
  return NATIVE_TARGETS.find((target) => target.id === id);
}

export function nativePackagesRoot(rootDir: string): string {
  return join(rootDir, "packages", "native");
}

export function nativeTargetPackageDir(rootDir: string, target: NativeTarget): string {
  return join(nativePackagesRoot(rootDir), target.id);
}

export function nativeTargetBinaryPath(outputRoot: string, target: NativeTarget): string {
  return join(outputRoot, target.id, "bin", target.binaryName);
}

export function detectLinuxLibcFromReport(report: unknown): LinuxLibc {
  if (typeof report !== "object" || report === null) return "musl";
  const header = "header" in report ? report.header : undefined;
  if (typeof header !== "object" || header === null) return "musl";
  const glibcRuntime = "glibcVersionRuntime" in header ? header.glibcVersionRuntime : undefined;
  const glibcCompiler = "glibcVersionCompiler" in header ? header.glibcVersionCompiler : undefined;
  return typeof glibcRuntime === "string" || typeof glibcCompiler === "string" ? "glibc" : "musl";
}

export function detectHostLinuxLibc(): LinuxLibc {
  return detectLinuxLibcFromReport(process.report?.getReport?.());
}

export function detectHostNativeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  libc: LinuxLibc = detectHostLinuxLibc(),
): NativeTarget | undefined {
  return NATIVE_TARGETS.find(
    (target) =>
      target.platform === platform &&
      target.cpu === arch &&
      (target.platform !== "linux" || target.libc === libc),
  );
}
