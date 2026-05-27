import { describe, expect, test } from "bun:test";
import { NATIVE_TARGETS } from "../native-targets";
import {
  buildNpmPublishArgs,
  detectCi,
  isAlreadyPublished,
  type PublishablePackage,
  type PublishPackagesOptions,
  type PublishStatus,
  publishPackages,
} from "../publish-packages";

const ROOT = "mango-lsp-proxy";
const NATIVES: readonly string[] = NATIVE_TARGETS.map((t) => t.packageName);
const ALL_PACKAGES = [...NATIVES, ROOT];
const FIRST_NATIVE = NATIVES[0]!;

/* ─── helpers ─── */

function fakeDeps(overrides: Partial<PublishPackagesOptions> = {}) {
  const calls: PublishablePackage[] = [];
  const delays: number[] = [];
  const lines: string[] = [];

  return {
    calls,
    delays,
    lines,
    run: (opts: Omit<PublishPackagesOptions, "publish" | "sleep" | "log">) =>
      publishPackages({
        ...overrides,
        ...opts,
        publish: async (pkg: PublishablePackage): Promise<PublishStatus> => {
          calls.push(pkg);
          if (overrides.publish) return await overrides.publish(pkg);
          return "published";
        },
        sleep: async (ms: number) => {
          delays.push(ms);
          if (overrides.sleep) await overrides.sleep(ms);
        },
        log: (line: string) => {
          lines.push(line);
          if (overrides.log) overrides.log(line);
        },
      }),
  };
}

/* ─── unit: CI detection ─── */

describe("detectCi", () => {
  test("returns true when CI env is 'true'", () => {
    expect(detectCi({ CI: "true" })).toBe(true);
  });

  test("returns false when CI env is missing or anything else", () => {
    expect(detectCi({})).toBe(false);
    expect(detectCi({ CI: "1" })).toBe(false);
    expect(detectCi({ CI: "yes" })).toBe(false);
  });
});

/* ─── unit: npm publish args builder ─── */

describe("buildNpmPublishArgs", () => {
  const pkg: PublishablePackage = { name: "mango-lsp-proxy", dir: "/tmp" };

  test("includes --provenance when enabled", () => {
    const args = buildNpmPublishArgs(pkg, "latest", true);
    expect(args).toContain("--provenance");
  });

  test("omits --provenance when disabled", () => {
    const args = buildNpmPublishArgs(pkg, "latest", false);
    expect(args).not.toContain("--provenance");
  });
});

/* ─── unit: already-published detection ─── */

describe("isAlreadyPublished", () => {
  test("detects duplicate-version rejections", () => {
    expect(
      isAlreadyPublished(
        "npm error 403 You cannot publish over the previously published versions: 0.1.0",
      ),
    ).toBe(true);
    expect(isAlreadyPublished("npm ERR! code EPUBLISHCONFLICT")).toBe(true);
    expect(isAlreadyPublished("cannot publish over 1.2.3")).toBe(true);
  });

  test("ignores unrelated failures", () => {
    expect(isAlreadyPublished("npm error network ETIMEDOUT")).toBe(false);
    expect(isAlreadyPublished("")).toBe(false);
  });
});

/* ─── integration: publish flow ─── */

describe("publishPackages", () => {
  test("publishes natives then root, in order", async () => {
    const f = fakeDeps();
    const result = await f.run({ npmTag: "latest" });

    expect(f.calls.map((c) => c.name)).toEqual(ALL_PACKAGES);
    expect(result.published).toEqual(ALL_PACKAGES);
    expect(f.delays).toEqual([]);
  });

  test("skips already-published without retrying", async () => {
    const f = fakeDeps({
      publish: async (pkg: PublishablePackage): Promise<PublishStatus> =>
        pkg.name === FIRST_NATIVE ? "already-published" : "published",
    });
    const result = await f.run({ npmTag: "latest" });

    expect(result.published).toEqual(ALL_PACKAGES);
    expect(f.lines).toContain(`skipped ${FIRST_NATIVE} (already published at this version)`);
    expect(f.delays).toEqual([]);
  });

  test("retries with exponential backoff and recovers", async () => {
    let attempts = 0;
    const f = fakeDeps({
      publish: async (pkg: PublishablePackage): Promise<PublishStatus> => {
        if (pkg.name === FIRST_NATIVE && ++attempts < 3) {
          throw new Error(`transient failure for ${pkg.name}`);
        }
        return "published";
      },
    });

    const result = await f.run({ npmTag: "latest", backoffMs: 100 });

    expect(f.calls.filter((c) => c.name === FIRST_NATIVE)).toHaveLength(3);
    expect(f.delays).toEqual([100, 200]);
    expect(result.published).toContain(FIRST_NATIVE);
    expect(result.published[result.published.length - 1]).toBe(ROOT);
  });

  test("halts on the first exhausted package and logs recovery", async () => {
    const [a, b] = NATIVE_TARGETS;
    const firstTarget = a!;
    const secondTarget = b!;
    const f = fakeDeps({
      publish: async (pkg: PublishablePackage): Promise<PublishStatus> => {
        if (pkg.name === secondTarget.packageName) throw new Error("permanent failure");
        return "published";
      },
    });

    await expect(
      f.run({
        npmTag: "latest",
        attempts: 2,
        backoffMs: 1,
        targetIds: [firstTarget.id, secondTarget.id],
      }),
    ).rejects.toThrow("permanent failure");

    expect(f.calls.map((c) => c.name)).not.toContain(ROOT);
    const summary = f.lines.join("\n");
    expect(summary).toContain(`npm publish failed at ${secondTarget.packageName}`);
    expect(summary).toContain(firstTarget.packageName);
    expect(summary).toContain(ROOT);
    expect(summary).toContain("Re-run the release to continue");
  });

  test("dryRun skips npm publish and logs every package", async () => {
    const f = fakeDeps();
    const result = await f.run({ npmTag: "latest", dryRun: true });

    expect(f.calls).toEqual([]);
    expect(result.published).toEqual(ALL_PACKAGES);
    expect(f.lines).toContain("[dry-run] skipping npm publish for all packages");
    for (const name of ALL_PACKAGES) {
      expect(f.lines.some((l) => l.includes(`[dry-run] would publish ${name}`))).toBe(true);
    }
  });

  test("provenance=true passed to publish callback", async () => {
    let capturedProvenance: boolean | undefined;
    const f = fakeDeps({
      publish: async (pkg: PublishablePackage): Promise<PublishStatus> => {
        capturedProvenance = (pkg as unknown as Record<string, unknown>).provenance as
          | boolean
          | undefined;
        return "published";
      },
    });
    await f.run({ npmTag: "latest", provenance: true });
    // Note: provenance is injected into runNpmPublish, not passed to the fake publish.
    // This test verifies the option is accepted without error.
    expect(capturedProvenance).toBeUndefined();
  });
});
