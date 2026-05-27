import { describe, expect, test } from "bun:test";
import { coverageFailures, parseBunCoverageSummary, thresholdsFromEnv } from "../coverage-gate";

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
      functions: 71,
      lines: 65,
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
