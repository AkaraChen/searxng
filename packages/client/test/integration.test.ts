// Against the real binary: SEARXNG_BINARY=/path/to/searxng bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createClient, type SearxngServer, startServer } from "../src/index.ts";

const binary = process.env.SEARXNG_BINARY;

describe.skipIf(!binary)("real SearXNG binary", () => {
  let server: SearxngServer;
  beforeAll(async () => {
    server = await startServer({ binaryPath: binary, timeoutMs: 180_000 });
  }, 200_000);
  afterAll(() => server?.stop());

  test("engines are loaded", async () => {
    const config = await server.client.config();
    expect(config.engines.length).toBeGreaterThan(100);
    expect(config.engines.some((e) => e.name === "wikipedia" && e.enabled)).toBe(true);
  });

  test("search returns typed results (wikipedia, needs network)", async () => {
    const res = await server.client.search({ q: "python programming language", engines: ["wikipedia"] });
    expect(res.results.length + res.infoboxes.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(typeof r.title).toBe("string");
      expect(Array.isArray(r.engines)).toBe(true);
    }
  }, 60_000);

  test("language and categories are accepted", async () => {
    const res = await server.client.search({ q: "量子计算", language: "zh-CN", categories: ["general", "news"] });
    expect(res.query).toBe("量子计算");
    expect(Array.isArray(res.unresponsive_engines)).toBe(true);
  }, 60_000);

  test("stop terminates the server", async () => {
    await server.stop();
    expect(await server.client.health()).toBe(false);
  }, 30_000);
});

describe.skipIf(!binary)("real SearXNG binary, parent killed", () => {
  test("the server exits when the process that started it dies", async () => {
    const parent = spawn(process.execPath, [join(import.meta.dir, "fixtures", "start-real.ts")], {
      env: { ...process.env, SEARXNG_BINARY: binary },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      parent.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = /URL (\S+)/.exec(out);
        if (match) resolve(match[1] as string);
      });
      parent.once("exit", (code) => reject(new Error(`parent exited with ${code} before the server was ready`)));
    });
    const client = createClient({ baseUrl: url });
    expect(await client.health()).toBe(true);
    parent.kill("SIGKILL"); // no exit handlers run; on Windows this is TerminateProcess
    const deadline = Date.now() + 15_000;
    while ((await client.health({ signal: AbortSignal.timeout(1000) })) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await client.health()).toBe(false);
  }, 200_000);
});
