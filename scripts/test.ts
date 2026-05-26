import { resolve } from "node:path";

type TestSuite = "unit" | "integration" | "e2e";

const ROOT_DIR = resolve(import.meta.dir, "..");
const SUITE_PATTERNS: Record<TestSuite, string> = {
  unit: "**/*.unit.test.ts",
  integration: "**/*.integration.test.ts",
  e2e: "**/*.e2e.test.ts",
};

const EXCLUDED_PARTS = new Set(["node_modules", "dist", "build", "coverage", ".mango-lsp"]);

function isIncludedTestPath(path: string): boolean {
  return path.split(/[\\/]/).every((part) => !EXCLUDED_PARTS.has(part));
}

async function testFiles(suite: TestSuite): Promise<string[]> {
  const glob = new Bun.Glob(SUITE_PATTERNS[suite]);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: ROOT_DIR, onlyFiles: true })) {
    if (isIncludedTestPath(file)) files.push(file);
  }
  return files.sort();
}

function suiteFromArg(value: string | undefined): TestSuite {
  if (value === "unit" || value === "integration" || value === "e2e") return value;
  throw new Error("usage: bun scripts/test.ts <unit|integration|e2e>");
}

if (import.meta.main) {
  try {
    const suite = suiteFromArg(process.argv[2]);
    const files = await testFiles(suite);
    if (files.length === 0) {
      throw new Error(`no ${suite} test files found`);
    }

    const proc = Bun.spawn(["bun", "test", ...files], {
      cwd: ROOT_DIR,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await proc.exited);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
