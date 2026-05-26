import { describe, expect, test } from "bun:test";
import { runRelease } from "../release";

describe("runRelease", () => {
  test("completes in dry-run mode with all external steps skipped", async () => {
    await expect(
      runRelease({
        tag: "0.2.0",
        dryRun: true,
        skipCheck: true,
        skipTests: true,
        skipBuild: true,
        skipSmoke: true,
        skipArtifacts: true,
        skipReleaseNotes: true,
        skipPublish: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("completes in dry-run mode with npm publish step", async () => {
    await expect(
      runRelease({
        tag: "0.3.0",
        dryRun: true,
        skipCheck: true,
        skipTests: true,
        skipBuild: true,
        skipSmoke: true,
        skipArtifacts: true,
        skipReleaseNotes: true,
        skipPublish: false,
      }),
    ).resolves.toBeUndefined();
  });

  test("completes in dry-run mode for a prerelease tag", async () => {
    await expect(
      runRelease({
        tag: "0.2.0-pre",
        dryRun: true,
        skipCheck: true,
        skipTests: true,
        skipBuild: true,
        skipSmoke: true,
        skipArtifacts: true,
        skipReleaseNotes: true,
        skipPublish: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws on invalid tag format", async () => {
    await expect(
      runRelease({
        tag: "not-a-tag",
        dryRun: true,
        skipCheck: true,
        skipTests: true,
        skipBuild: true,
        skipSmoke: true,
        skipArtifacts: true,
        skipReleaseNotes: true,
        skipPublish: true,
      }),
    ).rejects.toThrow("release tags must look like");
  });
});
