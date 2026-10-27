"""Print the babel locale-data files SearXNG can reach from its own locale tables.

Run from source (PYTHONPATH=<searxng clone>). Every locale tag that SearXNG
knows (sxng_locales, engine traits, UI locales) is parsed the way
searx/locales.py does, its data is loaded, and the official languages of its
territory are parsed too (searx.locales.get_official_locales, weather.py).
babel.localedata.load recurses into parent locales, so the recorded set is the
closure. Output: one locale id per line (without .dat), root included.

--sxng-only: only the tags in searx/sxng_locales.py (the language/region list
of the UI and the `language` parameter), without engine traits, UI locales and
official languages per territory. Much smaller, but an engine-specific or
weather locale outside that list then falls back.
"""

import sys

import babel
import babel.languages
import babel.localedata as ld

loaded: set[str] = set()
_load = ld.load


def load(name, merge_inherited=True):
    loaded.add(name)
    return _load(name, merge_inherited)


ld.load = load

from searx import data  # noqa: E402
from searx.sxng_locales import sxng_locales  # noqa: E402

sxng_only = "--sxng-only" in sys.argv[1:]
tags: set[str] = {t[0] for t in sxng_locales}
for traits in [] if sxng_only else data.ENGINE_TRAITS.values():
    tags.update(traits.get("languages", {}).keys())
    tags.update(traits.get("regions", {}).keys())
if not sxng_only:
    tags.update(data.LOCALES["LOCALE_NAMES"].keys())
tags.discard("all")
tags.discard("auto")

territories: set[str] = set()
for tag in sorted(tags):
    for candidate in (tag, tag.split("-")[0]):
        try:
            loc = babel.Locale.parse(candidate.replace("_", "-"), sep="-")
        except (ValueError, babel.UnknownLocaleError):
            continue
        loc.get_display_name()
        loc.english_name  # noqa: B018
        if loc.territory:
            territories.add(loc.territory)

for territory in [] if sxng_only else sorted(territories):
    for lang in babel.languages.get_official_languages(territory, de_facto=True):
        try:
            babel.Locale.parse(f"{lang}_{territory}").get_display_name()
        except (ValueError, babel.UnknownLocaleError):
            pass

print(f"{len(tags)} tags, {len(territories)} territories, {len(loaded)} locale files", file=sys.stderr)
print("\n".join(sorted(loaded)))
