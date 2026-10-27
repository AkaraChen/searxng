// Stands in for the SearXNG binary in startServer tests.
// FAKE_MODE: "ok" (default) | "crash" (exit 3 at once) | "never-ready" (no /healthz)
import { existsSync } from "node:fs";
import { createServer } from "node:http";

const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "crash") {
  console.error("fake: boom");
  process.exit(3);
}
if (!process.env.SEARXNG_SETTINGS_PATH || !existsSync(process.env.SEARXNG_SETTINGS_PATH)) {
  console.error("fake: missing settings");
  process.exit(4);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz" && mode === "ok") {
    res.end("OK");
  } else if (url.pathname === "/search") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ query: url.searchParams.get("q"), params: Object.fromEntries(url.searchParams), results: [] }));
  } else if (url.pathname === "/env") {
    res.end(JSON.stringify({ secret: process.env.SEARXNG_SECRET, extra: process.env.FAKE_EXTRA, settings: process.env.SEARXNG_SETTINGS_PATH }));
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(Number(process.env.SEARXNG_PORT), process.env.SEARXNG_BIND_ADDRESS);

process.on("SIGTERM", () => process.exit(0));
