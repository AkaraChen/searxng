# Internals

Engineering notes for [searxng-js](../README.md): how the binary is built and released, what it measures, what had to change for SearXNG to run under Nuitka, and what can break.

## Client

- `startServer` picks a free port (or `port`), binds `127.0.0.1` (or `host`), and writes a minimal `settings.yml` to a temporary directory unless you pass `settingsPath`. Port, host and a random secret are passed as `SEARXNG_PORT`, `SEARXNG_BIND_ADDRESS` and `SEARXNG_SECRET`, which override the file. It rejects with `StartServerError` (including the last 8 KB of server output) if the process exits, `timeoutMs` (default 60 s) passes, or `signal` aborts.
- Without `binaryPath` or `$SEARXNG_BINARY`, `resolveBinary()` imports the platform package for `process.platform`/`process.arch`. The imports are literal, so `bun build --compile` inlines the platform, embeds only the target's binary, and the package of other targets need not be installed. Inside a compiled executable the binary is an embedded file (`/$bunfs/...`), which cannot be spawned, so it is unpacked once to `<user cache dir>/searxng-js/<name>-<hash>/`. The platform packages carry `os`, `cpu` and (Linux) `libc: glibc`, so musl systems get no binary and a clear error.
- The binary is a onefile launcher: every start, it checks its extraction in the user cache directory file by file (CRC32 of about 140 MB), then runs the server executable from there as a child. The client skips that after the first start. Started with `SEARXNG_EXTRACTION_RECORD=<file>`, the binary records its extracted server executable there, and later starts spawn that executable directly. That saves about 0.5 s and 35 MiB per start (measured on Linux). The record is `<user cache dir>/searxng-js/extracted/<SHA-256 of the binary>.json`, so a different binary never uses it, and Nuitka's extraction directory carries a hash of the build. If the recorded executable is gone, the binary runs instead; if it exits before it is ready, the client deletes the record and runs the binary, which repairs the extraction. `reuseExtraction: false` always runs the binary; `server.executable` shows what was spawned.
- The server does not outlive its parent. `stop()` and an exit handler end it (on Windows by killing the process tree, since the binary is a launcher plus a server child). If the Node/Bun process dies without running exit handlers, e.g. on SIGKILL, the server exits too: it gets a stdin pipe and `SEARXNG_EXIT_ON_STDIN_EOF=1`, so it stops when the pipe closes. The integration tests cover both on all three platforms.
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

You need Python 3.13 and a C compiler (gcc/clang; MSVC on Windows). Run `build/searxng` next to a `settings.yml` (see `nuitka/settings.yml`), or set `SEARXNG_SETTINGS_PATH`. On the first start it unpacks itself to `<user cache dir>/searxng/<version>-<hash>/` (`$XDG_CACHE_HOME` or else `~/.cache` on Linux and macOS, `%LOCALAPPDATA%` on Windows). Later starts reuse that directory. The hash covers everything that goes into the binary (sources, flags, installed package versions), so a new build never reuses a stale extraction. The server executable in it (`searxng.bin`, `searxng.exe` on Windows; `server_executable` in `build-info.json`) also runs on its own, without the launcher.

## Releasing

`.github/workflows/release.yml` runs on `v*` tags; started by hand it is a full dry run without the publish job. It calls the ci workflow (build, smoke test and client tests on every platform), then:

