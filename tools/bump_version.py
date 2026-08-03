"""Bump the app version in every place it has to match.

Three files carry the release number and they MUST agree, or the phone ends up
running a mix of old and new files:

  js/app.js    APP_VERSION  - the "v30" shown on the home screen
  sw.js        CACHE        - names the offline cache; a new name evicts the old one
  index.html   ?v=30        - makes each release a new URL, so no browser cache
                              can hand back the previous release's file

Usage (from the project folder):

    python tools/bump_version.py 31

Then commit and push as usual.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def replace_once(path, pattern, new, label):
    """Apply one regex substitution and refuse to carry on if it didn't match."""
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, new, text)
    if count == 0:
        sys.exit(f"ERROR: no {label} found in {path.name} - has the file changed?")
    path.write_text(updated, encoding="utf-8")
    return count


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python tools/bump_version.py <number>   e.g. 31")

    raw = sys.argv[1].lstrip("vV")
    if not raw.isdigit():
        sys.exit(f"ERROR: '{sys.argv[1]}' is not a version number. Use e.g. 31 or v31.")
    n = int(raw)

    app = ROOT / "js" / "app.js"
    sw = ROOT / "sw.js"
    html = ROOT / "index.html"

    old = re.search(r'APP_VERSION = "v(\d+)"', app.read_text(encoding="utf-8"))
    if old and int(old.group(1)) >= n:
        sys.exit(f"ERROR: current version is v{old.group(1)}; v{n} would not be newer.")

    replace_once(app, r'APP_VERSION = "v\d+"', f'APP_VERSION = "v{n}"', "APP_VERSION")
    replace_once(sw, r'CACHE = "epa-memoriser-v\d+"', f'CACHE = "epa-memoriser-v{n}"', "CACHE name")
    stamps = replace_once(html, r"\?v=\d+", f"?v={n}", "?v= cache-busting stamp")

    print(f"Bumped to v{n}:")
    print(f"  js/app.js    APP_VERSION = v{n}")
    print(f"  sw.js        CACHE       = epa-memoriser-v{n}")
    print(f"  index.html   {stamps} asset links stamped ?v={n}")
    print()
    print("Now: git add -A && git commit && git push")
    print("(If you edited js/data.js, also run encrypt_data.py and build_audio.py first.)")


if __name__ == "__main__":
    main()
