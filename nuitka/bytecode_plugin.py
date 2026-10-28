"""Nuitka user plugin: include modules as bytecode instead of compiling them to C.

Compiled code is several times larger than bytecode, and what an import touches
stays resident: compiled, SearXNG's server used about 38 MiB more RSS than the
same SearXNG run from source by CPython, all of it in the executable's code
pages. SearXNG spends its time waiting on the network, so the speed of compiled
code buys little. Only the entry point and Nuitka's plugin-generated trigger
modules stay compiled; Nuitka requires that.

Compiled code has importlib.metadata lookups of package versions resolved at
build time. Bytecode does them at run time, so build.py includes the metadata of
the packages that look themselves up. Use with --user-plugin=bytecode_plugin.py.
"""

from nuitka.plugins.PluginBase import NuitkaPluginBase
from nuitka.utils.ModuleNames import trigger_names


class NuitkaPluginSxngBytecode(NuitkaPluginBase):
    plugin_name = "sxng-bytecode"
    plugin_desc = "Include every module except the entry point as bytecode."

    def decideCompilation(self, module_name):
        if module_name in ("__main__", "__parents_main__") or str(module_name).endswith(trigger_names):
            return None
        return "bytecode"
