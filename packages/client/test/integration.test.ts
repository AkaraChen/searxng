// Against the real binary: SEARXNG_BINARY=/path/to/searxng bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type SearxngServer, startServer } from "../src/index.ts";

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
