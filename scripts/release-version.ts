import { appendFile } from "node:fs/promises";

export interface ReleaseVersion {
  readonly tag: string;
  readonly displayVersion: string;
  readonly packageVersion: string;
  readonly isPrerelease: boolean;
}

export const RELEASE_TAG_PATTERN =
  /^v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)(?:\.(?<patch>0|[1-9]\d*))?(?<suffix>-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** Parse a Git tag into GitHub and package-manager versions.
 *
 * Example: parseReleaseTag("0.1-pre").packageVersion === "0.1.0-pre"
 */
export function parseReleaseTag(tag: string): ReleaseVersion {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (match?.groups === undefined) {
    throw new Error("release tags must look like 0.1, 0.1.0, 0.1-pre, v0.1, or v0.1-pre");
  }

  const suffix = match.groups.suffix ?? "";
  const displayVersion = `${match.groups.major}.${match.groups.minor}${
    match.groups.patch === undefined ? "" : `.${match.groups.patch}`
  }${suffix}`;
  const packageVersion = `${match.groups.major}.${match.groups.minor}.${
    match.groups.patch ?? "0"
  }${suffix}`;

  return {
    tag,
    displayVersion,
    packageVersion,
    isPrerelease: suffix !== "",
  };
}

function outputValue(name: string, value: string | boolean): string {
  return `${name}=${value}\n`;
}

/** Format release version values for the GitHub Actions output file.
 *
 * @example
 * githubOutput(parseReleaseTag("0.1-pre")).includes("npm_tag=next")
 */
export function githubOutput(version: ReleaseVersion): string {
  return [
    outputValue("display_version", version.displayVersion),
    outputValue("package_version", version.packageVersion),
    outputValue("prerelease", version.isPrerelease),
    outputValue("npm_tag", version.isPrerelease ? "next" : "latest"),
  ].join("");
}

if (import.meta.main) {
  try {
    const version = parseReleaseTag(process.argv[2] ?? "");
    if (process.argv.includes("--github-output")) {
      const outputPath = process.env.GITHUB_OUTPUT;
      if (outputPath === undefined) throw new Error("GITHUB_OUTPUT is not set");
      await appendFile(outputPath, githubOutput(version));
    } else {
      process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
