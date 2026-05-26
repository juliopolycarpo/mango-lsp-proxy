import { join } from "node:path";
import targetData from "./native-target-data.json";

export type LinuxLibc = "glibc" | "musl";

export type NativeTargetId =
  | "windows-x64"
  | "windows-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "darwin-x64"
  | "darwin-arm64";

export interface NativeTarget {
  readonly id: NativeTargetId;
  readonly bunTarget:
    | "bun-windows-x64"
    | "bun-windows-arm64"
    | "bun-linux-x64"
    | "bun-linux-arm64"
    | "bun-linux-x64-musl"
    | "bun-linux-arm64-musl"
    | "bun-darwin-x64"
    | "bun-darwin-arm64";
  readonly packageName: string;
  readonly platform: "win32" | "linux" | "darwin";
  readonly os: "win32" | "linux" | "darwin";
  readonly cpu: "x64" | "arm64";
  readonly libc?: LinuxLibc;
  readonly binaryName: "mango-lsp" | "mango-lsp.exe";
  readonly description: string;
}

export const NATIVE_TARGETS = targetData as readonly NativeTarget[];

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
