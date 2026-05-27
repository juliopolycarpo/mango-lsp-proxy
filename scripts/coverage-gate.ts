#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CoverageTotals {
  functions: CoverageMetric;
  lines: CoverageMetric;
}

export interface CoverageMetric {
  percent: number;
}

export interface CoverageThresholds {
  functions: number;
  lines: number;
  target: number;
}

export interface CoverageRun {
  code: number;
  output: string;
}

const ROOT_DIR = resolve(import.meta.dir, "..");
const DEFAULT_THRESHOLDS: CoverageThresholds = {
  functions: 94,
  lines: 90,
  target: 90,
};

/** Parse Bun's text coverage summary into gate totals.
 *
 * @example
 * parseBunCoverageSummary("All files | 80.00 | 70.00 |").lines.percent
 */
export function parseBunCoverageSummary(output: string): CoverageTotals {
  const match = output.match(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m);
  if (match === null) throw new Error("could not find Bun coverage summary");
  return {
    functions: { percent: Number(match[1]) },
    lines: { percent: Number(match[2]) },
  };
}

/** Read coverage thresholds from env overrides.
 *
 * @example
 * thresholdsFromEnv({ MANGO_LSP_COVERAGE_MIN_LINES: "80" }).lines
 */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv): CoverageThresholds {
  return {
    functions: percentEnv(env.MANGO_LSP_COVERAGE_MIN_FUNCTIONS, DEFAULT_THRESHOLDS.functions),
    lines: percentEnv(env.MANGO_LSP_COVERAGE_MIN_LINES, DEFAULT_THRESHOLDS.lines),
    target: percentEnv(env.MANGO_LSP_COVERAGE_TARGET, DEFAULT_THRESHOLDS.target),
  };
}

/** Return failing threshold labels for a coverage report.
 *
 * @example
 * coverageFailures(totals, { lines: 90, functions: 90, target: 90 })
 */
export function coverageFailures(totals: CoverageTotals, thresholds: CoverageThresholds): string[] {
  const failures: string[] = [];
  if (totals.lines.percent < thresholds.lines) failures.push("lines");
  if (totals.functions.percent < thresholds.functions) failures.push("functions");
  return failures;
}

function percentEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;
  throw new Error(`coverage percentage must be 0..100, got ${value}`);
}

/** Return the Bun command used by the coverage gate.
 *
 * @example
 * coverageCommand().includes("--coverage")
 */
export function coverageCommand(): string[] {
  return ["bun", "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"];
}

async function runCoverage(): Promise<CoverageRun> {
  const proc = Bun.spawn(coverageCommand(), {
    cwd: ROOT_DIR,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    streamTo(process.stdout, proc.stdout),
    streamTo(process.stderr, proc.stderr),
    proc.exited,
  ]);
  return { code, output: stdout + stderr };
}

/** Copy a ReadableStream into a WriteStream while collecting text.
 *
 * @example
 * const text = await streamTo(process.stdout, readable)
 */
export async function streamTo(
  target: NodeJS.WriteStream,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    target.write(text);
  }
  const tail = decoder.decode();
  if (tail !== "") target.write(tail);
  return output + tail;
}

function statusLabel(percent: number, threshold: number): string {
  return percent >= threshold ? "ok" : "fail";
}

function percent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** Format a plain-text coverage summary for local terminal output.
 *
 * @example
 * humanSummary(totals, thresholds).includes("coverage gate summary")
 */
export function humanSummary(totals: CoverageTotals, thresholds: CoverageThresholds): string {
  return [
    "",
    "coverage gate summary",
    metricLine("lines", totals.lines, thresholds.lines),
    metricLine("functions", totals.functions, thresholds.functions),
    `target: ${thresholds.target}% lines and functions`,
    "next rule: raise the minimum when tests push a metric above its current floor",
  ].join("\n");
}

function metricLine(name: string, metric: CoverageMetric, minimum: number): string {
  return `${name}: ${percent(metric.percent)} minimum ${minimum}% ${statusLabel(metric.percent, minimum)}`;
}

/** Format a JSON coverage summary for machine readers.
 *
 * @example
 * JSON.parse(machineSummary(totals, thresholds)).coverageGate
 */
export function machineSummary(totals: CoverageTotals, thresholds: CoverageThresholds): string {
  return JSON.stringify({
    coverageGate: {
      thresholds,
      totals,
    },
  });
}

/** Format a Markdown coverage summary for GitHub Actions.
 *
 * @example
 * markdownSummary(totals, thresholds).startsWith("## Coverage Gate")
 */
export function markdownSummary(totals: CoverageTotals, thresholds: CoverageThresholds): string {
  return [
    "## Coverage Gate",
    "",
    "| Metric | Coverage | Minimum | Target |",
    "| --- | ---: | ---: | ---: |",
    row("Lines", totals.lines, thresholds.lines, thresholds.target),
    row("Functions", totals.functions, thresholds.functions, thresholds.target),
    "",
    "Rule: raise the minimum when tests improve a metric above its current floor.",
    "",
  ].join("\n");
}

function row(name: string, metric: CoverageMetric, minimum: number, target: number): string {
  return `| ${name} | ${percent(metric.percent)} | ${minimum}% | ${target}% |`;
}

/** Append Markdown to GITHUB_STEP_SUMMARY when the variable is set.
 *
 * @example
 * await writeGithubSummary("## Coverage\n")
 */
export async function writeGithubSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === "") return;
  mkdirSync(dirname(summaryPath), { recursive: true });
  await appendFile(summaryPath, markdown);
}

async function main(): Promise<number> {
  const coverage = await runCoverage();
  if (coverage.code !== 0) return coverage.code;

  const thresholds = thresholdsFromEnv(process.env);
  const totals = parseBunCoverageSummary(coverage.output);
  const failures = coverageFailures(totals, thresholds);

  console.log(humanSummary(totals, thresholds));
  console.log(machineSummary(totals, thresholds));
  await writeGithubSummary(markdownSummary(totals, thresholds));

  if (failures.length === 0) return 0;
  console.error(`coverage gate failed: ${failures.join(", ")}`);
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
