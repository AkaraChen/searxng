#!/usr/bin/env python3
"""Build SearXNG as one self-contained executable with Nuitka (onefile).

    python build.py fetch              # shallow-fetch SearXNG at SEARXNG_COMMIT into ./searxng
    python build.py build [--trim-babel] [-- extra Nuitka flags]

`build` must run in a Python with SearXNG's requirements and
requirements-build.txt installed. Output: build/searxng[.exe],
build/build-info.json (read by smoke.py) and build/licenses/ (the licence
files of the bundled Python distributions and CPython).
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SEARXNG_REPO = "https://github.com/searxng/searxng"
SEARXNG_COMMIT = "ef7bae9ddbec3f4e6690595adf793acf601e9884"  # 2026-10-27
# Nuitka product version; on Windows it must be four numbers, each <= 65535.
VERSION = "2026.10.27.0"
SEARXNG_DIR = os.path.join(HERE, "searxng")
OUT_DIR = os.path.join(HERE, "build")
EXE = "searxng.exe" if sys.platform == "win32" else "searxng"


def run(cmd, **kwargs):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def fetch():
    if not os.path.isdir(os.path.join(SEARXNG_DIR, ".git")):
        run(["git", "init", "-q", SEARXNG_DIR])
    # Only what the build needs. The full tree has a path Windows cannot have
    # (utils/templates/...:socket); protectNTFS=false lets git read the tree
    # into the index, and the sparse patterns keep that file off the disk.
    run(["git", "-C", SEARXNG_DIR, "sparse-checkout", "set", "--no-cone", "/searx/", "/requirements*.txt", "/LICENSE"])
    run(["git", "-C", SEARXNG_DIR, "fetch", "-q", "--depth", "1", SEARXNG_REPO, SEARXNG_COMMIT])
    run(["git", "-C", SEARXNG_DIR, "-c", "core.protectNTFS=false", "checkout", "-q", "--force", "FETCH_HEAD"])


def freeze_version():
    # SearXNG's own mechanism for release archives: without it the binary runs
    # `git` at every start. GITHUB_* tell it the upstream URL/branch.
    env = dict(os.environ, GITHUB_REPOSITORY="searxng/searxng", GITHUB_REF_NAME="master")
    run([sys.executable, "-m", "searx.version", "freeze"], cwd=SEARXNG_DIR, env=env)


def nuitka_flags(trim_babel):
    flags = [
        "--onefile",
        "--assume-yes-for-downloads",
        f"--output-dir={OUT_DIR}",
        f"--output-filename={EXE}",
        "--product-name=searxng",
        f"--product-version={VERSION}",
        f"--report={os.path.join(OUT_DIR, 'report.xml')}",
        "--include-package=searx",
        "--include-package-data=searx",
        # Ship SearXNG's .py sources as data: it finds engines and answerers as
        # files on disk (engines via spec_from_file_location, one fresh module
        # per configured engine; they run as plain bytecode, like upstream), and
        # its error recorder reads source lines of the failing frame
        # (inspect.trace().code_context), which are None without the files.
        "--include-package-data=searx:*.py",
        # Imported at module level but never called by the JSON API;
        # sxng_stubs.py stands in for them. Nuitka's own config would otherwise
        # pull in every pygments lexer (~125 MB of generated C).
        "--nofollow-import-to=pygments",
        "--nofollow-import-to=typer",
        "--nofollow-import-to=valkey",
        # Web UI assets (run.py leaves an empty static dir), the unused fastText
        # model, and the ahmia blacklist (only loaded with a Tor proxy).
        "--noinclude-data-files=searx/static/**",
        "--noinclude-data-files=searx/translations/**",
        "--noinclude-data-files=searx/data/lid.176.ftz",
        "--noinclude-data-files=searx/data/ahmia_blacklist.txt",
        # Strip extension modules (Linux; curl_cffi ships 41 MB unstripped).
        f"--user-plugin={os.path.join(HERE, 'strip_plugin.py')}",
    ]
    if trim_babel:
        flags.append(f"--user-plugin={os.path.join(HERE, 'babel_plugin.py')}")
    return flags


def cache_key(flags):
    # The onefile payload is extracted once to {CACHE_DIR}/searxng/<key> and
    # reused; the key changes whenever anything that goes into the binary does.
    h = hashlib.sha256()
    for name in ("run.py", "sxng_stubs.py", "build.py", "strip_plugin.py", "babel_plugin.py", "settings.yml"):
        with open(os.path.join(HERE, name), "rb") as f:
            h.update(f.read())
    # Installed versions too: SearXNG's dependencies, Nuitka, tzdata on Windows.
    installed = sorted(f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions())
    h.update(json.dumps([SEARXNG_COMMIT, VERSION, flags, sys.version, platform.machine(), installed]).encode())
    return f"{VERSION}-{h.hexdigest()[:12]}"


# Installed only to build; nothing of theirs is in the binary.
BUILD_ONLY = {"ordered-set", "patchelf", "pip", "setuptools", "wheel", "zstandard"}


def collect_licenses():
    """Copies the licence files of every installed distribution that can end up
    in the binary, plus CPython's, to build/licenses/<name>-<version>/."""
    out = os.path.join(OUT_DIR, "licenses")
    names = re.compile(r"(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", re.I)
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        if name is None or name.lower() in BUILD_ONLY:
            continue
        for file in dist.files or []:
            if ".dist-info" in str(file) and names.search(file.name):
                dest = os.path.join(out, f"{name}-{dist.version}", file.name)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copyfile(dist.locate_file(file), dest)
    for candidate in (
        os.path.join(sys.base_prefix, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "LICENSE.txt"),
        os.path.join(sys.base_prefix, "LICENSE.txt"),
    ):
        if os.path.exists(candidate):
            dest = os.path.join(out, f"CPython-{platform.python_version()}", "LICENSE.txt")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(candidate, dest)
            break


