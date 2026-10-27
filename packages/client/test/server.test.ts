import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StartServerError, startServer } from "../src/index.ts";

// Run the fake through the current runtime so the test works on every OS.
const fake = { binaryPath: process.execPath, args: [join(import.meta.dir, "fixtures", "fake-searxng.ts")] };

describe("startServer (fake binary)", () => {
  test("starts on a free port, passes settings and env, stops cleanly", async () => {
    const server = await startServer({ ...fake, secretKey: "s3cret", env: { FAKE_EXTRA: "yes" } });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(await server.client.health()).toBe(true);
    const res = await server.client.search({ q: "hi", language: "de" });
    expect((res as unknown as { params: Record<string, string> }).params).toMatchObject({ q: "hi", format: "json", language: "de" });
    expect(await (await fetch(`${server.url}/env`)).json()).toMatchObject({ secret: "s3cret", extra: "yes" });
    await server.stop();
    // Windows has no SIGTERM: kill() is TerminateProcess, so the exit code is not 0 there.
    if (process.platform !== "win32") expect(await server.exited).toBe(0);
    expect(await server.client.health()).toBe(false);
    await server.stop(); // idempotent
  });

  test("generated settings are removed when disposed with await using", async () => {
    let settings = "";
    {
      await using server = await startServer(fake);
      settings = ((await (await fetch(`${server.url}/env`)).json()) as { settings: string }).settings;
      expect(existsSync(settings)).toBe(true);
    }
    expect(settings).not.toBe("");
    expect(existsSync(settings)).toBe(false);
  });

  test("rejects with the server output when the process exits early", async () => {
    const err = await startServer({ ...fake, env: { FAKE_MODE: "crash" } }).catch((e) => e);
    expect(err).toBeInstanceOf(StartServerError);
    expect(err.message).toContain("exited with code 3");
    expect(err.output).toContain("fake: boom");
  });

  test("rejects and kills the process on timeout", async () => {
    const err = await startServer({ ...fake, env: { FAKE_MODE: "never-ready" }, timeoutMs: 500 }).catch((e) => e);
    expect(err).toBeInstanceOf(StartServerError);
    expect(err.message).toContain("did not answer /healthz");
  });

  test("rejects when aborted", async () => {
    const controller = new AbortController();
    const pending = startServer({ ...fake, env: { FAKE_MODE: "never-ready" }, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(pending).rejects.toThrow();
  });

  test("rejects when the binary does not exist", async () => {
    const err = await startServer({ binaryPath: join(dirname(import.meta.dir), "nope") }).catch((e) => e);
    expect(err).toBeInstanceOf(StartServerError);
    expect(err.message).toContain("cannot start");
  });

  test("uses the given settings file", async () => {
    const settingsPath = join(import.meta.dir, "fixtures", "fake-searxng.ts"); // any existing file
    expect(existsSync(settingsPath)).toBe(true);
    const server = await startServer({ ...fake, settingsPath });
    await server.stop();
  });
});
