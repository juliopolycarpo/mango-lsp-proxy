import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeBinaries } from "../scripts/build";
import { detectHostNativeTarget } from "../scripts/native-targets";
import { smokeNativeBinaries } from "../scripts/smoke-native";

const hostTarget = detectHostNativeTarget();
const hostBinaryTest = hostTarget === undefined ? test.skip : test;

describe("native binary e2e", () => {
  hostBinaryTest(
    "builds a valid runnable binary for the current host",
    async () => {
      if (hostTarget === undefined) throw new Error("host target should be configured");

      const outputRoot = await mkdtemp(join(tmpdir(), "mango-native-e2e-"));
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
});
