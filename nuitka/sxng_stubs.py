"""Stand-ins for packages a trimmed build leaves out (--nofollow-import-to=...).

Each stub is installed only when the real module is missing, so the same entry
script works for the untrimmed build. SearXNG imports these packages at module
level, but with the JSON API, no valkey URL and no `searxng` CLI, nothing calls
into them beyond what is stubbed here.
"""

import html
import importlib.util
import sys
import types


def _module(name: str, **attrs) -> types.ModuleType:
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    sys.modules[name] = mod
    return mod


def _missing(name: str) -> bool:
    if name in sys.modules:
        return False
    try:
        return importlib.util.find_spec(name) is None
    except ImportError:  # Nuitka: "actively excluded from compilation"
        return True


def _pygments():
    # Used only to render code results in the HTML UI (Code.HTML(), the
    # code_highlighter template filter).
    class ClassNotFound(ValueError):
        pass

    class _Lexer:
        name = aliases = None

        def __init__(self, **_options):
            pass

    class HtmlFormatter:
        def __init__(self, **_options):
            pass

        def get_style_defs(self, *_args):
            return ""

    def highlight(code, _lexer, _formatter, outfile=None):
        out = f"<pre>{html.escape(code)}</pre>"
        if outfile is None:
            return out
        outfile.write(out)
        return None

    def get_lexer(*_args, **options):
        return _Lexer(**options)

    _module("pygments", highlight=highlight, __path__=[])
    _module(
        "pygments.lexers",
        get_lexer_by_name=get_lexer,
        guess_lexer=get_lexer,
        guess_lexer_for_filename=get_lexer,
        __path__=[],
    )
    _module("pygments.lexers._mapping", LEXERS={})
    _module("pygments.util", ClassNotFound=ClassNotFound)
    _module("pygments.formatters", HtmlFormatter=HtmlFormatter)


def _typer():
    # Used only by the `python -m searx.*` maintenance CLIs.
    class Typer:
        def __init__(self, *_args, **_kwargs):
            pass

        def command(self, *_args, **_kwargs):
            return lambda func: func

        def __call__(self, *_args, **_kwargs):
            raise RuntimeError("typer is not included in this build")

    _module("typer", Typer=Typer)


def _valkey():
    # Used only when settings.yml sets valkey.url (limiter, valkey_server engine).
    class Valkey:
        @classmethod
        def from_url(cls, *_args, **_kwargs):
            raise RuntimeError("valkey is not included in this build; unset valkey.url")

    _module("valkey", Valkey=Valkey)


def _pwd():
    # Windows has no pwd module; searx/valkeydb.py imports it at module level and
    # uses it only to log the user of a valkey unix socket.
    def getpwuid(_uid):
        raise KeyError("pwd is not available on this platform")

    _module("pwd", getpwuid=getpwuid)


def install():
    for name, stub in (("pygments", _pygments), ("typer", _typer), ("valkey", _valkey), ("pwd", _pwd)):
        if _missing(name):
            stub()
