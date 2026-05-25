#!/usr/bin/env bun
/**
 * scripts/fmt.ts
 *
 * Apply formatting/auto-fixes across the repository:
 *   1. biome check --write (formatter + linter safe fixes + organize imports)
 *   2. dprint fmt (markdown, toml, yaml)
 *
 * Exits non-zero if any step fails. Uses only Bun APIs; no extra deps.
 */

interface Step {
  name: string;
  cmd: string[];
}

const steps: Step[] = [
  {
    name: "biome",
    cmd: ["bunx", "--bun", "@biomejs/biome", "check", "--write", "."],
  },
  { name: "dprint", cmd: ["bunx", "dprint", "fmt"] },
];

function banner(title: string): void {
  const line = "=".repeat(Math.max(8, title.length + 4));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

async function run(step: Step): Promise<number> {
  banner(step.name);
  console.log(`$ ${step.cmd.join(" ")}`);
  const proc = Bun.spawn(step.cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code === 0) {
    console.log(`\n[${step.name}] ok`);
  } else {
    console.error(`\n[${step.name}] FAILED (exit ${code})`);
  }
  return code;
}

let failed = 0;
const failures: string[] = [];

for (const step of steps) {
  const code = await run(step);
  if (code !== 0) {
    failed++;
    failures.push(step.name);
  }
}

banner("summary");
if (failed === 0) {
  console.log("all formatters succeeded");
  process.exit(0);
} else {
  console.error(`${failed} formatter(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
