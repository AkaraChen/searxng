#!/usr/bin/env python3
"""Smoke-test a build: the binary plus settings.yml alone in an empty directory.

    python smoke.py [build/build-info.json]

Fails on: no /healthz within 180 s, fewer than 100 engines loaded, an engine
other than the onion ones failing to load, invalid JSON, no result from
Wikipedia (proves outbound TLS through curl_cffi), the server not exiting on
terminate, or the extraction cache not being reused.
Other queries are reported, not enforced: CI IPs get CAPTCHAs.

On Windows, terminate() is TerminateProcess on the onefile bootstrap only, so
the enforced stop kills the process tree (as the JS client does). The warm stop
terminates only the bootstrap and reports how long its orphaned child lives.
"""

import json
import os
import platform
import re
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
    # Nuitka's {CACHE_DIR}: %LOCALAPPDATA% on Windows; on every other system,
    # macOS included, an absolute $XDG_CACHE_HOME or else ~/.cache.
    if sys.platform == "win32":
        return os.environ["LOCALAPPDATA"]
    xdg = os.environ.get("XDG_CACHE_HOME", "")
    return xdg if xdg.startswith("/") else os.path.expanduser("~/.cache")


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


def wait_port_closed(seconds):
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        if not port_open():
            return time.monotonic() - t0
        time.sleep(0.1)
    return None


def stop(proc):
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.send_signal(signal.SIGTERM)
    rc = proc.wait(timeout=30)
    if wait_port_closed(10) is None:  # the onefile child must go away with the bootstrap
        raise SystemExit("port still open after terminate: the server child survived")
    return rc


def stop_bootstrap_only(proc):
    """Windows: TerminateProcess on the bootstrap alone; returns how long the orphaned child lived."""
    query = f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={proc.pid}').ProcessId"
    children = subprocess.run(["powershell", "-NoProfile", "-Command", query], capture_output=True, text=True).stdout.split()
    proc.terminate()
    rc = proc.wait(timeout=30)
    lived = wait_port_closed(30)
    for pid in children:
        subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
    if wait_port_closed(10) is None:
        raise SystemExit("port still open after killing the server child")
    return rc, "survived 30 s" if lived is None else f"exited after {lived:.1f} s"


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
        with open(log.name, "rb") as f:  # not log itself: the server shares its file offset
            not_loaded = re.findall(rb"searx\.engines: \(PID \d+\) (.+?): can't register engine", f.read())
        not_loaded = sorted({n.decode() for n in not_loaded})
        # Onion engines are left out unless outgoing.using_tor_proxy is set.
        if unexpected := [n for n in not_loaded if n not in ("ahmia", "torch")]:
            failures.append(f"engines failed to load: {', '.join(unexpected)}")
        not_loaded = ", ".join(not_loaded) or "-"
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
        if sys.platform == "win32":
            rc_warm, orphan = stop_bootstrap_only(proc)
        else:
            rc_warm, orphan = stop(proc), None
    finally:
        log.close()

    summary = [
        f"### {info['platform']} (Python {info['python']})",
        "",
        f"- run on: {platform.platform(terse=True)}",
        f"- binary: {info['size'] / 1048576:.1f} MiB, built in {info['build_seconds']} s",
        f"- start to /healthz: cold {cold:.2f} s, warm {warm:.2f} s; engines loaded: {engines} (not loaded: {not_loaded})",
        f"- terminate: exit {rc_cold} / {rc_warm}",
        *([f"- bootstrap-only terminate: orphaned server child {orphan}"] if orphan else []),
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
    if failures or (orphan and "survived" in orphan):
        with open(os.path.join(workdir, "server.log"), encoding="utf-8", errors="replace") as f:
            print(f.read()[-4000:])
    shutil.rmtree(workdir, ignore_errors=True)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
