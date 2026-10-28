# @searxng-js/searxng

Run [SearXNG](https://github.com/searxng/searxng) from Node or Bun with no setup, and query its JSON API with a typed client. The SearXNG binary comes with the package: an optional dependency per platform (`@searxng-js/linux-x64`, `@searxng-js/darwin-arm64`, `@searxng-js/win32-x64`), of which your package manager installs the one that fits.

```ts
import { startServer } from "@searxng-js/searxng";

await using server = await startServer();
const res = await server.client.search({ q: "zig comptime", language: "en", categories: ["general"], timeRange: "year" });
for (const r of res.results) console.log(r.title, r.url, r.engines);
```

- `startServer()` uses `binaryPath`, else `$SEARXNG_BINARY`, else the installed platform package. It picks a free port on `127.0.0.1`, writes a minimal `settings.yml` (or uses `settingsPath`), waits until `/healthz` answers, and returns `{ url, client, stop() }`. The server exits with your process, even when that process is killed. After the first start it runs the server the binary extracted to the user cache directory directly, skipping the binary's launcher (about 0.5 s faster, 35 MiB less); `reuseExtraction: false` turns that off.
- `bun build --compile` embeds the binary of the target platform into your executable; on first use it is unpacked to the user cache directory (`~/.cache/searxng-js`, `%LOCALAPPDATA%\searxng-js`). Install the platform package of every target you compile for, e.g. `bun install --os=linux --cpu=x64`.
- `createClient({ baseUrl })` talks to any SearXNG instance that has the JSON format enabled.

Prebuilt binaries: Linux x64 (glibc 2.35 or newer), macOS arm64, Windows x64. Elsewhere, build one (see the repository) and pass `binaryPath`.

This package is MIT licensed. The binary packages are AGPL-3.0-or-later, like SearXNG; their corresponding source is linked in each package's THIRD-PARTY-NOTICES.md.

Source, build and numbers: https://github.com/AkaraChen/searxng
