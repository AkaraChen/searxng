# Entry point: SearXNG's Flask app served by werkzeug (no gunicorn/uwsgi).
# Settings: $SEARXNG_SETTINGS_PATH, else settings.yml next to the executable.
# SEARXNG_EXIT_ON_STDIN_EOF=1: exit when stdin closes, i.e. when the process
# holding the other end of a stdin pipe dies (used by the JS client).
import importlib.util
import os
import signal
import sys
import threading

import sxng_stubs

os.environ.setdefault(
    "SEARXNG_SETTINGS_PATH", os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "settings.yml")
)
sxng_stubs.install()

# Builds without the web UI's static files: settings validation requires
# ui.static_path to be a directory, so leave an empty one (in the onefile
# extraction directory) for WhiteNoise to serve nothing from.
os.makedirs(os.path.join(os.path.dirname(importlib.util.find_spec("searx").origin), "static"), exist_ok=True)

from searx.webapp import app  # noqa: E402
from searx import settings  # noqa: E402
from werkzeug.serving import run_simple  # noqa: E402


# The onefile bootstrap passes SIGTERM on as SIGINT and SIGKILLs this process
# 5 s later; Nuitka also raises SIGINT here when the bootstrap dies. On macOS
# the default KeyboardInterrupt shutdown took longer than those 5 s. Nothing
# here needs flushing, so exit at once.
def _exit(reason):
    try:
        print(f"searxng: exiting, {reason}", file=sys.stderr, flush=True)
    except OSError:  # stderr may be a pipe to a process that is gone
        pass
    os._exit(0)


def _exit_now(signum, _frame):
    _exit(f"signal {signum}")


signal.signal(signal.SIGINT, _exit_now)
signal.signal(signal.SIGTERM, _exit_now)


# Nothing ends the onefile bootstrap (and so this process) when the process
# that started it dies without stopping it, e.g. when it is SIGKILLed. Its end
# of a stdin pipe closes then; the JS client starts the server that way.
def _exit_on_stdin_eof():
    while os.read(0, 4096):
        pass
    _exit("stdin closed")


if os.environ.get("SEARXNG_EXIT_ON_STDIN_EOF") == "1":
    threading.Thread(target=_exit_on_stdin_eof, name="stdin-eof", daemon=True).start()

run_simple(settings["server"]["bind_address"], int(settings["server"]["port"]), app, threaded=True)
