import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangelogArgs, releaseNotesContent, runChangelog } from "../changelog";

function mockSpawn() {
  return spyOn(Bun, "spawn").mockImplementation(() => {
    return { exited: Promise.resolve(0), stderr: "inherit", stdout: "inherit" } as never;
  });
}

const changesDir = join(import.meta.dir, "..", "..", "dist", "release");
const changesPath = join(changesDir, "release-changes.md");

describe("changelog arguments", () => {
  test("parses the default changelog writer", () => {
    expect(parseChangelogArgs(["write"])).toEqual({
      command: "write",
      outputPath: "CHANGELOG.md",
    });
  });

  test("parses the check command", () => {
    expect(parseChangelogArgs(["check"])).toEqual({
      command: "check",
      outputPath: "",
    });
  });

  test("requires a release tag for release notes", () => {
    expect(() => parseChangelogArgs(["release-notes"])).toThrow("--tag <tag>");
  });

  test("parses release note paths with defaults", () => {
    expect(parseChangelogArgs(["release-notes", "--tag", "0.1"])).toEqual({
      command: "release-notes",
      outputPath: "dist/release/release-notes.md",
      tag: "0.1",
      assetsPath: "dist/release/release-assets.md",
    });
  });

  test("parses release note paths with overrides", () => {
    expect(
      parseChangelogArgs([
        "release-notes",
        "--tag",
        "0.1",
        "--output",
        "out.md",
        "--assets",
        "assets.md",
      ]),
    ).toEqual({
      command: "release-notes",
      outputPath: "out.md",
      tag: "0.1",
      assetsPath: "assets.md",
    });
  });

  test("rejects unknown commands", () => {
    expect(() => parseChangelogArgs(["bogus"])).toThrow("usage: bun scripts/changelog.ts");
  });

  test("writes with explicit output path", () => {
    expect(parseChangelogArgs(["write", "--output", "custom.md"])).toEqual({
      command: "write",
      outputPath: "custom.md",
    });
  });
});

describe("release note composition", () => {
  test("joins structured changes and release assets", () => {
    expect(releaseNotesContent("## 0.1\n", "\n## Assets\n")).toBe("## 0.1\n\n## Assets\n");
  });

  test("handles empty changes", () => {
    expect(releaseNotesContent("", "## Assets\n")).toBe("## Assets\n");
  });

  test("handles empty assets", () => {
    expect(releaseNotesContent("## 0.1\n", "")).toBe("## 0.1\n");
  });

  test("handles both empty", () => {
    expect(releaseNotesContent("", "")).toBe("\n");
  });

  test("trims whitespace from parts", () => {
    expect(releaseNotesContent("  ## 0.1  ", "  ## Assets  ")).toBe("## 0.1\n\n## Assets\n");
  });
});

describe("changelog execution", () => {
  let spawnMock: ReturnType<typeof mockSpawn>;

  afterEach(() => {
    spawnMock?.mockRestore();
  });

  test("check: validates config via temp directory", async () => {
    spawnMock = mockSpawn();

    await expect(runChangelog({ command: "check", outputPath: "" })).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalled();
  });

  test("write: produces CHANGELOG.md through git-cliff and dprint", async () => {
    spawnMock = mockSpawn();
    const outDir = await mkdtemp(join(tmpdir(), "mango-changelog-write-"));
    const outputPath = join(outDir, "CHANGELOG.md");

    await expect(runChangelog({ command: "write", outputPath })).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  test("release-notes: composes changes and assets into release notes", async () => {
    spawnMock = mockSpawn();
    const outDir = await mkdtemp(join(tmpdir(), "mango-changelog-release-"));
    const assetsPath = join(outDir, "assets.md");
    const outputPath = join(outDir, "release-notes.md");

    await mkdir(changesDir, { recursive: true });
    await writeFile(changesPath, "## 0.1\n");
    await writeFile(assetsPath, "## Assets\n");

    try {
      await expect(
        runChangelog({
          command: "release-notes",
          tag: "0.1",
          outputPath,
          assetsPath,
        }),
      ).resolves.toBeUndefined();

      const output = await Bun.file(outputPath).text();
      expect(output).toBe("## 0.1\n\n## Assets\n");
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(outDir, { force: true, recursive: true });
    }
  });
});
