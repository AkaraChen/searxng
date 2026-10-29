"""Nuitka user plugin: strip debug symbols from extension modules and DLLs
copied into the standalone dist, before onefile compression (Linux only).

Wheels such as curl_cffi ship unstripped (_wrapper.abi3.so is 41 MB, 6.8 MB
stripped). Use with --user-plugin=strip_plugin.py.
"""

import os
import subprocess
import sys

from nuitka.plugins.PluginBase import NuitkaPluginBase


class NuitkaPluginSxngStrip(NuitkaPluginBase):
    plugin_name = "sxng-strip"
    plugin_desc = "Strip copied extension modules and DLLs (Linux)."

    def __init__(self):
        self.saved = 0

    def onCopiedDLL(self, dll_filename):
        if not sys.platform.startswith("linux"):
            return
        before = os.path.getsize(dll_filename)
        subprocess.run(["strip", "--strip-unneeded", dll_filename], check=True)
        self.saved += before - os.path.getsize(dll_filename)

    def onStandaloneDistributionFinished(self, dist_dir):
        # libpython is copied into the dist without going through onCopiedDLL.
        # It is linked with --emit-relocs: the .rela.* sections (not loaded)
        # reference every symbol in .symtab, so --strip-unneeded keeps them all
        # and only a full strip (which drops those sections) shrinks it, 30 -> 20 MB.
        if sys.platform.startswith("linux"):
            for name in os.listdir(dist_dir):
                if name.startswith("libpython") and ".so" in name:
                    path = os.path.join(dist_dir, name)
                    before = os.path.getsize(path)
                    subprocess.run(["strip", "--strip-all", path], check=True)
                    self.saved += before - os.path.getsize(path)
        self.info(f"stripped {self.saved / 1048576:.1f} MB from extension modules and DLLs")
