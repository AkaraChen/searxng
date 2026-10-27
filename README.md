# searxng

[SearXNG](https://github.com/searxng/searxng) as one self-contained executable, plus a JS client that starts it and queries its JSON API.

- `nuitka/`: builds SearXNG (pinned commit, see `nuitka/build.py`) into a single [Nuitka](https://nuitka.net) onefile binary for Linux, macOS and Windows. Only the JSON API (`/search?format=json`, `/config`, `/healthz`) is a goal; the HTML UI is left out.
- `packages/client` (`@akarachen/searxng`): `startServer()` spawns the binary and waits until it is ready; `createClient()` is a hand-written, typed client for the JSON API. SearXNG publishes no OpenAPI spec, so there is nothing to generate from.

CI (`.github/workflows/ci.yml`) builds the binary on `ubuntu-22.04` (x64), `macos-14` (arm64) and `windows-2022` (x64), smoke-tests it (`nuitka/smoke.py`), runs the client tests against it, and uploads it as an artifact. Each job's numbers are in its run summary.

## Client

```ts
import { startServer } from "@akarachen/searxng";

await using server = await startServer({ binaryPath: "/path/to/searxng" }); // or $SEARXNG_BINARY
const res = await server.client.search({ q: "zig comptime", language: "en", categories: ["general"], timeRange: "year" });
for (const r of res.results) console.log(r.title, r.url, r.engines);
// server.stop() runs on dispose: SIGTERM, then SIGKILL after 5 s
```

- `startServer` picks a free port (or `port`), binds `127.0.0.1` (or `host`), and writes a minimal `settings.yml` to a temporary directory unless you pass `settingsPath`. Port, host and a random secret are passed as `SEARXNG_PORT`, `SEARXNG_BIND_ADDRESS` and `SEARXNG_SECRET`, which override the file. It rejects with `StartServerError` (including the last 8 KB of server output) if the process exits, `timeoutMs` (default 60 s) passes, or `signal` aborts. The child is killed if the Node/Bun process exits.
- `createClient({ baseUrl })` exposes `search(params)`, `config()` and `health()`. Params are camelCase (`page`, `timeRange`, `safeSearch`); lists are joined with commas. Responses keep SearXNG's field names. Non-2xx responses throw `SearxngError` with `status` and SearXNG's `error` message. The default per-request timeout is 30 s, and it combines with a caller's `signal`.
- Runs on Node ≥ 20.3 and Bun. `bun test` runs the unit tests (a fake server stands in for SearXNG). `SEARXNG_BINARY=… bun test` also runs the integration tests against a real binary.

## Building the binary

```sh
cd nuitka
python build.py fetch                       # SearXNG at the pinned commit -> ./searxng
python -m pip install -r searxng/requirements.txt -r requirements-build.txt
python build.py build                       # -> build/searxng[.exe], build/build-info.json
python smoke.py                             # binary + settings.yml in an empty dir, ~8 queries
```

You need Python 3.13 and a C compiler (gcc/clang; MSVC on Windows). Run `build/searxng` next to a `settings.yml` (see `nuitka/settings.yml`), or set `SEARXNG_SETTINGS_PATH`. On the first start it unpacks itself to `<user cache dir>/searxng/<version>-<hash>/` (`~/.cache` on Linux, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows). Later starts reuse that directory. The hash covers everything that goes into the binary, so a new build never reuses a stale extraction.

## Results (Linux x86-64, measured locally)

Measured on an 8-core machine that was under heavy load. "Cold" means the extraction cache was removed first; "warm" is the second start. Both are timed until `/healthz` answers. RSS is the onefile bootstrap plus the SearXNG child after one search. Every step was checked with JSON searches; the `ui` step was also checked for zh-CN and de.

| step (cumulative) | size | cold | warm | RSS | unpacked | JSON search |
|---|---|---|---|---|---|---|
| baseline: untrimmed onefile | 52.6 MiB | 1.44 s | 1.25 s | 221 MiB | 220 MiB | ok |
| deps: stub pygments, typer, valkey; frozen version | 44.8 MiB | 1.26 s | 1.07 s | 196 MiB | 188 MiB | ok |
| ui: drop static, translations, fastText model, ahmia list | 42.1 MiB | 1.17 s | 1.00 s | 194 MiB | 176 MiB | ok |
| **strip: strip extension modules (Linux)** | **33.7 MiB** | 1.13 s | 1.06 s | 185 MiB | 140 MiB | ok |
| + ship SearXNG's `.py` sources (current default build) | **33.8 MiB** | 1.22 s | 1.01 s | – | – | ok, 261 engines |
| *optional* nodoc: `no_docstrings`, `no_asserts` | 33.1 MiB | 1.11 s | 0.94 s | 180 MiB | 138 MiB | ok |
| *optional* babel: only `sxng_locales` locale data (`--trim-babel`) | 29.0 MiB | 1.19 s | 1.02 s | 176 MiB | 115 MiB | ok, but see Risk |

For comparison, the official Docker image is about 98 MB. SearXNG from source in a venv starts in about 0.57 s with 111 MiB RSS.

Notes:
- zstd onefile compression is active: the payload compresses to about 25%.
- The bootstrap process stays resident (about 55 MiB RSS, mostly its own mapped payload), and the child is about 170 MiB. Compiled code uses more memory than bytecode.
- Even when warm, the onefile bootstrap adds about 0.5 s over running the unpacked dist. It still walks the compressed payload to check the cache, so a smaller payload also starts faster.
- What the default build is made of, compressed: Nuitka-compiled code 13 MB, libpython 7.7 MB, babel locale data 6.1 MB, curl_cffi 2.6 MB, lxml 2.5 MB, SearXNG data and sources 1.5 MB.
- curl_cffi's 41 MB `_wrapper.abi3.so` is mostly debug symbols. Stripped, it is 6.8 MB (2.6 MB compressed), so it is not a size floor.

## How it works, and what broke under Nuitka

- **Engines are loaded by file path.** `searx/engines/__init__.py` loads each configured engine with `spec_from_file_location("<name>.py")`, creating a fresh module per engine entry, because `xpath`, `json_engine` and others back several engines with different settings. A compiled build has no `.py` files, so every engine silently failed to load. Redirecting to compiled modules is not safe either: Nuitka keeps a compiled module's globals in C statics, so a second instance would clobber the first. The build ships `searx/**/*.py` as data instead. Engines then run as ordinary bytecode, exactly as upstream does, and answerers (found by `iterdir()`) work too.
- **The error recorder needs source lines.** `searx/metrics/error_recorder.py` uses `inspect.trace()[…].code_context[0]`, which is `None` for compiled frames without a source file. Every engine error crashed the handler, which skipped engine suspension. The shipped sources fix that as well.
- **Stubs** (`nuitka/sxng_stubs.py`, installed by `run.py` only when a module is missing):
  - `pygments`: HTML code highlighting only. Nuitka's package config would otherwise compile all 327 lexer modules, about 125 MB of C.
  - `typer`: the `python -m searx.*` CLIs only, but imported at module level by `searx/enginelib` and `searx/favicons/cache.py`.
  - `valkey`: used only when `valkey.url` is set.
  - `pwd`: missing on Windows, and imported by `searx/valkeydb.py`.
- **Static files:** settings validation requires `ui.static_path` to be a directory, so `run.py` creates an empty `searx/static` in the extraction directory.
- **Version:** `searx.version freeze` runs at build time, so the binary does not run `git` at every start.
- **Untrimmed builds** also need `--include-module=pygments.formatters.html`. pygments loads formatters lazily and Nuitka's config doesn't cover that.

## Risk

What is removed:
- **pygments:** `Code` results lose syntax highlighting in HTML; JSON is unaffected.
- **typer:** the maintenance CLIs.
- **valkey:** setting `valkey.url` raises at startup instead of connecting. That rules out the limiter with valkey and the `valkey_server` engine.
- **Static files and translations:** the HTML UI renders without CSS/JS and in English only. That is out of scope here.
- **fastText model:** nothing reads it.
- **ahmia blacklist:** it is used only with `outgoing.using_tor_proxy`.
- **babel locale data, only with `--trim-babel`:** languages outside `searx/sxng_locales.py` silently fall back to English. Tested: `sw-KE` and `eu` produced `hl=en`. Requests for zh-CN, zh-TW, de, de-CH, ja, fr, pt-BR, ru, ar, ko, fil-PH, ca-ES, all and auto were identical to the untrimmed build.

What can break on a SearXNG upgrade:
- a new module-level import of something stubbed or excluded. The build still succeeds, but the binary fails at start with Nuitka's "actively excluded" ImportError, and `smoke.py` catches that.
- another file-system lookup of package contents. That is how both bugs above were found; the smoke test's `engines loaded ≥ 100` check catches engine loading.
- new lazily imported modules that Nuitka cannot see.
- `/config` or result fields that change shape, which needs updating `packages/client/src/types.ts`.

## Upkeep

All trims are build flags, two small Nuitka user plugins (`strip_plugin.py`, `babel_plugin.py`) and the entry script with its stubs. SearXNG's source is never patched. An upgrade means bumping `SEARXNG_COMMIT` (and `VERSION`) in `nuitka/build.py` and letting CI run. The stubs need attention only if SearXNG starts *calling* into pygments, typer or valkey on the JSON path. The `--trim-babel` keep list is computed from the SearXNG source at build time.

## Portability

- **Linux:** the binary needs the build host's glibc or newer, because Nuitka-compiled code picks up the host's symbol versions. A local build on glibc 2.43 needs `GLIBC_2.38`; the CI build on ubuntu-22.04 should need about 2.35. The bundled extensions need ≤ 2.28 (lxml is `manylinux_2_28`, curl_cffi and libpython 2.17). To get a 2.28 floor, build in a `manylinux_2_28` container.
- **musl/static:** not realistic. curl_cffi has musllinux wheels, but Nuitka onefile, python-build-standalone's static musl build and extension modules don't combine into a working fully static binary. Use the glibc build or a container.
- **arm64 Linux:** the same build on an arm64 runner. All wheels exist for aarch64; it is not in CI yet.
- **macOS:** built on arm64 in CI. x86-64 would need a macos-13 runner. Not signed or notarized, so a downloaded binary needs `xattr -d com.apple.quarantine`.
- **Windows:** x64 in CI with MSVC. `pwd` is stubbed. Terminating the bootstrap must also end the child; `smoke.py` checks that the port is released.

## Licences

- **SearXNG** is AGPL-3.0-or-later, and so is this repository. Anyone who distributes a binary must offer the corresponding source. That source is SearXNG at the pinned commit plus this repository (build flags, plugins, entry script, stubs). Shipping the `.py` sources inside the binary does not replace that offer.
- **curl_cffi** is MIT. Its wheel statically links curl-impersonate/libcurl (curl licence), BoringSSL (OpenSSL/SSLeay and ISC for older code, Apache-2.0 for newer code), nghttp2/nghttp3 (MIT), brotli (MIT), zstd (BSD), zlib, and libidn2 (LGPL-3.0+/GPL-2.0+). The wheel ships only curl_cffi's own MIT text, so a binary distribution should add these notices.
- **Others:** CPython (PSF), lxml (BSD) with libxml2/libxslt (MIT), babel (BSD, CLDR data under the Unicode licence), Flask/Werkzeug/Jinja2 (BSD), PyYAML (MIT), msgspec (BSD), certifi (MPL-2.0). Nuitka's runtime (Apache-2.0) is compiled into the binary.

## Remaining optimizations (not done)

Estimates are compressed sizes on Linux.

- **Drop the compiled copies of engines** (about 2.5 MB). They are dead weight because engines run from the shipped sources. This needs `--nofollow-import-to=searx.engines.*` plus `--no-deployment-flag=excluded-module-usage`, and an explicit `--include-module` list for modules that only engines import. The list would be generated from a previous build's `report.xml`.
- **lxml extras** (about 1 MB): `--nofollow-import-to=lxml.objectify,lxml.sax,lxml.builder`. SearXNG only uses `lxml.etree` and `lxml.html`. Prepared but not measured.
- **`--trim-babel`** (4 MB) already exists as an opt-in. A lossless middle set, all locales SearXNG's tables reach, saves only about 1 MB.
- **`no_docstrings`/`no_asserts`** (0.6 MB): tested to work, but left out for the risk.
- **Strip on macOS** (`strip -x` before Nuitka re-signs). Check whether the macOS curl_cffi wheel is unstripped too.
- **Smaller stdlib:** `_pyrepl`, `__hello__` and similar (< 0.3 MB).
- **Startup:** the onefile bootstrap's warm overhead is about 0.5 s. A `--standalone` directory (no onefile), unpacked once by the JS package, would start in about 0.7 s and drop the 55 MiB bootstrap process.
- **Distribution for the JS client:** publish per-platform binary packages (esbuild-style `optionalDependencies`) or download from GitHub releases, so `binaryPath` becomes optional.
- **CI:** cache Nuitka/ccache between runs; add linux-arm64 and macos-x64; use a manylinux_2_28 container for Linux.

## Verdict

At most 50 MB is easily achievable: 33.8 MiB with low-risk trims, or 29 MiB if non-listed languages may fall back to English. The cost is not size but fidelity work: two real breakages (engine loading, the error recorder) only showed up in the compiled build, and every SearXNG upgrade needs the CI smoke test. Compared with the official Docker image (about 98 MB, needs Docker) or a portable Python plus venv (about 150–200 MB unpacked, starts faster, no compile step), the single binary is worth it for embedding: one file per platform, no runtime dependency, started by `startServer()`. It is not worth it if sex can ship a directory, in which case the standalone dist without onefile is the better trade-off.
