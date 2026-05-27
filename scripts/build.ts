import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  detectHostNativeTarget,
  getNativeTarget,
  NATIVE_TARGETS,
  type NativeTarget,
  type NativeTargetId,
  nativePackagesRoot,
  nativeTargetBinaryPath,
  nativeTargetIds,
} from "./native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");

export interface NativeBuildOutput {
  readonly target: NativeTarget;
  readonly path: string;
}

export interface BuildNativeOptions {
  readonly rootDir?: string;
  readonly outputRoot?: string;
  readonly targetIds?: readonly NativeTargetId[];
  readonly clean?: boolean;
}

/** Parse a comma-separated native target list and reject unknown ids.
 *
 * @example
 * parseTargetList("linux-x64,darwin-arm64")
 */
export function parseTargetList(value: string): NativeTargetId[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => {
      const target = getNativeTarget(id);
      if (target === undefined) {
        throw new Error(`unknown native target: ${id}`);
      }
      return target.id;
    });
}

function selectedTargets(
  targetIds: readonly NativeTargetId[] | undefined,
): readonly NativeTarget[] {
  if (targetIds === undefined) return NATIVE_TARGETS;
  return targetIds.map((id) => {
    const target = getNativeTarget(id);
    if (target === undefined) throw new Error(`unknown native target: ${id}`);
    return target;
  });
}

async function buildTarget(
  rootDir: string,
  outputRoot: string,
  target: NativeTarget,
): Promise<NativeBuildOutput> {
  const outputPath = nativeTargetBinaryPath(outputRoot, target);
  await mkdir(dirname(outputPath), { recursive: true });

  const result = await Bun.build({
    entrypoints: [resolve(rootDir, "apps", "cli", "src", "main.ts")],
    compile: {
      target: target.bunTarget,
      outfile: outputPath,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    minify: true,
    sourcemap: "none",
  });

  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`failed to build ${target.id}${messages === "" ? "" : `\n${messages}`}`);
  }

  if (target.platform !== "win32") {
    await chmod(outputPath, 0o755);
  }

  return { target, path: outputPath };
}

async function installToBin(
  rootDir: string,
  sourcePath: string,
  binaryName: string,
): Promise<void> {
  const dest = join(rootDir, "bin", binaryName);
  await mkdir(join(rootDir, "bin"), { recursive: true });
  await copyFile(sourcePath, dest);
  await chmod(dest, 0o755);
}

export async function buildNativeBinaries(
  options: BuildNativeOptions = {},
): Promise<NativeBuildOutput[]> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const outputRoot = options.outputRoot ?? nativePackagesRoot(rootDir);
  const targets = selectedTargets(options.targetIds);

  if (options.clean) {
    await Promise.all(
      targets.map((target) => rm(nativeTargetBinaryPath(outputRoot, target), { force: true })),
    );
  }

  const hostTarget = detectHostNativeTarget();
  const outputs: NativeBuildOutput[] = [];
  for (const target of targets) {
    const output = await buildTarget(rootDir, outputRoot, target);
    outputs.push(output);
    if (output.target.id === hostTarget?.id) {
      await installToBin(rootDir, output.path, output.target.binaryName);
    }
  }
  return outputs;
}

/** Render build CLI help with the supported native target ids.
 *
 * @example
 * help().includes("--target")
 */
export function help(): string {
  return `Usage: bun scripts/build.ts [options]

Build standalone mango-lsp binaries with Bun.

Options:
  --target <id>          Build one target. Can be repeated.
  --targets <ids>        Build comma-separated targets.
  --current              Build the current host target only.
  --output-root <path>   Write packages under this target root.
  --clean                Remove selected outputs before building.
  --list                 Print supported target ids.
  -h, --help             Show this help.

Targets:
${nativeTargetIds()
  .map((id) => `  ${id}`)
  .join("\n")}
`;
}

/** Parse build CLI flags into native build options.
 *
 * @example
 * cliOptions(["--target", "linux-x64"]).targetIds
 */
export function cliOptions(argv: readonly string[]): BuildNativeOptions | "help" | "list" {
  const targetIds: NativeTargetId[] = [];
  let outputRoot: string | undefined;
  let clean = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--list":
        return "list";
      case "--clean":
        clean = true;
        break;
      case "--current": {
        const target = detectHostNativeTarget();
        if (target === undefined) {
          throw new Error(`no configured native target for ${process.platform}/${process.arch}`);
        }
        targetIds.push(target.id);
        break;
      }
      case "--target": {
        const value = argv[index + 1];
        if (value === undefined) throw new Error("--target requires a value");
        index += 1;
        const target = getNativeTarget(value);
        if (target === undefined) throw new Error(`unknown native target: ${value}`);
        targetIds.push(target.id);
        break;
      }
      case "--targets": {
        const value = argv[index + 1];
        if (value === undefined) throw new Error("--targets requires a value");
        index += 1;
        targetIds.push(...parseTargetList(value));
        break;
      }
      case "--output-root": {
        const value = argv[index + 1];
        if (value === undefined) throw new Error("--output-root requires a value");
        index += 1;
        outputRoot = resolve(ROOT_DIR, value);
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return {
    clean,
    ...(outputRoot === undefined ? {} : { outputRoot }),
    ...(targetIds.length === 0 ? {} : { targetIds }),
  };
}

if (import.meta.main) {
  try {
    const options = cliOptions(process.argv.slice(2));
    if (options === "help") {
      process.stdout.write(help());
      process.exit(0);
    }
    if (options === "list") {
      process.stdout.write(`${nativeTargetIds().join("\n")}\n`);
      process.exit(0);
    }

    const outputs = await buildNativeBinaries(options);
    for (const output of outputs) {
      process.stdout.write(`built ${output.target.id}: ${output.path}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
