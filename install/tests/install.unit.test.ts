import { describe, expect, test } from "bun:test";

function parseArgs(
  args: string[],
): { version: string; installDir: string } | { error: string } {
  let version = "";
  let installDir = "$HOME/.local/bin";
  let i = 0;

  while (i < args.length) {
    switch (args[i]) {
      case "--version":
        i++;
        if (i >= args.length) return { error: "usage: install.sh [--version <version>] [--install-dir <dir>]" };
        version = args[i];
        i++;
        break;
      case "--install-dir":
        i++;
        if (i >= args.length) return { error: "usage: install.sh [--version <version>] [--install-dir <dir>]" };
        installDir = args[i];
        i++;
        break;
      default:
        return { error: "usage: install.sh [--version <version>] [--install-dir <dir>]" };
    }
  }

  version = version.replace(/^v/, "");

  return { version, installDir };
}

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

describe("install argument parsing", () => {
  test("--version with a value parses", () => {
    const result = parseArgs(["--version", "0.2.0"]);
    expect(result).toEqual({ version: "0.2.0", installDir: "$HOME/.local/bin" });
  });

  test("strips leading v from --version value", () => {
    const result = parseArgs(["--version", "v0.2.0"]);
    expect(result).toEqual({ version: "0.2.0", installDir: "$HOME/.local/bin" });
  });

  test("--version with no value returns error instead of crashing", () => {
    const result = parseArgs(["--version"]);
    expect(result).toEqual({
      error: "usage: install.sh [--version <version>] [--install-dir <dir>]",
    });
  });

  test("--version at end of args with no value returns error", () => {
    const result = parseArgs(["--install-dir", "/tmp/bin", "--version"]);
    expect(result).toEqual({
      error: "usage: install.sh [--version <version>] [--install-dir <dir>]",
    });
  });

  test("--install-dir with no value returns error", () => {
    const result = parseArgs(["--install-dir"]);
    expect(result).toEqual({
      error: "usage: install.sh [--version <version>] [--install-dir <dir>]",
    });
  });

  test("unknown flag returns error", () => {
    const result = parseArgs(["--help"]);
    expect(result).toEqual({
      error: "usage: install.sh [--version <version>] [--install-dir <dir>]",
    });
  });

  test("no args uses defaults", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ version: "", installDir: "$HOME/.local/bin" });
  });
});

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
