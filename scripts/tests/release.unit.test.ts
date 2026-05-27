import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangelogOptions } from "../changelog";
import {
  buildGhReleaseArgs,
  expandAssetPaths,
  formatGhCommand,
  parseArgv,
  runRelease,
} from "../release";
import type { ReleaseArtifactOptions } from "../release-artifacts";

/* ─── test doubles ─── */

function makeFakeApplyVersion() {
  const calls: { version: string; rootDir: string; dryRun: boolean }[] = [];
  const fn = async (version: string, rootDir: string, opts: { dryRun: boolean }) => {
    calls.push({ version, rootDir, dryRun: opts.dryRun });
  };
  return { fn, calls };
}

function makeFakeRunChangelog() {
  const calls: ChangelogOptions[] = [];
  const fn = async (options: ChangelogOptions) => {
    calls.push(options);
  };
  return { fn, calls };
}

function makeFakeWriteArtifacts() {
  const calls: ReleaseArtifactOptions[] = [];
  const fn = async (options: ReleaseArtifactOptions) => {
    calls.push(options);
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

function logText(out: ReturnType<typeof captureStdout>): string {
  return out.lines.join("");
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

/* ─── pure helpers ─── */

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

describe("release CLI options", () => {
  test("parses dry-run release pipeline flags", () => {
    expect(
      parseArgv([
        "--tag",
        "v0.2",
        "--sha",
        "abc123",
        "--dry-run",
        "--skip-check",
        "--skip-tests",
        "--skip-build",
        "--skip-smoke",
        "--skip-artifacts",
        "--skip-release-notes",
        "--skip-publish",
      ]),
    ).toEqual({
      tag: "v0.2",
      sha: "abc123",
      dryRun: true,
      skipCheck: true,
      skipTests: true,
      skipBuild: true,
      skipSmoke: true,
      skipArtifacts: true,
      skipReleaseNotes: true,
      skipPublish: true,
    });
  });

  test("rejects incomplete or unknown release flags", () => {
    expect(() => parseArgv([])).toThrow("usage: bun scripts/release.ts");
    expect(() => parseArgv(["--tag"])).toThrow("--tag requires a value");
    expect(() => parseArgv(["--sha"])).toThrow("--sha requires a value");
    expect(() => parseArgv(["--tag", "0.2", "--wat"])).toThrow("unknown option");
  });
});

/* ─── runRelease integration tests ─── */

describe("runRelease", () => {
  let out: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    out = captureStdout();
  });

  afterEach(() => {
    out.restore();
  });

  describe("version parsing and application", () => {
    test("parses tag, applies version, completes dry-run", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({ ...baseOptions, tag: "0.2.0", applyVersion: apply.fn });

      expect(apply.calls).toHaveLength(1);
      expect(apply.calls[0]).toEqual({
        version: "0.2.0",
        rootDir: expect.any(String),
        dryRun: true,
      });
      expect(logText(out)).toContain("Release pipeline completed successfully");
    });

    test("normalises two-part tags to semver", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({ ...baseOptions, tag: "0.1", applyVersion: apply.fn });

      expect(apply.calls[0]?.version).toBe("0.1.0");
      expect(logText(out)).toContain("display: 0.1");
      expect(logText(out)).toContain("package: 0.1.0");
    });

    test("detects prerelease tags", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({ ...baseOptions, tag: "0.2.0-pre", applyVersion: apply.fn });

      expect(apply.calls[0]?.version).toBe("0.2.0-pre");
      expect(logText(out)).toContain("prerelease: true");
    });

    test("rejects invalid tag format before applying version", async () => {
      const apply = makeFakeApplyVersion();

      await expect(
        runRelease({ ...baseOptions, tag: "not-a-tag", applyVersion: apply.fn }),
      ).rejects.toThrow("release tags must look like");

      expect(apply.calls).toHaveLength(0);
    });
  });

  describe("dry-run log output", () => {
    test("with skipPublish=false logs would-publish with latest tag", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({
        ...baseOptions,
        tag: "0.3.0",
        skipPublish: false,
        applyVersion: apply.fn,
      });

      expect(logText(out)).toContain("would publish");
      expect(logText(out)).toContain("latest");
    });

    test("with prerelease and skipPublish=false logs next tag", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({
        ...baseOptions,
        tag: "0.3.0-pre",
        skipPublish: false,
        applyVersion: apply.fn,
      });

      expect(logText(out)).toContain("tag: next");
    });

    test("logs the gh release create command", async () => {
      const apply = makeFakeApplyVersion();

      await runRelease({ ...baseOptions, tag: "0.4.0", applyVersion: apply.fn });

      expect(logText(out)).toContain("gh release create");
      expect(logText(out)).toContain("mango-lsp-*");
    });
  });

  describe("flag interactions", () => {
    test("skipArtifacts without skipReleaseNotes auto-skips release-notes and warns", async () => {
      const apply = makeFakeApplyVersion();
      const changelog = makeFakeRunChangelog();
      const artifacts = makeFakeWriteArtifacts();

      await runRelease({
        ...baseOptions,
        tag: "0.2.0",
        skipArtifacts: true,
        skipReleaseNotes: false,
        applyVersion: apply.fn,
        runChangelogFn: changelog.fn,
        writeReleaseArtifactsFn: artifacts.fn,
      });

      expect(changelog.calls).toHaveLength(0);
      expect(artifacts.calls).toHaveLength(0);
      expect(logText(out)).toContain("skipping (artifacts skipped, no assets file available)");
    });

    test("when both artifacts and release-notes are skipped, changelog is not called", async () => {
      const apply = makeFakeApplyVersion();
      const changelog = makeFakeRunChangelog();
      const artifacts = makeFakeWriteArtifacts();

      await runRelease({
        ...baseOptions,
        tag: "0.2.0",
        skipArtifacts: true,
        skipReleaseNotes: true,
        applyVersion: apply.fn,
        runChangelogFn: changelog.fn,
        writeReleaseArtifactsFn: artifacts.fn,
      });

      expect(changelog.calls).toHaveLength(0);
      expect(artifacts.calls).toHaveLength(0);
    });

    test("when neither is skipped, changelog gets release-notes command with correct args", async () => {
      const apply = makeFakeApplyVersion();
      const changelog = makeFakeRunChangelog();
      const artifacts = makeFakeWriteArtifacts();

      await runRelease({
        ...baseOptions,
        tag: "0.2.0",
        skipArtifacts: false,
        skipReleaseNotes: false,
        applyVersion: apply.fn,
        runChangelogFn: changelog.fn,
        writeReleaseArtifactsFn: artifacts.fn,
      });

      expect(artifacts.calls).toHaveLength(1);
      expect(artifacts.calls[0]).toMatchObject({
        displayVersion: "0.2.0",
        packageVersion: "0.2.0",
        tag: "0.2.0",
      });

      expect(changelog.calls).toHaveLength(1);
      expect(changelog.calls[0]).toEqual({
        command: "release-notes",
        tag: "0.2.0",
        outputPath: "dist/release/release-notes.md",
        assetsPath: "dist/release/release-assets.md",
      });
    });
  });
});
