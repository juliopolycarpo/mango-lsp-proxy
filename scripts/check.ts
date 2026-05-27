#!/usr/bin/env bun
/**
 * scripts/check.ts
 *
 * Run the repository's checks sequentially so failures are easy to read:
 *   1. typecheck via tsgo (@typescript/native-preview)
 *   2. biome check
 *   3. dprint check
 *   4. git-cliff changelog config check
 *
 * Exits non-zero if any step fails. Uses only Bun APIs; no extra deps.
 */

interface Step {
  name: string;
  cmd: string[];
}

const steps: Step[] = [
  { name: "typecheck", cmd: ["bunx", "tsgo", "--noEmit"] },
  { name: "biome", cmd: ["bunx", "--bun", "@biomejs/biome", "check", "."] },
  { name: "dprint", cmd: ["bunx", "dprint", "check"] },
  { name: "changelog", cmd: ["bun", "scripts/changelog.ts", "check"] },
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
  console.log("all checks passed");
  process.exit(0);
} else {
  console.error(`${failed} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
