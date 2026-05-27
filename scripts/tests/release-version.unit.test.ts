import { describe, expect, test } from "bun:test";
import { parseReleaseTag, RELEASE_TAG_PATTERN } from "../release-version";

function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      pattern += ".*";
    } else if (ch === "?") {
      pattern += ".";
    } else if (ch === "[") {
      pattern += "[";
      i++;
      while (i < glob.length && glob.charAt(i) !== "]") {
        pattern += glob.charAt(i);
        i++;
      }
      pattern += "]";
    } else {
      pattern += escapeRegex(ch);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegex(ch: string): string {
  return /[.?+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

const WORKFLOW_TAG_PATTERNS = ["[0-9]*.[0-9]*", "v[0-9]*.[0-9]*"];

const WORKFLOW_TAG_REGEX = new RegExp(
  `^(${WORKFLOW_TAG_PATTERNS.map((g) => globToRegex(g).source).join("|")})$`,
);

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

describe("workflow tag filter patterns", () => {
  function matchesWorkflow(tag: string): boolean {
    return WORKFLOW_TAG_REGEX.test(tag);
  }

  test("matches valid semver tags with or without v prefix", () => {
    expect(matchesWorkflow("0.1")).toBe(true);
    expect(matchesWorkflow("0.1.0")).toBe(true);
    expect(matchesWorkflow("v0.1")).toBe(true);
    expect(matchesWorkflow("v0.1-pre")).toBe(true);
    expect(matchesWorkflow("1.2.3-beta.1")).toBe(true);
  });

  test("rejects bare numbers without a dot that previously triggered the workflow", () => {
    expect(matchesWorkflow("123")).toBe(false);
    expect(matchesWorkflow("v1")).toBe(false);
    expect(matchesWorkflow("2024")).toBe(false);
    expect(matchesWorkflow("2024.01")).toBe(true);
  });

  test("RELEASE_TAG_PATTERN remains the authoritative validator", () => {
    expect(RELEASE_TAG_PATTERN.test("1.2.3.4")).toBe(false);
    expect(RELEASE_TAG_PATTERN.test("0.1")).toBe(true);
    expect(RELEASE_TAG_PATTERN.test("v0.1-pre")).toBe(true);
  });

  test("workflow patterns reject tags RELEASE_TAG_PATTERN rejects", () => {
    const invalid = ["release/0.1", "random", "v", "v.", ".1", ""];
    for (const tag of invalid) {
      if (RELEASE_TAG_PATTERN.test(tag)) continue;
      expect(matchesWorkflow(tag)).toBe(false);
    }
  });
});
