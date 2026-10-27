#!/usr/bin/env python3
"""Smoke-test a build: the binary plus settings.yml alone in an empty directory.

    python smoke.py [build/build-info.json]

Fails on: no /healthz within 180 s, fewer than 100 engines loaded, invalid
JSON, no result from Wikipedia (proves outbound TLS through curl_cffi), the
server not exiting on terminate, or the extraction cache not being reused.
Other queries are reported, not enforced: CI IPs get CAPTCHAs.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8899
QUERIES = [
    ("wikipedia (required)", {"q": "python programming language", "engines": "wikipedia"}),
    ("general", {"q": "rust borrow checker"}),
    ("news", {"q": "climate summit", "categories": "news"}),
    ("images", {"q": "golden gate bridge", "categories": "images"}),
    ("site:", {"q": "site:github.com nuitka onefile"}),
    ("zh-CN", {"q": "量子计算", "language": "zh-CN"}),
    ("ja", {"q": "東京 ラーメン", "language": "ja"}),
    ("de", {"q": "Wetter Berlin", "language": "de"}),
]


def nuitka_cache_dir():
    if sys.platform == "win32":
        return os.environ["LOCALAPPDATA"]
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Caches")
    return os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")


def get(path, timeout=30):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=timeout) as r:
        return r.status, r.read()


def port_open():
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def start(binary, cwd, log):
    t0 = time.monotonic()
    proc = subprocess.Popen([binary], cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
    while time.monotonic() - t0 < 180:
        if proc.poll() is not None:
            raise SystemExit(f"server exited with {proc.returncode} before /healthz answered")
        try:
            if get("/healthz", timeout=2) == (200, b"OK"):
                return proc, time.monotonic() - t0
        except OSError:
            pass
        time.sleep(0.1)
    proc.kill()
    raise SystemExit("/healthz did not answer within 180 s")


def stop(proc):
    if sys.platform == "win32":
        proc.terminate()
    else:
        proc.send_signal(signal.SIGTERM)
    rc = proc.wait(timeout=30)
    for _ in range(100):  # the onefile child must go away with the bootstrap
        if not port_open():
            return rc
        time.sleep(0.1)
    raise SystemExit("port still open after terminate: the server child survived")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    info_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "build", "build-info.json")
    with open(info_path, encoding="utf-8") as f:
        info = json.load(f)
    failures = []
    workdir = tempfile.mkdtemp(prefix="searxng-smoke-")
    binary = os.path.join(workdir, os.path.basename(info["binary"]))
    shutil.copy2(info["binary"], binary)
    shutil.copy2(os.path.join(HERE, "settings.yml"), workdir)
    cache = os.path.join(nuitka_cache_dir(), *info["cache_subdir"].split("/"))
    shutil.rmtree(cache, ignore_errors=True)
    log = open(os.path.join(workdir, "server.log"), "w+b")
    rows = []
    try:
        proc, cold = start(binary, workdir, log)
        marker = os.path.join(cache, "searx", "settings.yml")
        marker_mtime = os.stat(marker).st_mtime_ns
        _, body = get("/config")
        engines = len(json.loads(body)["engines"])
        if engines < 100:
            failures.append(f"only {engines} engines loaded")
        for label, params in QUERIES:
            t0 = time.monotonic()
            try:
                _, body = get("/search?" + urllib.parse.urlencode({**params, "format": "json"}))
                data = json.loads(body)
                n = len(data["results"]) + len(data["infoboxes"])
                hit = sorted({e for r in data["results"] for e in r.get("engines", [])})
                bad = sorted({e[0] for e in data.get("unresponsive_engines", [])})
                rows.append((label, f"{time.monotonic() - t0:.1f}s", n, ",".join(hit), ",".join(bad)))
                if "required" in label and n == 0:
                    failures.append(f"{label}: no results")
            except (OSError, ValueError, KeyError) as e:
                rows.append((label, "-", "ERR", repr(e)[:80], ""))
                failures.append(f"{label}: {e!r}")
        rc_cold = stop(proc)
        proc, warm = start(binary, workdir, log)
        if os.stat(marker).st_mtime_ns != marker_mtime:
            failures.append("extraction cache was not reused")
        rc_warm = stop(proc)
    finally:
        log.close()

    summary = [
        f"### {info['platform']} (Python {info['python']})",
        "",
        f"- binary: {info['size'] / 1048576:.1f} MiB, built in {info['build_seconds']} s",
        f"- start to /healthz: cold {cold:.2f} s, warm {warm:.2f} s; engines loaded: {engines}",
        f"- terminate: exit {rc_cold} / {rc_warm}",
        "",
        "| query | time | results + infoboxes | engines | unresponsive |",
        "|---|---|---|---|---|",
        *(f"| {' | '.join(str(c) for c in row)} |" for row in rows),
        "",
        "**FAIL**: " + "; ".join(failures) if failures else "**OK**",
    ]
    text = "\n".join(summary)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text + "\n")
    if failures:
        with open(os.path.join(workdir, "server.log"), encoding="utf-8", errors="replace") as f:
            print(f.read()[-4000:])
    shutil.rmtree(workdir, ignore_errors=True)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
