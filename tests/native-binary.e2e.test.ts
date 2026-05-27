import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNativeBinaries } from "../scripts/build";
import { detectHostNativeTarget } from "../scripts/native-targets";
import { smokeNativeBinaries } from "../scripts/smoke-native";

const ROOT_DIR = resolve(import.meta.dir, "..");
const hostTarget = detectHostNativeTarget();
const hostBinaryTest = hostTarget === undefined ? test.skip : test;

let tempDirs: string[] = [];

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function assertNotPlaceholder(bytes: Uint8Array, path: string): void {
  if (bytes[0] === 0x6d) {
    throw new Error(
      `${path} is the text placeholder — build did not overwrite it with the real binary`,
    );
  }
}

describe("native binary e2e", () => {
  hostBinaryTest(
    "builds a valid runnable binary for the current host",
    async () => {
      if (hostTarget === undefined) throw new Error("host target should be configured");

      const outputRoot = await makeTemp("mango-native-e2e-");
      const outputs = await buildNativeBinaries({
        clean: true,
        outputRoot,
        targetIds: [hostTarget.id],
      });

      expect(outputs).toHaveLength(1);
      const output = outputs[0];
      if (output === undefined) throw new Error("binary build did not return output");
      expect(output.target.id).toBe(hostTarget.id);

      await smokeNativeBinaries({
        outputRoot,
        targetIds: [hostTarget.id],
      });

      const proc = Bun.spawn([output.path, "help"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("serve-lsp --stdio");
    },
    120_000,
  );

  hostBinaryTest(
    "copies the host binary into root bin/mango-lsp for direct execution",
    async () => {
      if (hostTarget === undefined) throw new Error("host target should be configured");

      const outputRoot = await makeTemp("mango-native-e2e-");
      await buildNativeBinaries({
        clean: true,
        outputRoot,
        targetIds: [hostTarget.id],
      });

      const binPath = join(ROOT_DIR, "bin", hostTarget.binaryName);
      await access(binPath, constants.R_OK | constants.X_OK);

      const bytes = await Bun.file(binPath).bytes();
      if (bytes.length === 0) throw new Error("bin/mango-lsp is unexpectedly empty");
      assertNotPlaceholder(bytes, binPath);
    },
    120_000,
  );
});
