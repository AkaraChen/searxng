# Entry point: SearXNG's Flask app served by werkzeug (no gunicorn/uwsgi).
# Settings: $SEARXNG_SETTINGS_PATH, else settings.yml next to the executable.
import importlib.util
import os
import sys

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

run_simple(settings["server"]["bind_address"], int(settings["server"]["port"]), app, threaded=True)
