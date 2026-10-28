"""Nuitka user plugin: ship precompiled .pyc files next to SearXNG's .py sources.

The build ships searx/**/*.py as data, and engines run from them as bytecode
(see build.py). Without .pyc files every first start compiles ~180 engine
modules, and writes them into the extraction directory. The .pyc files are
unchecked-hash based: Python uses them without looking at the source's mtime,
which extraction does not preserve. Nuitka leaves __pycache__ out of package
data, so this adds them as data files itself. Use with --user-plugin=pyc_plugin.py.
"""

import atexit
import importlib.util
import os
import py_compile
import shutil
import tempfile

from nuitka.plugins.PluginBase import NuitkaPluginBase


class NuitkaPluginSxngPyc(NuitkaPluginBase):
    plugin_name = "sxng-pyc"
    plugin_desc = "Add precompiled .pyc files for SearXNG's shipped .py sources."

    def __init__(self):
        self.staging = tempfile.mkdtemp(prefix="sxng-pyc-")
        # Nuitka reads the files again when it writes the report, at the very end.
        atexit.register(shutil.rmtree, self.staging, ignore_errors=True)

    def considerDataFiles(self, module):
        if module.getFullName() != "searx":
            return
        package_dir = module.getCompileTimeDirectory()
        root = os.path.dirname(package_dir)
        count = 0
        for dirpath, dirnames, filenames in os.walk(package_dir):
            dirnames[:] = [d for d in dirnames if d != "__pycache__"]
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                source = os.path.join(dirpath, name)
                # searx/engines/__pycache__/x.cpython-313.pyc, as the import system looks for it.
                dest = importlib.util.cache_from_source(os.path.relpath(source, root))
                staged = os.path.join(self.staging, dest)
                py_compile.compile(
                    source,
                    cfile=staged,
                    dfile=os.path.relpath(source, root),
                    doraise=True,
                    invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
                )
                count += 1
                yield self.makeIncludedDataFile(staged, dest, "precompiled SearXNG source")
        self.info(f"precompiled {count} SearXNG modules")
