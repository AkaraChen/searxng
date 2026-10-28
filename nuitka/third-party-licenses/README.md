# Licences of statically linked native code

Python wheels ship the licence of the Python project, but not always the licences of the C libraries
they link statically. The texts here fill that gap for what goes into the binary. They are pinned to
the versions the wheels in `searxng/requirements.txt` were built with. Update them when a wheel
changes its bundled libraries. `scripts/assemble-packages.ts` copies this directory into every binary
package as `licenses/static/`, next to the licence files that `build.py` collects from the installed
distributions and CPython.

## curl_cffi 0.17.0 (`curl_cffi/_wrapper`)

curl_cffi links [curl-impersonate](https://github.com/lexiforest/curl-impersonate) 2.3.1. That is
statically linked on Linux and macOS, and a bundled DLL on Windows. Its dependencies, with versions
from curl-impersonate's `CMakeLists.txt` and `scripts/build-libidn2.sh` at v2.3.1:

| component | version | licence | text |
|---|---|---|---|
| curl-impersonate | 2.3.1 | MIT | `curl-impersonate-2.3.1/LICENSE` |
| curl (libcurl) | 8.23.0 | curl (MIT-style) | `curl-8.23.0/COPYING` |
| BoringSSL | 156c7b75ae9b | Apache-2.0, plus OpenSSL/SSLeay and ISC for older parts | `boringssl-156c7b75/LICENSE` |
| nghttp2 | 1.63.0 | MIT | `nghttp2-1.63.0/COPYING` |
| ngtcp2 | 1.20.0 | MIT | `ngtcp2-1.20.0/COPYING` |
| nghttp3 | 1.15.0 | MIT | `nghttp3-1.15.0/COPYING` |
| c-ares | 1.34.9 | MIT | `c-ares-1.34.9/LICENSE.md` |
| brotli | 1.2.1 | MIT | `brotli-1.2.1/LICENSE` |
| zstd | 1.5.7 | BSD-3-Clause (dual with GPL-2.0; BSD used) | `zstd-1.5.7/LICENSE` |
| zlib | 1.3.1 | zlib | `zlib-1.3.1/LICENSE` |
| libidn2, with its included libunistring subset (Linux only) | 2.3.7 | GPL-2.0-or-later or LGPL-3.0-or-later; Unicode data under the Unicode licence | `libidn2-2.3.7/` |

libidn2 is dual-licensed. This distribution uses it under GPL-2.0-or-later, which combines with the
AGPL-3.0-or-later of the whole binary; the complete corresponding source is offered for all of it.

## Other wheels

| wheel | bundled native code | licence | text |
|---|---|---|---|
| lxml | libxml2, libxslt, libexslt, zlib, libiconv | MIT; zlib; LGPL-2.1 (libiconv) | libxml2/libxslt: in lxml's own `LICENSES.txt`; zlib: `zlib-1.3.1/LICENSE`; libiconv: `libiconv/COPYING.LIB` |
| PyYAML | libyaml 0.2.5 | MIT | `libyaml-0.2.5/License` |
| cffi | libffi (where the wheel bundles it) | MIT | `libffi/LICENSE` |

libiconv is LGPL-2.1, used here under its section 3 option of GPL-2.0-or-later, as part of the
AGPL-3.0-or-later binary whose complete corresponding source is offered.

## CPython and the libraries it brings

`licenses/CPython-*/LICENSE.txt` (collected at build time) is CPython's own licence. CPython also
incorporates third-party code whose licences are in its documentation: `cpython-3.13/license.rst`
(Doc/license.rst of CPython 3.13.16), with OpenSSL, expat, libffi, zlib, libmpdec, mimalloc,
HACL* and others.

CPython's extension modules link libraries that Nuitka copies into the binary. Which ones depends on
how the build's Python was made (actions/setup-python), so `licenses/NATIVE-LIBRARIES.txt` lists them
per build, and `scripts/assemble-packages.ts` refuses a build that contains a library not covered here.

| library | platforms | licence | text |
|---|---|---|---|
| OpenSSL 3 (libssl, libcrypto) | all | Apache-2.0 | OpenSSL section of `cpython-3.13/license.rst` |
| libffi | Linux, Windows (and in cffi) | MIT | `libffi/LICENSE` |
| bzip2 1.0.8 | Linux; static in `_bz2` elsewhere | bzip2 (BSD-style) | `system-libs/bzip2-1.0.8/LICENSE` |
| XZ Utils / liblzma 5.2 | Linux; static in `_lzma` elsewhere | public domain (5.2) | `system-libs/xz-5.2.5/COPYING` |
| SQLite | Linux, Windows; static in `_sqlite3` on macOS | public domain | `system-libs/sqlite/PUBLIC-DOMAIN.txt` |
| GNU readline 8 | Linux | GPL-3.0-or-later (combined with the AGPL-3.0 binary under AGPL section 13) | `system-libs/readline-8/COPYING` |
| ncurses 6.3 (libtinfo) | Linux | MIT-X11 | `system-libs/ncurses-6.3/COPYING` |
| libuuid (util-linux 2.37) | Linux | BSD-3-Clause | `system-libs/libuuid-2.37/` |
| Microsoft Visual C++ runtime (vcruntime140) | Windows | Microsoft's redistributable runtime, shipped with the official CPython for Windows | – |

The versions are those of the CI images the binaries are built on (ubuntu-22.04 for Linux); the
licences have not changed across those versions.
