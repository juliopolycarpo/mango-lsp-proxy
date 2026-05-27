#!/usr/bin/env bun
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..");
const CHANGELOG_PATH = "CHANGELOG.md";
const CLI_PATH = join(ROOT_DIR, "node_modules", ".bin", executableName());
const RELEASE_NOTES_PATH = "dist/release/release-notes.md";
const RELEASE_ASSETS_PATH = "dist/release/release-assets.md";

export type ChangelogCommand = "write" | "check" | "release-notes";

interface BaseChangelogOptions {
  readonly command: ChangelogCommand;
  readonly outputPath: string;
}

interface ReleaseNotesOptions extends BaseChangelogOptions {
  readonly command: "release-notes";
  readonly tag: string;
  readonly assetsPath: string;
}

type WriteOptions = BaseChangelogOptions & { readonly command: "write" };
type CheckOptions = BaseChangelogOptions & { readonly command: "check" };

export type ChangelogOptions = CheckOptions | ReleaseNotesOptions | WriteOptions;

interface RawReleaseFlags {
  readonly assetsPath?: string;
  readonly tag: string | undefined;
}

type ParsedReleaseFlags = Pick<ReleaseNotesOptions, "assetsPath" | "tag">;

/** Parse changelog CLI arguments.
 *
 * Example: parseChangelogArgs(["release-notes", "--tag", "0.1"]).tag === "0.1"
 */
export function parseChangelogArgs(argv: readonly string[]): ChangelogOptions {
  const command = parseCommand(argv[0]);
  if (command === "check") return { command, outputPath: "" };

  const outputPath = flagValue(argv, "--output") ?? defaultOutput(command);
  if (command === "write") return { command, outputPath };

  const tag = flagValue(argv, "--tag");
  const assetsPath = flagValue(argv, "--assets") ?? RELEASE_ASSETS_PATH;
  const flags = releaseFlags({ tag, assetsPath });
  return { command, outputPath, ...flags };
}

/** Compose GitHub release notes from git-cliff changes and asset metadata.
 *
 * Example: releaseNotesContent("## 0.1", "## Assets").includes("## Assets")
 */
export function releaseNotesContent(changes: string, assets: string): string {
  const parts = [changes.trim(), assets.trim()].filter((part) => part.length > 0);
  return `${parts.join("\n\n")}\n`;
}

function parseCommand(value: string | undefined): ChangelogCommand {
  if (value === "write" || value === "check" || value === "release-notes") return value;
  throw new Error("usage: bun scripts/changelog.ts <write|check|release-notes>");
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function defaultOutput(command: ChangelogCommand): string {
  if (command === "release-notes") return RELEASE_NOTES_PATH;
  return CHANGELOG_PATH;
}

function executableName(): string {
  return process.platform === "win32" ? "git-cliff.cmd" : "git-cliff";
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}

function releaseFlags(flags: RawReleaseFlags): ParsedReleaseFlags {
  if (isBlank(flags.tag)) {
    throw new Error("usage: bun scripts/changelog.ts release-notes --tag <tag>");
  }
  return { assetsPath: flags.assetsPath ?? RELEASE_ASSETS_PATH, tag: flags.tag };
}

async function runGitCliff(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn([CLI_PATH, ...args], {
    cwd: ROOT_DIR,
    stderr: "inherit",
    stdout: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git-cliff failed with exit ${code}`);
}

async function runDprint(path: string): Promise<void> {
  const proc = Bun.spawn(["bunx", "dprint", "fmt", "--allow-no-files", path], {
    cwd: ROOT_DIR,
    stderr: "inherit",
    stdout: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`dprint failed with exit ${code}`);
}

function changelogArgs(outputPath: string): string[] {
  return ["--config", "cliff.toml", "--output", outputPath];
}

function releaseArgs(tag: string, outputPath: string): string[] {
  return [
    "--config",
    "cliff.toml",
    "--current",
    "--tag",
    tag,
    "--strip",
    "header",
    "--output",
    outputPath,
  ];
}

async function writeChangelog(outputPath: string): Promise<void> {
  await runGitCliff(changelogArgs(outputPath));
  await runDprint(outputPath);
}

async function checkChangelogConfig(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mango-lsp-changelog-"));
  try {
    await runGitCliff(changelogArgs(join(dir, "CHANGELOG.md")));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function writeReleaseNotes(options: ReleaseNotesOptions): Promise<void> {
  const changesPath = join(ROOT_DIR, "dist", "release", "release-changes.md");
  await runGitCliff(releaseArgs(options.tag, changesPath));
  const changes = await readFile(changesPath, "utf8");
  const assets = await readFile(resolve(ROOT_DIR, options.assetsPath), "utf8");
  const outputPath = resolve(ROOT_DIR, options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, releaseNotesContent(changes, assets));
  await runDprint(outputPath);
}

export async function runChangelog(options: ChangelogOptions): Promise<void> {
  if (options.command === "write") return writeChangelog(options.outputPath);
  if (options.command === "check") return checkChangelogConfig();
  return writeReleaseNotes(options);
}

if (import.meta.main) {
  try {
    await runChangelog(parseChangelogArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
