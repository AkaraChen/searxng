# searxng-js

**English** · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@searxng-js/searxng)](https://www.npmjs.com/package/@searxng-js/searxng)
[![ci](https://github.com/AkaraChen/searxng/actions/workflows/ci.yml/badge.svg)](https://github.com/AkaraChen/searxng/actions/workflows/ci.yml)

Web search for your Node or Bun app, with no API key, no Docker and no Python. `npm install` it, call `startServer()`, and you have a private [SearXNG](https://github.com/searxng/searxng) metasearch engine on localhost with a typed client.

```ts
import { startServer } from "@searxng-js/searxng";

await using server = await startServer();
const { results } = await server.client.search({ q: "zig comptime", timeRange: "year" });
for (const r of results) console.log(r.title, r.url, r.engines);
// the server stops here, when `server` goes out of scope
```

(`await using` needs Bun, Node 24+ or a TypeScript build; otherwise call `await server.stop()`.)

## What this is

SearXNG is an open-source metasearch engine. It sends your query to many search engines at once (about 260 are available, among them Google, DuckDuckGo, Brave, Wikipedia, GitHub and arXiv), then merges and ranks what they return. It is a Python web app, and you usually run it with Docker or a Python virtualenv.

This repository turns it into something you can add as a dependency:

- **A single executable per platform.** SearXNG and its Python runtime compiled with [Nuitka](https://nuitka.net) into one file of 21–23 MiB. Nothing to install on the machine.
- **An npm package, `@searxng-js/searxng`.** It brings the right binary for your platform, starts it, waits until it is ready and stops it again. It also includes a typed client for SearXNG's JSON API.

## Why use it

- **No API key, no quota, no bill.** Commercial search APIs charge per query. Here the queries go from your machine straight to the engines.
- **One dependency.** `npm install` is the whole setup. Your users need no Docker, Python or system packages, and nobody has to keep a search server running.
- **Fits in a single-file app.** `bun build --compile` embeds the binary in your executable, so one file you ship includes web search.
- **Clean shutdown.** The server is a child of your process. It stops when you call `stop()`, when your process exits, and even when your process is killed with SIGKILL.
- **Results from many engines at once.** Each result lists the engines that returned it, and `unresponsive_engines` tells you which ones failed. One engine blocking you does not leave you with nothing.
- **Typed.** Parameters and responses have TypeScript types, so you don't need to read SearXNG's source to find out what it returns.

Good fits: a web-search tool for an LLM agent, CLI tools, desktop apps, crawlers and research scripts, and integration tests that need real search results.

## Install

```sh
npm install @searxng-js/searxng   # or: pnpm add / bun add / yarn add
```

Requires Node ≥ 20.3 or Bun. Your package manager installs only the binary package for your platform:

| platform | package | notes |
|---|---|---|
| Linux x64 | `@searxng-js/linux-x64` | glibc 2.35 or newer (Ubuntu 22.04, Debian 12 and later); no musl/Alpine |
| macOS arm64 | `@searxng-js/darwin-arm64` | Apple silicon |
| Windows x64 | `@searxng-js/win32-x64` | |

On other platforms, [build the binary yourself](docs/internals.md#building-the-binary) and pass its path as `binaryPath`.

## Usage

### Start a server and search

```ts
import { startServer, SearxngError } from "@searxng-js/searxng";

const server = await startServer();          // free port on 127.0.0.1
console.log(server.url);                     // e.g. http://127.0.0.1:40213

try {
  const res = await server.client.search({
    q: "量子计算",
    language: "zh-CN",
    categories: ["general", "news"],
    page: 1,
    safeSearch: 1,
  });
  console.log(res.results.length, res.infoboxes, res.suggestions);
} catch (err) {
  if (err instanceof SearxngError) console.error(err.status, err.message);
} finally {
  await server.stop();
}
```

The first start can take up to about 4 s (Windows; Linux and macOS about 2 s), because the binary unpacks itself to the user cache directory. Later starts run the unpacked server directly and take well under a second (about 0.6 s on Linux).

`q` accepts SearXNG's query syntax as well: `site:github.com`, `!wikipedia`, `:de`.

### As a tool for an LLM agent

```ts
const server = await startServer();

async function webSearch(query: string) {
  const { results } = await server.client.search({ q: query });
  return results.slice(0, 8).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}
```

Start the server once and reuse it for every call.

### Ship it in a single executable

```sh
bun install --os=linux --cpu=x64   # install the binary package of each target you compile for
bun build --compile --target=bun-linux-x64 app.ts
```

Bun embeds only the target's binary. On the first run it is unpacked to `~/.cache/searxng-js` (`%LOCALAPPDATA%\searxng-js` on Windows), and later runs reuse it.

### Use your own settings, or an existing instance

```ts
await startServer({ settingsPath: "./settings.yml" });   // your own SearXNG settings.yml

import { createClient } from "@searxng-js/searxng";
const client = createClient({ baseUrl: "https://searx.example.org" });   // JSON format must be enabled there
```

## API

**`startServer(options?)`** resolves to `{ url, port, pid, executable, client, exited, stop() }` once `/healthz` answers. Use it with `await using` to stop it automatically.

| option | default | |
|---|---|---|
| `binaryPath` | `$SEARXNG_BINARY`, else the platform package | path to a SearXNG executable |
| `port` / `host` | free port / `127.0.0.1` | |
| `settingsPath` | minimal settings in a temporary directory | JSON API on, limiter off |
| `secretKey` | random per start | |
| `env`, `args` | | extra environment and arguments for the server |
| `timeoutMs` | 60 s | how long to wait for the server to become ready |
| `reuseExtraction` | `true` | after the first start, run the unpacked server directly instead of the binary's launcher |
| `signal` | | abort the start |
| `onOutput` | | receives the server's stdout and stderr |

If the server exits early, the timeout passes, or `signal` aborts, it rejects with `StartServerError`, which includes the last 8 KB of server output. `stop(graceMs = 10_000)` sends SIGTERM, then SIGKILL after the grace period; on Windows it kills the process tree.

**`createClient({ baseUrl, fetch?, headers?, timeoutMs? })`** returns a client for any SearXNG instance:

- `search({ q, categories?, engines?, language?, page?, timeRange?, safeSearch? })` returns `{ results, answers, infoboxes, suggestions, corrections, unresponsive_engines }`. Parameters are camelCase, and lists are joined with commas for you. Responses keep SearXNG's field names.
- `config()` returns the instance's engines, categories, plugins and locales.
- `health()` returns `true` when the server is healthy, and never throws.

Non-2xx responses throw `SearxngError` with `status` and SearXNG's error message. Each request times out after 30 s by default, and also honours your `signal`.

## How it works

1. `nuitka/build.py` fetches SearXNG at a pinned commit and compiles it, with its dependencies and the Python runtime, into a Nuitka onefile binary. The HTML UI's assets, unused dependencies and debug symbols are left out. SearXNG's source is never patched.
2. CI builds and tests the binary on Linux, macOS and Windows. Releases publish each one as an npm package for its platform (`os`/`cpu`/`libc` set), as optional dependencies of the main package.
3. `startServer()` resolves the binary, writes a settings file, and spawns it on a free port with a random secret. The binary is a launcher that checks its unpacked files on every start; after the first start, the client skips it and runs the unpacked server directly, which saves about 0.5 s and 35 MiB. It holds a stdin pipe to the server and sets `SEARXNG_EXIT_ON_STDIN_EOF=1`, so the server exits when your process does, even when no exit handler runs.

The details are in [docs/internals.md](docs/internals.md): the size and startup measurements, the two bugs that only appeared in the compiled build, portability, and the release pipeline.

## Compared with the alternatives

| | this package | official Docker image | Python venv |
|---|---|---|---|
| size | 21–23 MiB, one file | about 98 MB, plus Docker | about 150–200 MB unpacked |
| needs on the machine | nothing | Docker | Python 3 |
| startup | about 0.6 s on Linux (up to 4 s the first time) | container start | about 0.6 s |
| lifecycle | tied to your process | you manage it | you manage it |

## Limitations

- **The JSON API only.** The HTML UI ships without CSS, JS and translations.
- **No valkey/redis.** Setting `valkey.url` makes the server fail at startup, so there is no limiter backed by valkey.
- **Engines can block or rate-limit you**, as with any SearXNG instance. Cloud and CI IPs get blocked more often; check `unresponsive_engines`.
- **Prebuilt binaries only for linux-x64 (glibc), darwin-arm64 and win32-x64.** The macOS binary is not signed or notarized.
- **Memory:** on Linux about 95 MiB RSS idle and 120 MiB after a few searches, close to SearXNG run from source (about 80 and 115 MiB). Fewer engines (`use_default_settings.engines.keep_only` in your settings) use less.

## Building from source

```sh
cd nuitka
python build.py fetch
python -m pip install -r searxng/requirements.txt -r requirements-build.txt
python build.py build      # -> build/searxng[.exe]
python smoke.py            # starts the binary and runs a few real queries
```

You need Python 3.13 and a C compiler. To run the client tests against your build, run `SEARXNG_BINARY=../../nuitka/build/searxng bun test` in `packages/client`. The release process is described in [docs/internals.md](docs/internals.md#releasing).

## Licence

- `@searxng-js/searxng` (the client in `packages/client`) is **MIT**. It only spawns the binary and talks HTTP to it.
- The binary packages and the rest of this repository are **AGPL-3.0-or-later**, like SearXNG. Each binary package includes the licence texts of everything bundled into it and points to the corresponding source.

Built on [SearXNG](https://github.com/searxng/searxng) and [Nuitka](https://nuitka.net). This project is not affiliated with the SearXNG project.