1. `scripts/assemble-packages.ts` turns the build artifacts into `@searxng-js/<target>` packages (binary, `index.js` for Node, `index.bun.js` for Bun's file import, `BUILD-INFO.json` with the SHA-256, AGPL `LICENSE`, `THIRD-PARTY-NOTICES.md` with the corresponding source, `licenses/` from the bundled Python distributions and CPython).
2. `scripts/pack.ts` packs them and the main package, adding `optionalDependencies` on the platform packages at the same version only for `npm pack`.
3. `scripts/install-test.ts` installs the tarballs through a local registry on Linux, macOS and Windows, with npm (checked under Node) and bun (checked under Bun, and as a `bun build --compile` executable run without `node_modules`). Each install must pick exactly its platform package and start SearXNG with `startServer()` alone.
4. On a tag, the publish job publishes the platform packages, waits until the registry serves them (`scripts/wait-for-packages.ts`), publishes the main package, and creates the GitHub release with the tarballs and `SHA256SUMS`. It uses npm trusted publishing: GitHub's OIDC token, no npm token, provenance added by npm. It runs in the GitHub environment `npm`, where you can require an approval.

The tag must match `packages/client/package.json`'s version; versions with a `-suffix` go to that dist-tag (`0.2.0-rc.1` → `rc`) and become a prerelease.

First release: npm can only trust a package that exists, and a new trust configuration expires unless it publishes within 2 days. So:

1. Run the release workflow by hand and let it pass.
2. Logged in to npm (`npm login`) as an owner of the `@searxng-js` org, with 2FA and npm 11.15 or newer: `bun scripts/bootstrap-npm.ts` (try `--dry-run` first). It publishes a deprecated placeholder `0.0.0` of each package and trusts `release.yml` of this repository (environment `npm`) for each.
3. Within 2 days: `git tag v0.1.0 && git push origin v0.1.0`.

## Results in CI

From [run 40517037308](https://github.com/AkaraChen/searxng/actions/runs/40517037308) (commit `54eec30`), via `smoke.py` on GitHub-hosted runners. Starts are timed until `/healthz` answers. "Cold" means the extraction cache was removed first; "warm" is the second start. Every binary has the same default build flags (no `--trim-babel`). "Engines" is how many engines `/config` lists; on every platform only `ahmia` and `torch` are missing, as onion engines need `outgoing.using_tor_proxy`.

| platform | built on | run on | size | cold | warm | engines | smoke | client tests |
|---|---|---|---|---|---|---|---|---|
| linux-x64 | ubuntu-22.04 (glibc 2.35) | ubuntu-22.04 | 32.0 MiB | 1.71 s | 1.31 s | 261 | OK | 18/18 |
| linux-x64 | (same binary) | ubuntu-26.04 (glibc 2.43) | 32.0 MiB | 1.72 s | 1.41 s | 261 | OK | 18/18 |
| darwin-arm64 | macos-26 | macos-26 | 28.1 MiB | 1.96 s | 1.49 s | 261 | OK | 18/18 |
| win32-x64 | windows-2025 | windows-2025 | 26.1 MiB | 3.81 s | 1.51 s | 261 | OK | 18/18 |

Results plus infoboxes per smoke query, from the same run. Only the Wikipedia query is enforced. From CI IP ranges, DuckDuckGo, Google News and Reuters are usually listed as unresponsive, and Brave sometimes is; the other engines carry the results.

| query | linux (22.04) | linux (26.04) | macOS | Windows |
|---|---|---|---|---|
| wikipedia (`engines=wikipedia`) | 1 | 1 | 1 | 1 |
| general: `rust borrow checker` | 37 | 37 | 37 | 37 |
| news: `climate summit` | 81 | 81 | 81 | 80 |
| images: `golden gate bridge` | 354 | 345 | 344 | 345 |
| `site:github.com nuitka onefile` | 30 | 30 | 31 | 30 |
| zh-CN: `量子计算` | 40 | 40 | 40 | 40 |
| ja: `東京 ラーメン` | 20 | 20 | 20 | 20 |
| de: `Wetter Berlin` | 24 | 26 | 24 | 23 |

Binary sizes of the 0.1.3 release build ([run 40809851151](https://github.com/AkaraChen/searxng/actions/runs/40809851151); bytecode, full libpython strip, no lxml extras): linux-x64 22.6 MiB (23,705,816 B), darwin-arm64 22.0 MiB (23,039,776 B), win32-x64 21.0 MiB (21,979,136 B). The table above predates the bytecode build.

Build time on the runners: Linux 8 min, macOS 14 min, Windows 22 min (no compiler cache).

## Results (Linux x86-64, measured locally)

Measured on an 8-core machine that was under heavy load. "Cold" means the extraction cache was removed first; "warm" is the second start. Both are timed until `/healthz` answers. RSS is the onefile bootstrap plus the SearXNG child after one search. Every step was checked with JSON searches; the `ui` step was also checked for zh-CN and de.

| step (cumulative) | size | cold | warm | RSS | unpacked | JSON search |
|---|---|---|---|---|---|---|
| baseline: untrimmed onefile | 52.6 MiB | 1.44 s | 1.25 s | 221 MiB | 220 MiB | ok |
| deps: stub pygments, typer, valkey; frozen version | 44.8 MiB | 1.26 s | 1.07 s | 196 MiB | 188 MiB | ok |
| ui: drop static, translations, fastText model, ahmia list | 42.1 MiB | 1.17 s | 1.00 s | 194 MiB | 176 MiB | ok |
| **strip: strip extension modules (Linux)** | **33.7 MiB** | 1.13 s | 1.06 s | 185 MiB | 140 MiB | ok |
| + ship SearXNG's `.py` sources (default build up to 0.1.1) | **33.8 MiB** | 1.22 s | 1.01 s | – | – | ok, 261 engines |
| *optional* nodoc: `no_docstrings`, `no_asserts` | 33.1 MiB | 1.11 s | 0.94 s | 180 MiB | 138 MiB | ok |
| *optional* babel: only `sxng_locales` locale data (`--trim-babel`) | 29.0 MiB | 1.19 s | 1.02 s | 176 MiB | 115 MiB | ok, but see Risk |

For comparison, the official Docker image is about 98 MB. SearXNG from source in a venv starts in about 0.57 s with 111 MiB RSS.

Notes:
- zstd onefile compression is active: the payload compresses to about 25%.
- The bootstrap process stays resident (about 55 MiB RSS, mostly its own mapped payload), and the child is about 170 MiB. These rows predate the bytecode build (see below), which uses less.
- Even when warm, the onefile bootstrap adds about 0.5 s and 35 MiB over running the unpacked dist. It decompresses the whole payload and CRC32-checks every extracted file on every start. The JS client therefore runs the extracted server executable directly after the first start (see Client).
- What the default build was made of before the bytecode build, compressed: Nuitka-compiled code 13 MB, libpython 7.7 MB, babel locale data 6.1 MB, curl_cffi 2.6 MB, lxml 2.5 MB, SearXNG data and sources 1.5 MB.
- curl_cffi's 41 MB `_wrapper.abi3.so` is mostly debug symbols. Stripped, it is 6.8 MB (2.6 MB compressed), so it is not a size floor.

### Since the bytecode build

Same machine, measured on 2026-10-29. Sizes are the onefile binary.

| step (cumulative) | size | change |
|---|---|---|
| bytecode build (0.1.2) | 24.8 MiB (26,052,816 B) | |
| + full strip of libpython | 23.4 MiB (24,516,816 B) | −1.46 MiB |
| + no `lxml.objectify`, `lxml.sax`, `lxml.builder` (0.1.3, default) | **23.0 MiB** (24,070,352 B) | −0.44 MiB |
| *optional* `--trim-babel` on the 0.1.2 build | 20.7 MiB (21,747,920 B) | −4.1 MiB |

- **libpython:** it reaches the dist without passing through Nuitka's `onCopiedDLL` hook, so `strip_plugin.py` strips it in `onStandaloneDistributionFinished`. It is linked with `--emit-relocs`: its `.rela.*` sections (not loaded) reference every symbol, so `--strip-unneeded` removes nothing and only `--strip-all` shrinks it, from 30.7 to 20.1 MB. The dynamic symbol table that extension modules link against stays. Idle RSS is unchanged.
- **lxml:** SearXNG and its engines use only `lxml.etree` and `lxml.html`, and `lxml.html` does not import `lxml.builder` (only the unused `lxml.html.builder` does).
- **What the 0.1.3 build is made of, compressed:** libpython 6.6 MB, babel locale data 6.4 MB, the executable with all bytecode 4.2 MB, curl_cffi 2.6 MB, SearXNG data and sources 2.2 MB, lxml 1.0 MB. `searxng.bin` is already stripped.
- **Memory of the extracted server** (`searxng.bin` alone, default settings, 261 engines): 94 MiB RSS idle, 125 MiB after 40 searches, and a plateau of 134 MiB after 120 searches including images. Of that, 59, 86 and 96 MiB are anonymous memory; the rest is clean file-backed pages of the executable and libraries. CPython running the same SearXNG from source idles at 79 MiB.
- **Where the idle heap goes** (tracemalloc under CPython, 49 MiB): 19 MiB of code objects from about a thousand imported modules, 11 MiB of JSON data (engine traits for every configured engine 6.2 MiB, external bangs 2.1 MiB, engine descriptions 1.9 MiB) and 3 MiB of metrics histograms. All three come from SearXNG itself; the engine count is the lever (`use_default_settings.engines.keep_only`).
- **Throughput** (werkzeug, thread per connection): `/healthz` 686 requests/s from 1 connection and 631 from 8; `/config` 411 from 8. CPython from source: 725, 816 and 391. A search is bound by the engines' network round trips: about 30 ms with `engines=wikipedia`, 0.8–1.2 s for a default general search.

## How it works, and what broke under Nuitka

- **Engines are loaded by file path.** `searx/engines/__init__.py` loads each configured engine with `spec_from_file_location("<name>.py")`, creating a fresh module per engine entry, because `xpath`, `json_engine` and others back several engines with different settings. A compiled build has no `.py` files, so every engine silently failed to load. Redirecting to compiled modules is not safe either: Nuitka keeps a compiled module's globals in C statics, so a second instance would clobber the first. The build ships `searx/**/*.py` as data instead. Engines then run as ordinary bytecode, exactly as upstream does, and answerers (found by `iterdir()`) work too. `pyc_plugin.py` adds precompiled `.pyc` files for them, so that no start compiles about 180 engine modules. Nuitka leaves `__pycache__` out of package data, so the plugin registers the files itself. They are unchecked-hash `.pyc` files: Python uses them without comparing against the source's mtime, which extraction does not keep. `smoke.py` fails if any `.pyc` in the extraction was written at runtime.
- **The error recorder needs source lines.** `searx/metrics/error_recorder.py` uses `inspect.trace()[…].code_context[0]`, which is `None` for compiled frames without a source file. Every engine error crashed the handler, which skipped engine suspension. The shipped sources fix that as well.
- **Stubs** (`nuitka/sxng_stubs.py`, installed by `run.py` only when a module is missing):
  - `pygments`: HTML code highlighting only. Nuitka's package config would otherwise compile all 327 lexer modules, about 125 MB of C.
  - `typer`: the `python -m searx.*` CLIs only, but imported at module level by `searx/enginelib` and `searx/favicons/cache.py`.
  - `valkey`: used only when `valkey.url` is set.
  - `pwd`: missing on Windows, and imported by `searx/valkeydb.py`.
- **Static files:** settings validation requires `ui.static_path` to be a directory, so `run.py` creates an empty `searx/static` in the extraction directory.
- **Version:** `searx.version freeze` runs at build time, so the binary does not run `git` at every start.
- **Bytecode, not compiled C.** Compiled code is several times larger than bytecode, and the pages an import touches stay resident. With every module compiled, the extracted server used 117 MiB RSS idle and about 150 MiB after four searches, against 79 and 110–116 MiB for the same SearXNG run from source by CPython. All of the difference was the executable's code pages. `bytecode_plugin.py` makes Nuitka include every module as bytecode except the entry point and its plugin-generated trigger modules, which Nuitka requires compiled. That gives 95 MiB idle and about 120 MiB after four searches, a 24.8 MiB binary instead of 33.8 MiB, and a build half as long; starts are as fast. What remains over CPython is mostly the bytecode the executable carries, in clean file-backed pages the kernel can reclaim. Compiled code has `importlib.metadata` version lookups resolved at build time, and bytecode does them at run time, so the build includes the metadata of the distributions that look themselves up (`METADATA` in `build.py`). Without it, the binary fails at start with `PackageNotFoundError: curl_cffi`.
- **Two malloc arenas.** glibc gives each allocating thread its own arena, up to 8 per core, and the server runs a thread per request plus SearXNG's per-engine threads. `run.py` calls `mallopt(M_ARENA_MAX, 2)` on Linux before any thread starts, which saves about 10 MiB RSS after four searches. `MALLOC_ARENA_MAX` in the environment takes precedence.
- **Untrimmed builds** also need `--include-module=pygments.formatters.html`. pygments loads formatters lazily and Nuitka's config doesn't cover that.
- **Stopping.** The binary is a onefile launcher that runs the server as a child. On SIGTERM the launcher sends the child SIGINT and SIGKILLs it 5 s later. On macOS the child's default KeyboardInterrupt shutdown took longer than that, so a client that SIGKILLed the launcher after its own 5 s orphaned the child. `run.py` now exits at once on SIGINT/SIGTERM, and the client waits 10 s before SIGKILL. On Windows, terminating the launcher does not end the child: in CI it was still serving 30 s later, even though Nuitka's runtime is meant to stop the child when the launcher dies. Kill the process tree there (`taskkill /T /F /PID <pid>`), as the client does. Independently, `SEARXNG_EXIT_ON_STDIN_EOF=1` makes the server exit when stdin closes, which covers a parent that dies without cleaning up.
- **Time zones on Windows.** Windows has no system time zone database, so `zoneinfo` needs the `tzdata` package. Without it the `bilibili` engine failed to load, and the weather answerer and `time_zone` plugin had no zones. The Windows build installs it, and Nuitka bundles it.

## Risk

What is removed:
- **pygments:** `Code` results lose syntax highlighting in HTML; JSON is unaffected.
- **typer:** the maintenance CLIs.
- **valkey:** setting `valkey.url` raises at startup instead of connecting. That rules out the limiter with valkey and the `valkey_server` engine.
- **Static files and translations:** the HTML UI renders without CSS/JS and in English only. That is out of scope here.
- **fastText model:** nothing reads it.
- **ahmia blacklist:** it is used only with `outgoing.using_tor_proxy`.
- **babel locale data, only with `--trim-babel`:** languages in `searx/sxng_locales.py`, which are all the UI offers, behave exactly as untrimmed. Tested: zh-CN, zh-TW, zh-HK, de, de-CH, de-AT, ja, fr, fr-CA, pt-BR, ru, ar, ko, fil-PH, ca-ES, en-IN, es-MX, af, cy, gl, all and auto. Other languages are still accepted through the API (`language=`), a query prefix or a saved preference. For them some engines lose their language or region instead of falling back wholesale to English, because most engines map the tag through their own traits. Compared on engine request parameters (2026-10-29):
  - `Accept-Language` becomes `en-US,en;q=0.9` for every such language.
  - Bing drops `setlang`/`cc` (sw, gsw, is, hy, ka, ky, uz).
  - Brave degrades `ui_lang`/`country` (sw, gsw), and DuckDuckGo's `kl` becomes `wt-wt` (is).
  - Google switches to `hl=en` only for region-qualified tags such as `sw-KE`; `eu` keeps `hl=eu`.
  - Wikipedia's subdomain, the hosts contacted and the query text are unchanged. Nothing errors, and no engine is skipped.

What can break on a SearXNG upgrade:
- a new module-level import of something stubbed or excluded (pygments, typer, valkey, `lxml.objectify`, `lxml.sax`, `lxml.builder`; `lxml.html.builder` imports the last). The build still succeeds, but the binary fails at start with Nuitka's "actively excluded" ImportError, and `smoke.py` catches that.
- another file-system lookup of package contents. That is how both bugs above were found; the smoke test's `engines loaded ≥ 100` check catches engine loading.
- new lazily imported modules that Nuitka cannot see.
- `/config` or result fields that change shape, which needs updating `packages/client/src/types.ts`.

## Upkeep

All trims are build flags, small Nuitka user plugins (`strip_plugin.py`, `pyc_plugin.py`, `babel_plugin.py`) and the entry script with its stubs. SearXNG's source is never patched. An upgrade means bumping `SEARXNG_COMMIT` (and `VERSION`) in `nuitka/build.py` and letting CI run. The stubs need attention only if SearXNG starts *calling* into pygments, typer or valkey on the JSON path. The `--trim-babel` keep list is computed from the SearXNG source at build time.

## Portability

- **Linux:** the binary needs the build host's glibc or newer, because Nuitka-compiled code picks up the host's symbol versions. A local build on glibc 2.43 needs `GLIBC_2.38`. The CI build on ubuntu-22.04 needs `GLIBC_2.35` at most (checked with `objdump -T` on the binary and every unpacked `.so`), so it runs on Ubuntu 22.04, Debian 12 and newer; CI also tests it on ubuntu-26.04. The bundled extensions need ≤ 2.28 (lxml is `manylinux_2_28`, curl_cffi and libpython 2.17). To get a 2.28 floor, build in a `manylinux_2_28` container.
- **musl/static:** not realistic. curl_cffi has musllinux wheels, but Nuitka onefile, python-build-standalone's static musl build and extension modules don't combine into a working fully static binary. Use the glibc build or a container.
- **arm64 Linux:** the same build on an arm64 runner. All wheels exist for aarch64; it is not in CI yet.
- **macOS:** built and tested on arm64 (`macos-26`) in CI. x86-64 would need an Intel runner (`macos-15-intel` or `macos-26-intel`). Not signed or notarized, so a downloaded binary needs `xattr -d com.apple.quarantine`.
- **Windows:** x64 on `windows-2025` with MSVC from Visual Studio 2026. `pwd` is stubbed and `tzdata` is bundled. Stop the server by killing the process tree, not just the launcher (see Stopping). `smoke.py` does that and checks that the port is released; it also terminates only the launcher once and reports how long the orphaned child lives.

## Licences

- **This repository:** AGPL-3.0-or-later, except `packages/client` (`@searxng-js/searxng`), which is MIT: it only spawns the binary and talks HTTP to it. The binary packages are AGPL-3.0-or-later.
- **SearXNG** is AGPL-3.0-or-later. Anyone who distributes a binary must offer the corresponding source. That source is SearXNG at the pinned commit plus this repository (build flags, plugins, entry script, stubs). Shipping the `.py` sources inside the binary does not replace that offer.
- **curl_cffi** is MIT. Its wheel statically links curl-impersonate/libcurl (curl licence), BoringSSL (OpenSSL/SSLeay and ISC for older code, Apache-2.0 for newer code), nghttp2/nghttp3 (MIT), brotli (MIT), zstd (BSD), zlib, and libidn2 (LGPL-3.0+/GPL-2.0+). The wheel ships only curl_cffi's own MIT text; `nuitka/third-party-licenses/` has their full texts at the pinned versions (plus libidn2's libunistring, c-ares, ngtcp2, and what lxml, PyYAML and cffi link), and every binary package ships them in `licenses/static/` together with the licence files of all bundled Python distributions and CPython.
- **Others:** CPython (PSF), lxml (BSD) with libxml2/libxslt (MIT), babel (BSD, CLDR data under the Unicode licence), Flask/Werkzeug/Jinja2 (BSD), PyYAML (MIT), msgspec (BSD), certifi (MPL-2.0). Nuitka's runtime is compiled into the binary; it is AGPL-3.0 with the Nuitka Runtime Library Exception.

## Remaining optimizations (not done)

Estimates are compressed sizes on Linux.

- **Drop the bundled copies of engines** (now bytecode, so less than the 2.5 MB they were compiled). They are dead weight because engines run from the shipped sources. This needs `--nofollow-import-to=searx.engines.*` plus `--no-deployment-flag=excluded-module-usage`, and an explicit `--include-module` list for modules that only engines import. The list would be generated from a previous build's `report.xml`.
- **`--trim-babel`** (4.1 MiB) already exists as an opt-in; see Risk for what it changes. A lossless middle set, all locales SearXNG's tables reach, saves only about 1 MB.
- **`no_docstrings`/`no_asserts`** (0.6 MB): tested to work, but left out for the risk.
- **Strip on macOS** (`strip -x` before Nuitka re-signs). Check whether the macOS curl_cffi wheel is unstripped too.
- **Fewer engines at run time, not in the build:** the default settings load all 261 engines, and engine modules, their traits and metrics all scale with that. `use_default_settings.engines.keep_only` cuts memory, start time and the latency of a default search; the client could take an engine list and write it. `general.enable_metrics: false` saves almost no memory: SearXNG's no-op histograms still allocate their buckets.
- **Smaller stdlib:** `_pyrepl`, `__hello__` and similar (< 0.3 MB).
- **CI:** cache Nuitka/ccache between runs; add linux-arm64 and macos-x64; use a manylinux_2_28 container for Linux.

## Verdict

At most 50 MB is easily achievable: 23.0 MiB on Linux with the default build (0.1.3, measured locally), or 20.7 MiB with `--trim-babel` if languages outside the UI's list may lose their engine-specific language parameters. What is left is mostly libpython, babel's locale data, curl_cffi and the bytecode of what SearXNG imports. The cost is not size but fidelity work: two real breakages (engine loading, the error recorder) only showed up in the compiled build, and every SearXNG upgrade needs the CI smoke test. Compared with the official Docker image (about 98 MB, needs Docker) or a portable Python plus venv (about 150–200 MB unpacked, starts faster, no compile step), the single binary is worth it for embedding: one file per platform, no runtime dependency, started by `startServer()`. It is not worth it if your app can ship a directory, in which case the standalone dist without onefile is the better trade-off.
