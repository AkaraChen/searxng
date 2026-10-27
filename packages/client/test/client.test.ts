import { afterAll, describe, expect, test } from "bun:test";
import { createClient, SearxngError, searchQuery } from "../src/index.ts";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("OK");
    if (url.pathname === "/search" && !url.searchParams.get("q")) return Response.json({ error: "No query" }, { status: 400 });
    if (url.pathname === "/search") return Response.json({ query: url.searchParams.get("q"), results: [], answers: [] });
    if (url.pathname === "/config") return Response.json({ engines: [{ name: "wikipedia" }] });
    if (url.pathname === "/slow") return new Promise(() => {});
    return new Response("nope", { status: 500 });
  },
});
afterAll(() => server.stop(true));
const baseUrl = `http://127.0.0.1:${server.port}/`;

describe("searchQuery", () => {
  test("maps camelCase params to SearXNG names and joins lists", () => {
    const q = searchQuery({
      q: "rust",
      categories: ["news", "it"],
      engines: ["wikipedia", "google news"],
      language: "zh-CN",
      page: 2,
      timeRange: "week",
      safeSearch: 0,
    });
    expect(Object.fromEntries(q)).toEqual({
      q: "rust",
      format: "json",
      categories: "news,it",
      engines: "wikipedia,google news",
      language: "zh-CN",
      pageno: "2",
      time_range: "week",
      safesearch: "0",
    });
  });

  test("omits unset params", () => {
    expect(Object.fromEntries(searchQuery({ q: "x" }))).toEqual({ q: "x", format: "json" });
  });
});

describe("createClient", () => {
  const client = createClient({ baseUrl });

  test("search, config, health", async () => {
    expect((await client.search({ q: "hello" })).query).toBe("hello");
    expect((await client.config()).engines[0]?.name).toBe("wikipedia");
    expect(await client.health()).toBe(true);
    expect(client.baseUrl).toBe(baseUrl.slice(0, -1));
  });

  test("non-2xx throws SearxngError with SearXNG's error message", async () => {
    const err = await client.search({ q: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(SearxngError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("No query");
  });

  test("health is false when the server is unreachable", async () => {
    expect(await createClient({ baseUrl: "http://127.0.0.1:1" }).health()).toBe(false);
  });

  test("timeout and caller signal abort the request", async () => {
    const slow = createClient({ baseUrl, timeoutMs: 100, fetch: (_url, init) => fetch(`${baseUrl}slow`, init) });
    expect(slow.config()).rejects.toThrow();
    const controller = new AbortController();
    const pending = createClient({ baseUrl, fetch: (_u, init) => fetch(`${baseUrl}slow`, init) }).config({ signal: controller.signal });
    controller.abort();
    expect(pending).rejects.toThrow();
  });
});
