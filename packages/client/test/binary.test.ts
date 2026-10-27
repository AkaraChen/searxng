import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEmbeddedPath, prepareBinary, resolveBinary, SearxngBinaryError, StartServerError, startServer, TARGETS } from "../src/index.ts";

describe("binary resolution", () => {
  test("recognizes paths embedded in compiled Bun executables", () => {
    expect(isEmbeddedPath("/$bunfs/root/searxng-a1b2c3.")).toBe(true);
    expect(isEmbeddedPath("B:\\~BUN\\root\\searxng-a1b2c3.exe")).toBe(true);
    expect(isEmbeddedPath("B:/~BUN/root/searxng-a1b2c3.exe")).toBe(true);
    expect(isEmbeddedPath("/usr/local/bin/searxng")).toBe(false);
    expect(isEmbeddedPath("C:\\Users\\me\\searxng.exe")).toBe(false);
  });

  test.skipIf(process.platform === "win32")("restores a dropped executable bit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "searxng-bin-"));
    try {
      const file = join(dir, "searxng");
      await writeFile(file, "#!/bin/sh\n");
      await chmod(file, 0o644);
      expect(await prepareBinary(file)).toBe(file);
      expect((await stat(file)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // In this repository no platform package is installed.
  const supported = TARGETS.some((t) => t.os === process.platform && t.cpu === process.arch);
  test.skipIf(!supported)("names the missing platform package", async () => {
    const err = await resolveBinary().catch((e) => e);
    expect(err).toBeInstanceOf(SearxngBinaryError);
    expect(err.message).toContain(`@searxng-js/${process.platform}-${process.arch}`);
  });

  test.skipIf(!supported)("startServer without a binary rejects with StartServerError", async () => {
    const saved = process.env.SEARXNG_BINARY;
    delete process.env.SEARXNG_BINARY;
    try {
      const err = await startServer().catch((e) => e);
      expect(err).toBeInstanceOf(StartServerError);
      expect(err.message).toContain("is not installed");
    } finally {
      if (saved !== undefined) process.env.SEARXNG_BINARY = saved;
    }
  });
});
