import { resolve } from "node:path";
import rootManifest from "../package.json";
import {
  getNativeTarget,
  NATIVE_TARGETS,
  type NativeTarget,
  type NativeTargetId,
  nativeTargetPackageDir,
} from "./native-targets";

const ROOT_DIR = resolve(import.meta.dir, "..");
const ROOT_PACKAGE_NAME: string = rootManifest.name;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2_000;

/** Outcome of a single `npm publish` invocation. */
export type PublishStatus = "published" | "already-published";

export interface PublishablePackage {
  /** npm package name, used for logging and recovery output. */
  readonly name: string;
  /** Directory passed to `npm publish`. */
  readonly dir: string;
}

interface RetryOptions {
  readonly attempts: number;
  readonly backoffMs: number;
}

interface PublishDeps {
  /** Publish one package. Resolves with a status; throws on a retryable failure. */
  readonly publish: (pkg: PublishablePackage) => Promise<PublishStatus>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

export interface PublishPackagesOptions {
  readonly npmTag: string;
  readonly rootDir?: string;
  readonly targetIds?: readonly NativeTargetId[];
  readonly attempts?: number;
  readonly backoffMs?: number;
  readonly publish?: (pkg: PublishablePackage) => Promise<PublishStatus>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly dryRun?: boolean;
  /** Enable npm --provenance (default: true when CI env var is set). */
  readonly provenance?: boolean;
}

export interface PublishPackagesResult {
  /** Packages now live on npm, in publish order (includes idempotent skips). */
  readonly published: readonly string[];
}

const NPM_DUPLICATE_SIGNATURES = [
  "previously published versions",
  "cannot publish over",
  "epublishconflict",
];

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Report whether npm rejected a publish because the version already exists.
 *
 * Usage: isAlreadyPublished(stderr) === true // safe to skip on a re-run
 */
export function isAlreadyPublished(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return NPM_DUPLICATE_SIGNATURES.some((signature) => haystack.includes(signature));
}

function selectTargets(targetIds: readonly NativeTargetId[] | undefined): readonly NativeTarget[] {
  if (targetIds === undefined) return NATIVE_TARGETS;
  return targetIds.map((id) => {
    const target = getNativeTarget(id);
    if (target === undefined) throw new Error(`unknown native target: ${id}`);
    return target;
  });
}

function publishOrder(
  rootDir: string,
  targetIds: readonly NativeTargetId[] | undefined,
): PublishablePackage[] {
  const natives = selectTargets(targetIds).map((target) => ({
    name: target.packageName,
    dir: nativeTargetPackageDir(rootDir, target),
  }));
  return [...natives, { name: ROOT_PACKAGE_NAME, dir: rootDir }];
}

/** Build the npm publish command, adding --provenance only when requested. */
export function buildNpmPublishArgs(
  pkg: PublishablePackage,
  tag: string,
  provenance: boolean,
): string[] {
  const args = ["npm", "publish", pkg.dir, "--access", "public", "--tag", tag];
  if (provenance) args.push("--provenance");
  return args;
}

/** Default CI detection used when the caller does not explicitly set `provenance`. */
export function detectCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true";
}

async function runNpmPublish(
  pkg: PublishablePackage,
  tag: string,
  provenance: boolean,
): Promise<PublishStatus> {
  const args = buildNpmPublishArgs(pkg, tag, provenance);
  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  process.stderr.write(stderr);

  if (code === 0) return "published";
  if (isAlreadyPublished(stderr)) return "already-published";
  throw new Error(`npm publish failed for ${pkg.name} (exit ${code})`);
}

