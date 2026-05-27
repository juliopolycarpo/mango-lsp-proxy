import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGhReleaseArgs, expandAssetPaths, formatGhCommand, runRelease } from "../release";

/* ─── helpers ─── */

function makeFakeApplyVersion() {
  const calls: { version: string; rootDir: string; dryRun: boolean }[] = [];
  const fn = async (version: string, rootDir: string, opts: { dryRun: boolean }) => {
    calls.push({ version, rootDir, dryRun: opts.dryRun });
  };
  return { fn, calls };
}

function captureStdout() {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

const baseOptions = {
  dryRun: true,
  skipCheck: true,
  skipTests: true,
  skipBuild: true,
  skipSmoke: true,
  skipArtifacts: true,
  skipReleaseNotes: true,
  skipPublish: true,
} as const;

/* ─── unit tests for helpers ─── */

describe("buildGhReleaseArgs", () => {
  test("adds --latest for stable releases", () => {
    const args = buildGhReleaseArgs("0.2.0", "0.2.0", false, ["a.tgz", "b.tgz"]);
    expect(args).toContain("--latest");
    expect(args).not.toContain("--prerelease");
    expect(args).toContain("a.tgz");
    expect(args).toContain("b.tgz");
  });

  test("adds --prerelease for prerelease tags", () => {
    const args = buildGhReleaseArgs("0.2.0-pre", "0.2.0-pre", true, ["a.tgz"]);
    expect(args).toContain("--prerelease");
    expect(args).not.toContain("--latest");
  });

  test("embeds tag, title and notes-file", () => {
    const args = buildGhReleaseArgs("0.2.0", "0.2.0", false, []);
    expect(args).toContain("0.2.0");
    expect(args).toContain("mango-lsp 0.2.0");
    expect(args.some((a) => a.includes("release-notes.md"))).toBe(true);
  });
});

describe("expandAssetPaths", () => {
  test("resolves globs to concrete file paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mango-release-assets-"));
    await writeFile(join(dir, "mango-lsp-0.2.0-linux-x64.tar.gz"), "fake");
    await writeFile(join(dir, "mango-lsp-0.2.0-darwin-arm64.tar.gz"), "fake");
    await writeFile(join(dir, "install.sh"), "fake");
    await writeFile(join(dir, "install.ps1"), "fake");

    const paths = await expandAssetPaths(dir);

    expect(paths).toContain(join(dir, "mango-lsp-0.2.0-linux-x64.tar.gz"));
    expect(paths).toContain(join(dir, "mango-lsp-0.2.0-darwin-arm64.tar.gz"));
    expect(paths).toContain(join(dir, "install.sh"));
    expect(paths).toContain(join(dir, "install.ps1"));
  });

  test("throws when no mango-lsp-* assets are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mango-release-empty-"));
    await writeFile(join(dir, "install.sh"), "fake");
    await writeFile(join(dir, "install.ps1"), "fake");

    await expect(expandAssetPaths(dir)).rejects.toThrow("No mango-lsp-* release assets found");
  });
});

describe("formatGhCommand", () => {
  test("produces a readable dry-run command string with glob", () => {
    const cmd = formatGhCommand("0.2.0", "0.2.0", false);
    expect(cmd.startsWith("gh ")).toBe(true);
    expect(cmd).toContain("mango-lsp-*");
    expect(cmd).toContain("install.sh");
    expect(cmd).toContain("install.ps1");
  });
});

/* ─── integration-level tests for runRelease ─── */

describe("runRelease", () => {
  let out: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    out = captureStdout();
  });

  afterEach(() => {
    out.restore();
  });

  test("parses tag, applies version, and logs dry-run steps", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({ ...baseOptions, tag: "0.2.0", applyVersion: apply.fn });

    expect(apply.calls).toHaveLength(1);
    expect(apply.calls[0]).toEqual({
      version: "0.2.0",
      rootDir: expect.any(String),
      dryRun: true,
    });
    const log = out.lines.join("");
    expect(log).toContain("[dry-run]");
    expect(log).toContain("Release pipeline completed successfully");
  });

  test("normalises two-part tags and records displayVersion", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({ ...baseOptions, tag: "0.1", applyVersion: apply.fn });

    expect(apply.calls[0]?.version).toBe("0.1.0");
    const log = out.lines.join("");
    expect(log).toContain("display: 0.1");
    expect(log).toContain("package: 0.1.0");
  });

  test("handles prerelease tags correctly", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({ ...baseOptions, tag: "0.2.0-pre", applyVersion: apply.fn });

    expect(apply.calls[0]?.version).toBe("0.2.0-pre");
    expect(out.lines.join("")).toContain("prerelease: true");
  });

  test("throws on invalid tag format before applying version", async () => {
    const apply = makeFakeApplyVersion();

    await expect(
      runRelease({ ...baseOptions, tag: "not-a-tag", applyVersion: apply.fn }),
    ).rejects.toThrow("release tags must look like");

    expect(apply.calls).toHaveLength(0);
  });

  test("with skipPublish=false in dry-run logs would-publish output", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({
      ...baseOptions,
      tag: "0.3.0",
      skipPublish: false,
      applyVersion: apply.fn,
    });

    expect(apply.calls).toHaveLength(1);
    const log = out.lines.join("");
    expect(log).toContain("would publish");
    expect(log).toContain("latest");
  });

  test("with prerelease tag dry-run logs next tag", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({
      ...baseOptions,
      tag: "0.3.0-pre",
      skipPublish: false,
      applyVersion: apply.fn,
    });

    const log = out.lines.join("");
    expect(log).toContain("tag: next");
  });

  test("logs the gh command during dry-run even when not executed", async () => {
    const apply = makeFakeApplyVersion();

    await runRelease({ ...baseOptions, tag: "0.4.0", applyVersion: apply.fn });

    const log = out.lines.join("");
    expect(log).toContain("gh release create");
    expect(log).toContain("mango-lsp-*");
  });
});