def build(trim_babel, extra):
    if not os.path.isdir(SEARXNG_DIR):
        sys.exit("SearXNG is missing; run `python build.py fetch` first")
    freeze_version()
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    os.makedirs(OUT_DIR)
    # The interpreter's scripts dir first: Nuitka needs the pip-installed patchelf on Linux.
    path = os.pathsep.join([os.path.dirname(sys.executable), os.environ.get("PATH", "")])
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([SEARXNG_DIR, HERE]), PATH=path)
    if trim_babel:
        keep = os.path.join(OUT_DIR, "babel-keep.txt")
        with open(keep, "w", encoding="utf-8") as f:
            run(
                [sys.executable, os.path.join(HERE, "babel_locales.py"), "--sxng-only"],
                env=dict(env, SEARXNG_SETTINGS_PATH=os.path.join(HERE, "settings.yml")),
                stdout=f,
            )
        env["SXNG_BABEL_KEEP"] = keep
    flags = nuitka_flags(trim_babel) + extra
    key = cache_key(flags)
    flags.append(f"--onefile-tempdir-spec={{CACHE_DIR}}/searxng/{key}")
    start = time.monotonic()
    run([sys.executable, "-m", "nuitka", *flags, os.path.join(HERE, "run.py")], env=env, cwd=OUT_DIR)
    binary = os.path.join(OUT_DIR, EXE)
    info = {
        "binary": binary,
        "size": os.path.getsize(binary),
        "build_seconds": round(time.monotonic() - start),
        "cache_subdir": f"searxng/{key}",
        "searxng_commit": SEARXNG_COMMIT,
        "platform": f"{sys.platform}-{platform.machine().lower()}",
        "python": platform.python_version(),
    }
    with open(os.path.join(OUT_DIR, "build-info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)
    collect_licenses()
    print(json.dumps(info, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    b = sub.add_parser("build")
    b.add_argument("--trim-babel", action="store_true", help="keep only the babel locales of searx/sxng_locales.py")
    b.add_argument("extra", nargs=argparse.REMAINDER, help="extra Nuitka flags (after --)")
    args = parser.parse_args()
    if args.cmd == "fetch":
        fetch()
    else:
        build(args.trim_babel, [a for a in args.extra if a != "--"])


if __name__ == "__main__":
    main()