async function attemptPublish(
  pkg: PublishablePackage,
  deps: PublishDeps,
  retry: RetryOptions,
): Promise<PublishStatus> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await deps.publish(pkg);
    } catch (error) {
      lastError = error;
      deps.log(
        `attempt ${attempt}/${retry.attempts} failed for ${pkg.name}: ${errorMessage(error)}`,
      );
      if (attempt >= retry.attempts) break;
      const delay = retry.backoffMs * 2 ** (attempt - 1);
      deps.log(`retrying ${pkg.name} in ${delay}ms`);
      await deps.sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function logRecovery(
  log: (line: string) => void,
  order: readonly PublishablePackage[],
  published: readonly string[],
  failed: PublishablePackage,
): void {
  const names = order.map((pkg) => pkg.name);
  const notAttempted = names.slice(names.indexOf(failed.name) + 1);
  const section = (title: string, entries: readonly string[]): void => {
    log(`${title}:`);
    if (entries.length === 0) log("  (none)");
    for (const entry of entries) log(`  - ${entry}`);
  };

  log(`npm publish failed at ${failed.name}.`);
  section("already published (live on npm)", published);
  section("failed", [failed.name]);
  section("not attempted", notAttempted);
  log("Re-run the release to continue: already-published versions are detected and skipped.");
}

/** Publish every native package, then the root package last, with retries and recovery logging.
 *
 * Usage: await publishPackages({ npmTag: "latest" })
 */
async function dryRunPublish(
  pkg: PublishablePackage,
  log: (line: string) => void,
): Promise<PublishStatus> {
  log(`[dry-run] would publish ${pkg.name} (${pkg.dir})`);
  return "published";
}

export async function publishPackages(
  options: PublishPackagesOptions,
): Promise<PublishPackagesResult> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const retry: RetryOptions = {
    attempts: options.attempts ?? DEFAULT_ATTEMPTS,
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));

  if (options.dryRun) {
    log("[dry-run] skipping npm publish for all packages");
  }

  const useProvenance = options.provenance ?? detectCi();
  const deps: PublishDeps = {
    publish: options.dryRun
      ? (pkg) => dryRunPublish(pkg, log)
      : (options.publish ?? ((pkg) => runNpmPublish(pkg, options.npmTag, useProvenance))),
    sleep: options.sleep ?? sleep,
    log,
  };

  const order = publishOrder(rootDir, options.targetIds);
  const published: string[] = [];

  for (const pkg of order) {
    let status: PublishStatus;
    try {
      status = await attemptPublish(pkg, deps, retry);
    } catch (error) {
      logRecovery(deps.log, order, published, pkg);
      throw error;
    }
    published.push(pkg.name);
    deps.log(
      status === "already-published"
        ? `skipped ${pkg.name} (already published at this version)`
        : `published ${pkg.name}`,
    );
  }

  deps.log(`published ${published.length} package(s): ${published.join(", ")}`);
  return { published };
}

/** Parse a positive integer CLI option value.
 *
 * @example
 * parsePositiveInt("--attempts", "3") === 3
 */
export function parsePositiveInt(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

/** Parse npm publishing CLI flags into publish options.
 *
 * @example
 * cliOptions(["--tag", "latest", "--dry-run"]).dryRun
 */
export function cliOptions(argv: readonly string[]): PublishPackagesOptions {
  let npmTag: string | undefined;
  let attempts: number | undefined;
  let backoffMs: number | undefined;
  let dryRun = false;
  let provenance: boolean | undefined;
  const targetIds: NativeTargetId[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--tag":
        if (next === undefined) throw new Error("--tag requires a value");
        npmTag = next;
        index += 1;
        break;
      case "--attempts":
        attempts = parsePositiveInt("--attempts", next);
        index += 1;
        break;
      case "--backoff-ms":
        backoffMs = parsePositiveInt("--backoff-ms", next);
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--provenance":
        provenance = true;
        break;
      case "--no-provenance":
        provenance = false;
        break;
      case "--target": {
        const target = next === undefined ? undefined : getNativeTarget(next);
        if (target === undefined) throw new Error(`unknown native target: ${next}`);
        targetIds.push(target.id);
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (npmTag === undefined)
    throw new Error(
      "usage: bun scripts/publish-packages.ts --tag <npm-tag> [--dry-run] [--provenance | --no-provenance]",
    );
  return {
    npmTag,
    dryRun,
    ...(provenance === undefined ? {} : { provenance }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(backoffMs === undefined ? {} : { backoffMs }),
    ...(targetIds.length === 0 ? {} : { targetIds }),
  };
}

if (import.meta.main) {
  try {
    await publishPackages(cliOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  }
}
