import { describe, expect, test } from "bun:test";
import { parseChangelogArgs, releaseNotesContent } from "../changelog";

describe("changelog arguments", () => {
  test("parses the default changelog writer", () => {
    expect(parseChangelogArgs(["write"])).toEqual({
      command: "write",
      outputPath: "CHANGELOG.md",
    });
  });

  test("requires a release tag for release notes", () => {
    expect(() => parseChangelogArgs(["release-notes"])).toThrow("--tag <tag>");
  });

  test("parses release note paths", () => {
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
});

describe("release note composition", () => {
  test("joins structured changes and release assets", () => {
    expect(releaseNotesContent("## 0.1\n", "\n## Assets\n")).toBe("## 0.1\n\n## Assets\n");
  });
});
