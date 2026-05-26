import { describe, expect, test } from "bun:test";
import { parseReleaseTag } from "../release-version";

describe("release version mapping", () => {
  test("normalizes two-part tags for package registries", () => {
    expect(parseReleaseTag("0.1")).toEqual({
      tag: "0.1",
      displayVersion: "0.1",
      packageVersion: "0.1.0",
      isPrerelease: false,
    });
  });

  test("keeps prerelease tags as GitHub versions and semver package versions", () => {
    expect(parseReleaseTag("v0.1-pre")).toEqual({
      tag: "v0.1-pre",
      displayVersion: "0.1-pre",
      packageVersion: "0.1.0-pre",
      isPrerelease: true,
    });
  });

  test("rejects tags outside the release pattern", () => {
    expect(() => parseReleaseTag("release/0.1")).toThrow("release tags must look like");
  });
});
