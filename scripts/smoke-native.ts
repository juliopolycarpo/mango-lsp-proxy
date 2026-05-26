import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detectHostNativeTarget,
  getNativeTarget,
  NATIVE_TARGETS,
  type NativeTarget,
  type NativeTargetId,
  nativePackagesRoot,
  nativeTargetBinaryPath,
} from "./native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");

export interface SmokeNativeOptions {
  readonly rootDir?: string;
  readonly outputRoot?: string;
  readonly targetIds?: readonly NativeTargetId[];
}

function expectedMagic(target: NativeTarget): Buffer {
  return target.platform === "win32" ? Buffer.from("MZ") : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
}

async function assertBinaryShape(path: string, target: NativeTarget): Promise<void> {
  const info = await stat(path);
  if (info.size === 0) throw new Error(`${path} is empty`);

  const bytes = await readFile(path);
  const magic = expectedMagic(target);
  if (!bytes.subarray(0, magic.length).equals(magic)) {
    throw new Error(`${path} does not look like a ${target.platform} executable`);
  }

  if (target.platform !== "win32") {
    await access(path, constants.X_OK);
  }
}

async function runHostBinary(path: string): Promise<void> {
  const proc = Bun.spawn([path, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`host binary exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (!stdout.includes("mango-lsp v")) {
    throw new Error(`host binary version output was unexpected: ${stdout.trim()}`);
  }
}

export async function smokeNativeBinaries(options: SmokeNativeOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const outputRoot = options.outputRoot ?? nativePackagesRoot(rootDir);
  const targets =
    options.targetIds?.map((id) => {
      const target = getNativeTarget(id);
      if (target === undefined) throw new Error(`unknown native target: ${id}`);
      return target;
    }) ?? NATIVE_TARGETS;

  const hostTarget = detectHostNativeTarget();
  for (const target of targets) {
    const path = nativeTargetBinaryPath(outputRoot, target);
    await assertBinaryShape(path, target);
    if (hostTarget?.id === target.id) {
      await runHostBinary(path);
    }
  }
}

function cliTargetIds(argv: readonly string[]): NativeTargetId[] | undefined {
  const targetIds: NativeTargetId[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--target requires a value");
      index += 1;
      const target = getNativeTarget(value);
      if (target === undefined) throw new Error(`unknown native target: ${value}`);
      targetIds.push(target.id);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return targetIds.length > 0 ? targetIds : undefined;
}

if (import.meta.main) {
  try {
    const targetIds = cliTargetIds(process.argv.slice(2));
    await smokeNativeBinaries(targetIds === undefined ? {} : { targetIds });
    process.stdout.write("native binary smoke checks passed\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
