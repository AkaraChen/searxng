// Starts the real binary through startServer(), prints its URL and then just
// stays alive, so a test can kill this process the hard way.
// REUSE_EXTRACTION=0 starts the onefile binary even when an extraction is recorded.
import { startServer } from "../../src/index.ts";

const server = await startServer({ timeoutMs: 180_000, reuseExtraction: process.env.REUSE_EXTRACTION !== "0" });
console.log(`URL ${server.url}`);
setInterval(() => {}, 1 << 30);
