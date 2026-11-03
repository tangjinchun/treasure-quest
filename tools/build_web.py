"""Build the H5 content package for OTA (zip + sha256 + manifest).

Usage:
    python tools/build_web.py --version 2 --notes "新增第 4 关..."
    python tools/build_web.py            # uses web/version.json contentVersion

Outputs (in dist/):
    treasure-content-<version>.zip
    treasure-content-<version>.sha256
    manifest-<version>.json     # server versions.json content entry + local metadata
Also rewrites web/version.json (contentVersion / builtAt / notes).
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(PROJECT_ROOT, "web")
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
VERSION_FILE = os.path.join(WEB_DIR, "version.json")
TZ = timezone(timedelta(hours=8))

REQUIRED = [
    "index.html",
    "version.json",
    "js/core/util.js",
    "js/core/level_data.js",
    "js/core/game.js",
    "js/shell/boot.js",
    "js/shell/ui.js",
]


def now_iso():
    return datetime.now(TZ).replace(microsecond=0).isoformat()


def load_version():
    if os.path.exists(VERSION_FILE):
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"contentVersion": 0}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", type=int, help="content version (int, strictly increasing)")
    ap.add_argument("--notes", default="", help="release notes shown in the in-app update dialog")
    ap.add_argument("--min-shell", type=int, default=1, help="minimum shell versionCode")
    ap.add_argument("--skip-check", action="store_true", help="do not fail if files are missing")
    args = ap.parse_args()

    current = load_version()
    version = args.version if args.version is not None else int(current.get("contentVersion", 0))
    if version <= 0:
        print("ERROR: content version must be >= 1", file=sys.stderr)
        return 2

    missing = [p for p in REQUIRED if not os.path.exists(os.path.join(WEB_DIR, p))]
    if missing and not args.skip_check:
        print("ERROR: web is incomplete, missing: " + ", ".join(missing), file=sys.stderr)
        return 2
    if missing:
        print("WARN: missing files (continuing): " + ", ".join(missing))

    built_at = now_iso()
    version_payload = {
        "contentVersion": version,
        "minShellVersion": args.min_shell,
        "builtAt": built_at,
        "notes": args.notes,
    }
    with open(VERSION_FILE, "w", encoding="utf-8") as f:
        json.dump(version_payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    os.makedirs(DIST_DIR, exist_ok=True)
    staging = tempfile.mkdtemp(prefix="tq-content-")
    try:
        # copy web tree (excluding dev leftovers)
        for root, dirs, files in os.walk(WEB_DIR):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
            for name in files:
                if name.endswith((".pyc", ".bak")):
                    continue
                src = os.path.join(root, name)
                rel = os.path.relpath(src, WEB_DIR)
                dst = os.path.join(staging, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
        # bundle.json at zip root
        bundle = {
            "contentVersion": version,
            "minShellVersion": args.min_shell,
            "builtAt": built_at,
            "notes": args.notes,
        }
        with open(os.path.join(staging, "bundle.json"), "w", encoding="utf-8") as f:
            json.dump(bundle, f, ensure_ascii=False, indent=2)
            f.write("\n")

        zip_name = "treasure-content-%d.zip" % version
        zip_path = os.path.join(DIST_DIR, zip_name)
        if os.path.exists(zip_path):
            os.remove(zip_path)
        entries = []
        for root, dirs, files in os.walk(staging):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, staging).replace(os.sep, "/")
                entries.append((rel, full))
        entries.sort()
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for rel, full in entries:
                info = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as f:
                    z.writestr(info, f.read())
        digest = sha256_file(zip_path)
        size = os.path.getsize(zip_path)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    manifest = {
        "content": {
            "version": version,
            "minShellVersion": args.min_shell,
            "notes": args.notes,
            "publishedAt": built_at,
            "file": "updates/" + zip_name,
            "sha256": digest,
            "size": size,
        },
        "local": {
            "zip": os.path.relpath(zip_path, PROJECT_ROOT),
            "sha256": digest,
            "size": size,
            "builtAt": built_at,
            "entries": len(entries),
        },
    }
    manifest_path = os.path.join(DIST_DIR, "manifest-%d.json" % version)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with open(os.path.join(DIST_DIR, "treasure-content-%d.sha256" % version), "w", encoding="utf-8") as f:
        f.write(digest + "  " + zip_name + "\n")

    print("=" * 60)
    print("content version :", version)
    print("notes           :", args.notes)
    print("zip             :", os.path.relpath(zip_path, PROJECT_ROOT), "(%d bytes, %d files)" % (size, len(entries)))
    print("sha256          :", digest)
    print("manifest        :", os.path.relpath(manifest_path, PROJECT_ROOT))
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
