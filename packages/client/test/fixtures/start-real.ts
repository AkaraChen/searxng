// Starts the real binary through startServer(), prints its URL and then just
// stays alive, so a test can kill this process the hard way.
import { startServer } from "../../src/index.ts";

const server = await startServer({ timeoutMs: 180_000 });
console.log(`URL ${server.url}`);
setInterval(() => {}, 1 << 30);
