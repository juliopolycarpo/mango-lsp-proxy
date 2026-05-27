import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNativeBinaries } from "../scripts/build";
import { detectHostNativeTarget } from "../scripts/native-targets";
import { smokeNativeBinaries } from "../scripts/smoke-native";

const ROOT_DIR = resolve(import.meta.dir, "..");
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

  hostBinaryTest(
    "copies the host binary into root bin/mango-lsp for direct execution",
    async () => {
      if (hostTarget === undefined) throw new Error("host target should be configured");

      const outputRoot = await mkdtemp(join(tmpdir(), "mango-native-e2e-"));
      await buildNativeBinaries({
        clean: true,
        outputRoot,
        targetIds: [hostTarget.id],
      });

      // installToBin copies to rootDir/bin/<binaryName>, which defaults to the
      // project root.  Verify the binary was placed and is not the old text
      // placeholder (whose first byte is 'm' = 0x6d).
      const binPath = join(ROOT_DIR, "bin", hostTarget.binaryName);
      await access(binPath, constants.R_OK | constants.X_OK);

      const bytes = await Bun.file(binPath).bytes();
      const firstByte = bytes[0];
      if (firstByte === undefined) throw new Error("bin/mango-lsp is unexpectedly empty");
      if (firstByte === 0x6d) {
        throw new Error(
          "bin/mango-lsp is the text placeholder — build did not overwrite it with the real binary",
        );
      }
    },
    120_000,
  );
});
