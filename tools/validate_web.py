"""Static validation for the H5 game bundle (no browser needed).

Checks:
  - required files exist
  - web/version.json is valid
  - index.html references the 10 scripts in the contract order and files exist
  - every JS file passes `node --check`
  - no external http(s) resources referenced (offline / OTA constraint)
  - total size budget

Usage:
    python tools/validate_web.py
"""

import json
import os
import re
import subprocess
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(PROJECT_ROOT, "web")

EXPECTED_SCRIPTS = [
    "js/core/util.js",
    "js/core/audio.js",
    "js/core/input.js",
    "js/core/graphics.js",
    "js/core/level_data.js",
    "js/core/game.js",
    "js/shell/save.js",
    "js/shell/net.js",
    "js/shell/ui.js",
    "js/shell/boot.js",
]

REQUIRED_FILES = ["index.html", "version.json"] + EXPECTED_SCRIPTS


def main():
    problems = []
    for rel in REQUIRED_FILES:
        if not os.path.exists(os.path.join(WEB_DIR, rel)):
            problems.append("missing file: web/" + rel)
    if problems:
        for p in problems:
            print("PROBLEM:", p)
        return 1

    # version.json
    try:
        with open(os.path.join(WEB_DIR, "version.json"), "r", encoding="utf-8") as f:
            vj = json.load(f)
        if not isinstance(vj.get("contentVersion"), int) or vj["contentVersion"] < 1:
            problems.append("web/version.json contentVersion must be a positive int")
    except Exception as exc:  # noqa: BLE001
        problems.append("web/version.json invalid: %s" % exc)

    # index.html
    index_path = os.path.join(WEB_DIR, "index.html")
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()
    found = re.findall(r'<script[^>]+src="([^"]+)"', html)
    found = [s.split("?")[0] for s in found]
    missing = [s for s in EXPECTED_SCRIPTS if s not in found]
    if missing:
        problems.append("index.html missing scripts: " + ", ".join(missing))
    order = [s for s in found if s in EXPECTED_SCRIPTS]
    if order != [s for s in EXPECTED_SCRIPTS if s in found]:
        problems.append("index.html script order differs from contract: " + ", ".join(order))
    for src in found:
        if src.startswith(("http://", "https://", "//")):
            problems.append("external script reference not allowed: " + src)
        elif not os.path.exists(os.path.join(WEB_DIR, src)):
            problems.append("script file missing on disk: " + src)
    for attr in re.findall(r'(?:src|href)="([^"]+)"', html):
        if attr.startswith(("http://", "https://", "//")):
            problems.append("external resource not allowed: " + attr)

    # css external url()
    for root, _dirs, files in os.walk(WEB_DIR):
        for name in files:
            if not name.endswith(".css"):
                continue
            path = os.path.join(root, name)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                css = f.read()
            for url in re.findall(r"url\(\s*['\"]?(https?://[^)'\"]+)", css):
                problems.append("external css resource not allowed: %s (%s)" % (url, name))

    # js syntax check
    js_files = []
    for root, _dirs, files in os.walk(WEB_DIR):
        for name in sorted(files):
            if name.endswith(".js"):
                js_files.append(os.path.join(root, name))
    for path in js_files:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if r.returncode != 0:
            problems.append("JS syntax error in %s:\n%s" % (os.path.relpath(path, PROJECT_ROOT), r.stderr.strip()))

    # size budget
    total = 0
    for root, _dirs, files in os.walk(WEB_DIR):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    if total > 400 * 1024:
        problems.append("web bundle too large: %.1f KB > 400 KB" % (total / 1024))

    print("web files: %d JS, %.1f KB total" % (len(js_files), total / 1024))
    if problems:
        print("=" * 60)
        for p in problems:
            print("PROBLEM:", p)
        return 1
    print("VALIDATE_WEB_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
