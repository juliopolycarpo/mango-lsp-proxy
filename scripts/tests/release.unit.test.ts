import { beforeEach, describe, expect, test } from "bun:test";
import { runRelease } from "../release";

/** Records every call made to the injected applyVersion. */
interface VersionCall {
  version: string;
  rootDir: string;
  dryRun: boolean;
}

const versionCalls: VersionCall[] = [];

async function fakeApplyVersion(
  version: string,
  rootDir: string,
  options: { dryRun: boolean },
): Promise<void> {
  versionCalls.push({ version, rootDir, dryRun: options.dryRun });
}

beforeEach(() => {
  versionCalls.length = 0;
});

const baseOptions = {
  dryRun: true,
  skipCheck: true,
  skipTests: true,
  skipBuild: true,
  skipSmoke: true,
  skipArtifacts: true,
  skipReleaseNotes: true,
  skipPublish: true,
  applyVersion: fakeApplyVersion,
} as const;

describe("runRelease", () => {
  test("dry-run skips version rewrite and records intent", async () => {
    await runRelease({ ...baseOptions, tag: "0.2.0" });

    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]).toEqual({
      version: "0.2.0",
      rootDir: expect.any(String),
      dryRun: true,
    });
  });

  test("passes prerelease package version to applyReleaseVersion", async () => {
    await runRelease({ ...baseOptions, tag: "0.2.0-pre" });

    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]?.version).toBe("0.2.0-pre");
  });

  test("dry-run with publish enabled logs would-publish output", async () => {
    await runRelease({ ...baseOptions, tag: "0.3.0", skipPublish: false });

    expect(versionCalls).toHaveLength(1);
    expect(versionCalls[0]).toEqual({
      version: "0.3.0",
      rootDir: expect.any(String),
      dryRun: true,
    });
  });

  test("throws on invalid tag format before calling applyReleaseVersion", async () => {
    await expect(runRelease({ ...baseOptions, tag: "not-a-tag" })).rejects.toThrow(
      "release tags must look like",
    );
    expect(versionCalls).toHaveLength(0);
  });
});
