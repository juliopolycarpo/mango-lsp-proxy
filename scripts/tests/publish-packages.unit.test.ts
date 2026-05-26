import { describe, expect, test } from "bun:test";
import { NATIVE_TARGETS } from "../native-targets";
import {
  isAlreadyPublished,
  type PublishablePackage,
  type PublishStatus,
  publishPackages,
} from "../publish-packages";

const ROOT_PACKAGE_NAME = "mango-lsp-proxy";
const NATIVE_NAMES = NATIVE_TARGETS.map((target) => target.packageName);

/** In-memory stand-in for the npm registry that records publish attempts. */
class FakeNpmRegistry {
  readonly calls: string[] = [];
  private readonly failuresRemaining = new Map<string, number>();
  private readonly alreadyPublished = new Set<string>();

  failTimes(name: string, times: number): void {
    this.failuresRemaining.set(name, times);
  }

  markAlreadyPublished(name: string): void {
    this.alreadyPublished.add(name);
  }

  publish = async (pkg: PublishablePackage): Promise<PublishStatus> => {
    this.calls.push(pkg.name);
    const remaining = this.failuresRemaining.get(pkg.name) ?? 0;
    if (remaining > 0) {
      this.failuresRemaining.set(pkg.name, remaining - 1);
      throw new Error(`registry error for ${pkg.name}`);
    }
    return this.alreadyPublished.has(pkg.name) ? "already-published" : "published";
  };
}

/** Records requested backoff delays without actually waiting. */
class RecordingClock {
  readonly delays: number[] = [];
  sleep = async (ms: number): Promise<void> => {
    this.delays.push(ms);
  };
}

class LogBuffer {
  readonly lines: string[] = [];
  write = (line: string): void => {
    this.lines.push(line);
  };
}

describe("publishPackages", () => {
  test("publishes every native package then the root package last", async () => {
    const registry = new FakeNpmRegistry();
    const clock = new RecordingClock();

    const result = await publishPackages({
      npmTag: "latest",
      publish: registry.publish,
      sleep: clock.sleep,
      log: () => {},
    });

    expect(registry.calls).toEqual([...NATIVE_NAMES, ROOT_PACKAGE_NAME]);
    expect(result.published).toEqual([...NATIVE_NAMES, ROOT_PACKAGE_NAME]);
    expect(result.published.at(-1)).toBe(ROOT_PACKAGE_NAME);
    expect(clock.delays).toEqual([]);
  });

  test("retries with exponential backoff and recovers from a transient failure", async () => {
    const registry = new FakeNpmRegistry();
    const clock = new RecordingClock();
    registry.failTimes(NATIVE_NAMES[0]!, 2);

    const result = await publishPackages({
      npmTag: "latest",
      backoffMs: 1_000,
      publish: registry.publish,
      sleep: clock.sleep,
      log: () => {},
    });

    expect(registry.calls.filter((name) => name === NATIVE_NAMES[0]!)).toHaveLength(3);
    expect(clock.delays).toEqual([1_000, 2_000]);
    expect(result.published).toContain(NATIVE_NAMES[0]!);
    expect(result.published.at(-1)).toBe(ROOT_PACKAGE_NAME);
  });

  test("stops at the first package that exhausts retries and leaves the rest unattempted", async () => {
    const registry = new FakeNpmRegistry();
    const clock = new RecordingClock();
    const log = new LogBuffer();
    const [first, second] = NATIVE_TARGETS;
    registry.failTimes(second!.packageName, 2);

    const run = publishPackages({
      npmTag: "latest",
      attempts: 2,
      backoffMs: 5,
      targetIds: [first!.id, second!.id],
      publish: registry.publish,
      sleep: clock.sleep,
      log: log.write,
    });

    await expect(run).rejects.toThrow(`registry error for ${second!.packageName}`);
    expect(registry.calls).not.toContain(ROOT_PACKAGE_NAME);
    const summary = log.lines.join("\n");
    expect(summary).toContain(`npm publish failed at ${second!.packageName}`);
    expect(summary).toContain(first!.packageName);
    expect(summary).toContain(ROOT_PACKAGE_NAME);
  });

  test("treats an already-published version as a skip, not a failure", async () => {
    const registry = new FakeNpmRegistry();
    const log = new LogBuffer();
    registry.markAlreadyPublished(NATIVE_NAMES[0]!);

    const result = await publishPackages({
      npmTag: "latest",
      publish: registry.publish,
      sleep: async () => {},
      log: log.write,
    });

    expect(result.published).toEqual([...NATIVE_NAMES, ROOT_PACKAGE_NAME]);
    expect(log.lines).toContain(`skipped ${NATIVE_NAMES[0]!} (already published at this version)`);
  });

  test("dryRun skips npm publish and logs would-publish output", async () => {
    const registry = new FakeNpmRegistry();
    const log = new LogBuffer();

    const result = await publishPackages({
      npmTag: "latest",
      dryRun: true,
      publish: registry.publish,
      sleep: async () => {},
      log: log.write,
    });

    expect(registry.calls).toEqual([]);
    expect(result.published).toEqual([...NATIVE_NAMES, ROOT_PACKAGE_NAME]);
    expect(log.lines).toContain("[dry-run] skipping npm publish for all packages");
    for (const name of NATIVE_NAMES) {
      const found = log.lines.some((line) => line.includes(`[dry-run] would publish ${name} (`));
      expect(found).toBe(true);
    }
    const rootFound = log.lines.some((line) =>
      line.includes(`[dry-run] would publish ${ROOT_PACKAGE_NAME} (`),
    );
    expect(rootFound).toBe(true);
  });
});

describe("isAlreadyPublished", () => {
  test("detects npm duplicate-version rejections", () => {
    expect(
      isAlreadyPublished(
        "npm error 403 You cannot publish over the previously published versions: 0.1.0",
      ),
    ).toBe(true);
    expect(isAlreadyPublished("npm ERR! code EPUBLISHCONFLICT")).toBe(true);
  });

  test("does not flag unrelated failures", () => {
    expect(isAlreadyPublished("npm error network ETIMEDOUT request to registry")).toBe(false);
    expect(isAlreadyPublished("")).toBe(false);
  });
});
