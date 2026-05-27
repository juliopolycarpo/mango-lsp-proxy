import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coverageCommand,
  coverageFailures,
  humanSummary,
  machineSummary,
  markdownSummary,
  parseBunCoverageSummary,
  streamTo,
  thresholdsFromEnv,
  writeGithubSummary,
} from "../coverage-gate";

describe("streamTo", () => {
  test("copies a readable stream into a write target and returns text", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello "));
        controller.enqueue(encoder.encode("world"));
        controller.close();
      },
    });
    const writes: string[] = [];
    const target = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
    } as NodeJS.WriteStream;

    const result = await streamTo(target, source);
    expect(result).toBe("hello world");
    expect(writes.join("")).toBe("hello world");
  });

  test("handles empty streams", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const writes: string[] = [];
    const target = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
    } as NodeJS.WriteStream;

    const result = await streamTo(target, source);
    expect(result).toBe("");
    expect(writes).toHaveLength(0);
  });
});

describe("coverage gate summary parsing", () => {
  test("parses Bun text coverage totals", () => {
    const totals = parseBunCoverageSummary(
      [
        "----------------------------------|---------|---------|-------------------",
        "File                              | % Funcs | % Lines | Uncovered Line #s",
        "----------------------------------|---------|---------|-------------------",
        "All files                         |   72.28 |   66.71 |",
      ].join("\n"),
    );

    expect(totals.functions).toEqual({ percent: 72.28 });
    expect(totals.lines).toEqual({ percent: 66.71 });
  });

  test("fails when Bun coverage totals are missing", () => {
    expect(() => parseBunCoverageSummary("no coverage table")).toThrow("coverage summary");
  });
});

describe("coverage gate thresholds", () => {
  test("uses baseline defaults when env overrides are absent", () => {
    expect(thresholdsFromEnv({})).toEqual({
      functions: 94,
      lines: 90,
      target: 90,
    });
  });

  test("parses threshold overrides from environment variables", () => {
    expect(
      thresholdsFromEnv({
        MANGO_LSP_COVERAGE_MIN_FUNCTIONS: "81.5",
        MANGO_LSP_COVERAGE_MIN_LINES: "82.5",
        MANGO_LSP_COVERAGE_TARGET: "95",
      }),
    ).toEqual({ functions: 81.5, lines: 82.5, target: 95 });
  });

  test("rejects invalid threshold overrides", () => {
    expect(() => thresholdsFromEnv({ MANGO_LSP_COVERAGE_MIN_LINES: "101" })).toThrow("0..100");
  });

  test("reports every metric below its threshold", () => {
    const failures = coverageFailures(
      {
        functions: { percent: 80 },
        lines: { percent: 70 },
      },
      { functions: 90, lines: 75, target: 90 },
    );

    expect(failures).toEqual(["lines", "functions"]);
  });
});

describe("coverage gate output", () => {
  const totals = {
    functions: { percent: 91.25 },
    lines: { percent: 76.5 },
  };
  const thresholds = { functions: 90, lines: 75, target: 90 };

  test("uses the Bun coverage command with text and lcov reporters", () => {
    expect(coverageCommand()).toEqual([
      "bun",
      "test",
      "--coverage",
      "--coverage-reporter=text",
      "--coverage-reporter=lcov",
    ]);
  });

  test("formats human, machine, and markdown summaries", () => {
    expect(humanSummary(totals, thresholds)).toContain("lines: 76.50% minimum 75% ok");
    expect(JSON.parse(machineSummary(totals, thresholds))).toEqual({
      coverageGate: { thresholds, totals },
    });
    expect(markdownSummary(totals, thresholds)).toContain("| Functions | 91.25% | 90% | 90% |");
  });

  test("human summary shows fail for metrics below threshold", () => {
    const failing = {
      functions: { percent: 80 },
      lines: { percent: 70 },
    };
    expect(humanSummary(failing, thresholds)).toContain("lines: 70.00% minimum 75% fail");
    expect(humanSummary(failing, thresholds)).toContain("functions: 80.00% minimum 90% fail");
  });

  test("markdown summary includes pass/fail indicators", () => {
    const failing = {
      functions: { percent: 80 },
      lines: { percent: 70 },
    };
    expect(markdownSummary(failing, thresholds)).toContain("| Lines | 70.00% | 75% | 90% |");
    expect(markdownSummary(failing, thresholds)).toContain("| Functions | 80.00% | 90% | 90% |");
  });

  test("appends GitHub step summaries when configured", async () => {
    const previous = process.env.GITHUB_STEP_SUMMARY;
    const summaryPath = join(
      await mkdtemp(join(tmpdir(), "mango-coverage-summary-")),
      "summary.md",
    );
    process.env.GITHUB_STEP_SUMMARY = summaryPath;

    try {
      await writeGithubSummary("## Coverage\n");
      expect(await Bun.file(summaryPath).text()).toBe("## Coverage\n");
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = previous;
      }
    }
  });

  test("writeGithubSummary is a no-op when env var is empty", async () => {
    const previous = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;

    try {
      await writeGithubSummary("## Coverage\n");
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = previous;
      }
    }
  });

  test("coverageFailures returns empty array when all metrics pass", () => {
    expect(
      coverageFailures(
        { functions: { percent: 95 }, lines: { percent: 80 } },
        { functions: 90, lines: 75, target: 90 },
      ),
    ).toEqual([]);
  });

  test("thresholdsFromEnv handles empty string values", () => {
    expect(
      thresholdsFromEnv({
        MANGO_LSP_COVERAGE_MIN_FUNCTIONS: "",
        MANGO_LSP_COVERAGE_MIN_LINES: "",
      }),
    ).toEqual({ functions: 94, lines: 90, target: 90 });
  });
});
