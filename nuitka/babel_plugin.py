"""Nuitka user plugin: keep only the babel locale-data files listed in
$SXNG_BABEL_KEEP (one locale id per line, as printed by babel_locales.py).

Runs on the standalone dist right before onefile packing. A locale SearXNG
has no data for raises babel.UnknownLocaleError, which searx/locales.py and
searx/weather.py catch and fall back from.
"""

import os

from nuitka.plugins.PluginBase import NuitkaPluginBase


class NuitkaPluginSxngBabel(NuitkaPluginBase):
    plugin_name = "sxng-babel"
    plugin_desc = "Prune babel locale-data to a keep list."

    def onStandaloneDistributionFinished(self, dist_dir):
        with open(os.environ["SXNG_BABEL_KEEP"], encoding="utf-8") as f:
            keep = {line.strip() + ".dat" for line in f if line.strip()}
        locale_dir = os.path.join(dist_dir, "babel", "locale-data")
        removed = 0
        for name in os.listdir(locale_dir):
            if name.endswith(".dat") and name not in keep:
                os.remove(os.path.join(locale_dir, name))
                removed += 1
        self.info(f"kept {len(os.listdir(locale_dir))} babel locale files, removed {removed}")
