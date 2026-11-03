"""Download and install the minimal Android SDK needed to build the APK.

This is a Windows-oriented helper for environments where ``sdkmanager``
downloads are flaky: it fetches packages directly from Google's official
repository with retries / resume and verifies the archive sizes.

SDK location priority:

1. ``--sdk-dir`` command line option
2. ``ANDROID_SDK_ROOT`` or ``ANDROID_HOME`` environment variable
3. ``%LOCALAPPDATA%\\Android\\Sdk`` (Windows default)

Tip: to keep the SDK off the system drive, point it somewhere else::

    python tools\\install_android_sdk.py --sdk-dir D:\\SDK
    set ANDROID_HOME=D:\\SDK && python tools\\install_android_sdk.py

Installs: platform-tools, platforms;android-35, build-tools;35.0.0
"""

import argparse
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

REPO_URL = "https://dl.google.com/android/repository/repository2-1.xml"
BASE_URL = "https://dl.google.com/android/repository/"

PACKAGES = [
    # package path, destination relative to SDK, marker file
    ("platform-tools", "platform-tools", "adb.exe"),
    ("platforms;android-35", os.path.join("platforms", "android-35"), "android.jar"),
    ("build-tools;35.0.0", os.path.join("build-tools", "35.0.0"), "aapt2.exe"),
]

ATTEMPTS = 8


def default_sdk_root():
    """Return the default SDK root (env override -> Windows LOCALAPPDATA)."""
    for name in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        value = os.environ.get(name)
        if value:
            return value
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return os.path.join(local, "Android", "Sdk")
    return os.path.join(os.path.expanduser("~"), "Android", "Sdk")


SDK = default_sdk_root()
CACHE = os.path.join(tempfile.gettempdir(), "android-sdk-zips")


def http_get(url, timeout=180):
    last = None
    for attempt in range(1, 6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dsh-android-sdk-setup"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            print("repo xml fetch failed (attempt %d): %s" % (attempt, exc), flush=True)
            time.sleep(attempt * 2)
    raise SystemExit("cannot fetch repo xml: %s" % last)


def find_package_url(raw, pkg):
    i = raw.find('path="%s"' % pkg)
    if i < 0:
        raise SystemExit("package not found in repo xml: " + pkg)
    j = raw.find("</remotePackage>", i)
    chunk = raw[i:j]
    archs = re.findall(r"<archive>(.*?)</archive>", chunk, re.S)
    picks = []
    for a in archs:
        host = re.search(r"<host-os>(.*?)</host-os>", a, re.S)
        url = re.search(r"<url>(.*?)</url>", a, re.S)
        size = re.search(r"<size>(\d+)</size>", a, re.S)
        if url:
            picks.append((host.group(1) if host else "", url.group(1), int(size.group(1)) if size else 0))
    if not picks:
        raise SystemExit("no archive url for " + pkg)
    for host, url, size in picks:
        if host in ("windows", ""):
            return url, size
    return picks[0][1], picks[0][2]


def download(url, dest, expected_size):
    if not url.startswith("http"):
        url = BASE_URL + url
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        if expected_size == 0 or os.path.getsize(dest) == expected_size:
            print("cached:", dest, flush=True)
            return
        print("cached size mismatch, re-downloading:", dest, flush=True)
        os.remove(dest)
    for attempt in range(1, ATTEMPTS + 1):
        print("downloading (attempt %d/%d): %s" % (attempt, ATTEMPTS, url), flush=True)
        r = subprocess.run(
            [
                "curl.exe", "-L", "-C", "-", "--connect-timeout", "25", "--max-time", "900",
                "-o", dest, url,
            ],
            capture_output=True,
            text=True,
        )
        if os.path.exists(dest) and (expected_size == 0 or os.path.getsize(dest) == expected_size):
            print("downloaded:", dest, os.path.getsize(dest), flush=True)
            return
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        print("  attempt failed (exit %s, have %s bytes): %s" % (r.returncode, have, (r.stderr or "").strip()[-300:]), flush=True)
        time.sleep(min(3 * attempt, 15))
    raise SystemExit("download failed after retries: " + url)


def install(zip_path, dest_rel, marker):
    tmp = tempfile.mkdtemp(prefix="sdk-extract-")
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
        marker_path = None
        for root, _dirs, files in os.walk(tmp):
            if marker in files:
                marker_path = os.path.join(root, marker)
                break
        if not marker_path:
            raise SystemExit("marker %s not found in %s" % (marker, zip_path))
        top = os.path.dirname(marker_path)
        while os.path.dirname(top) != tmp:
            top = os.path.dirname(top)
        dest = os.path.join(SDK, dest_rel)
        if os.path.exists(dest):
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(top, dest)
        print("installed:", dest_rel, flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify():
    print("=== verification ===", flush=True)
    checks = [
        ("adb", os.path.join(SDK, "platform-tools", "adb.exe"), ["version"]),
        ("aapt2", os.path.join(SDK, "build-tools", "35.0.0", "aapt2.exe"), ["version"]),
        ("zipalign", os.path.join(SDK, "build-tools", "35.0.0", "zipalign.exe"), []),
        ("apksigner", os.path.join(SDK, "build-tools", "35.0.0", "apksigner.bat"), ["--version"]),
    ]
    for name, exe, args in checks:
        if os.path.exists(exe):
            try:
                r = subprocess.run([exe] + args, capture_output=True, text=True, timeout=120)
                line = (r.stdout or r.stderr).strip().splitlines()[:1]
                print(name, "OK", line, flush=True)
            except Exception as exc:  # noqa: BLE001
                print(name, "ERR", exc, flush=True)
        else:
            print(name, "MISSING", exe, flush=True)
    jar = os.path.join(SDK, "platforms", "android-35", "android.jar")
    print("android.jar", "OK" if os.path.exists(jar) else "MISSING", jar, flush=True)


def main(argv=None):
    global SDK
    parser = argparse.ArgumentParser(description="Download and install minimal Android SDK components.")
    parser.add_argument(
        "--sdk-dir",
        help="SDK root directory (default: ANDROID_SDK_ROOT / ANDROID_HOME, "
        "else LOCALAPPDATA\\Android\\Sdk). Use e.g. D:\\SDK to keep it off the system drive.",
    )
    args = parser.parse_args(argv)
    if args.sdk_dir:
        SDK = os.path.abspath(args.sdk_dir)

    os.makedirs(SDK, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    print("SDK root:", SDK, flush=True)
    raw = http_get(REPO_URL).decode("utf-8", errors="replace")
    print("repo xml bytes:", len(raw), flush=True)
    for pkg, dest_rel, marker in PACKAGES:
        dest = os.path.join(SDK, dest_rel)
        if os.path.exists(os.path.join(dest, marker)):
            print("already installed, skip:", dest_rel, flush=True)
            continue
        url, size = find_package_url(raw, pkg)
        fn = os.path.join(CACHE, url.rsplit("/", 1)[-1])
        download(url, fn, size)
        install(fn, dest_rel, marker)
    verify()


if __name__ == "__main__":
    main()
