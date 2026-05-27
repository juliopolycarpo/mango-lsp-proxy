import { describe, expect, test } from "bun:test";

function resolveVersionAndTag(
  supplied: { version: string; tag: string },
  latestTag: string,
): { version: string; tag: string } {
  let { version, tag } = supplied;

  version = version.replace(/^v/, "");

  if (!tag) {
    if (!version) {
      tag = latestTag;
      version = tag.replace(/^v/, "");
    } else {
      tag = `v${version}`;
    }
  } else if (!version) {
    version = tag.replace(/^v/, "");
  }

  return { version, tag };
}

function assetName(version: string, target: string, ext: string): string {
  return `mango-lsp-${version}-${target}.${ext}`;
}

describe("install version/tag normalization", () => {
  const LATEST = "v1.0.0";

  test("neither set: fetches latest tag, strips v for version", () => {
    const { version, tag } = resolveVersionAndTag({ version: "", tag: "" }, LATEST);
    expect(version).toBe("1.0.0");
    expect(tag).toBe("v1.0.0");
  });

  test("only version without v: v-prefixes tag", () => {
    const { version, tag } = resolveVersionAndTag({ version: "0.1.0", tag: "" }, LATEST);
    expect(version).toBe("0.1.0");
    expect(tag).toBe("v0.1.0");
  });

  test("only version with leading v: strips v from version, v-prefixes tag", () => {
    const { version, tag } = resolveVersionAndTag({ version: "v0.1.0", tag: "" }, LATEST);
    expect(version).toBe("0.1.0");
    expect(tag).toBe("v0.1.0");
  });

  test("only tag with v prefix: derives version by stripping v", () => {
    const { version, tag } = resolveVersionAndTag({ version: "", tag: "v0.1.0" }, LATEST);
    expect(version).toBe("0.1.0");
    expect(tag).toBe("v0.1.0");
  });

  test("only tag without v prefix: version matches tag as-is", () => {
    const { version, tag } = resolveVersionAndTag({ version: "", tag: "0.1.0" }, LATEST);
    expect(version).toBe("0.1.0");
    expect(tag).toBe("0.1.0");
  });

  test("both set: strips v from version, keeps tag as-is", () => {
    const { version, tag } = resolveVersionAndTag(
      { version: "v0.2.0", tag: "nightly/v0.2.0" },
      LATEST,
    );
    expect(version).toBe("0.2.0");
    expect(tag).toBe("nightly/v0.2.0");
  });

  test("pre-release version keeps suffix", () => {
    const { version, tag } = resolveVersionAndTag({ version: "v0.1.0-pre", tag: "" }, LATEST);
    expect(version).toBe("0.1.0-pre");
    expect(tag).toBe("v0.1.0-pre");
  });
});

describe("install asset name construction", () => {
  test("never produces double-hyphen from empty version (TAG-only case)", () => {
    const { version } = resolveVersionAndTag({ version: "", tag: "v0.1.0" }, "v1.0.0");
    const name = assetName(version, "linux-x64", "tar.gz");
    expect(name).toBe("mango-lsp-0.1.0-linux-x64.tar.gz");
    expect(name).not.toContain("--");
  });

  test("never produces double-hyphen from empty version (--version with leading v case)", () => {
    const { version } = resolveVersionAndTag({ version: "v0.1.0", tag: "" }, "v1.0.0");
    const name = assetName(version, "linux-x64", "tar.gz");
    expect(name).toBe("mango-lsp-0.1.0-linux-x64.tar.gz");
    expect(name).not.toContain("--");
  });

  test("unix asset uses .tar.gz extension", () => {
    const name = assetName("0.1.0", "linux-arm64-musl", "tar.gz");
    expect(name).toBe("mango-lsp-0.1.0-linux-arm64-musl.tar.gz");
  });

  test("windows asset uses .exe extension", () => {
    const name = assetName("0.1.0", "windows-x64", "exe");
    expect(name).toBe("mango-lsp-0.1.0-windows-x64.exe");
  });
});
