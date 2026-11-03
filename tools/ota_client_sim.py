"""Desktop OTA client simulator: mimics the Android updater against a real API.

Used to verify the whole publish pipeline (version manifest -> zip download ->
sha256 -> unzip -> bundle validation) without a phone. It is NOT the phone test;
the phone APP must still be validated separately.

Usage:
    python tools/ota_client_sim.py --api-base http://127.0.0.1:3001 --current-version 1 --work-dir .tooling/ota-sim
    python tools/ota_client_sim.py --api-base https://zzysjqr.cn/treasure --current-version 1
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def http_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "tq-ota-sim"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download(url, dest, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": "tq-ota-sim"})
    total = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            f.write(chunk)
    return total


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_extract(zip_path, target):
    base = os.path.abspath(target)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if name.startswith("/") or ".." in name.replace("\\", "/").split("/"):
                raise SystemExit("unsafe zip entry: " + name)
            dest = os.path.abspath(os.path.join(base, name))
            if not dest.startswith(base + os.sep) and dest != base:
                raise SystemExit("zip-slip entry: " + name)
        z.extractall(base)


def validate_bundle(root):
    problems = []
    for required in ("bundle.json", "index.html"):
        if not os.path.exists(os.path.join(root, required)):
            problems.append("missing " + required)
    if problems:
        return problems
    with open(os.path.join(root, "bundle.json"), "r", encoding="utf-8") as f:
        bundle = json.load(f)
    if not isinstance(bundle.get("contentVersion"), int):
        problems.append("bundle.json contentVersion invalid")
    html_path = os.path.join(root, "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    import re

    for src in re.findall(r'<script[^>]+src="([^"]+)"', html):
        if src.startswith(("http://", "https://", "//")):
            problems.append("external script: " + src)
        elif not os.path.exists(os.path.join(root, src)):
            problems.append("missing script: " + src)
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default="http://127.0.0.1:3001")
    ap.add_argument("--current-version", type=int, default=0)
    ap.add_argument("--shell", type=int, default=1)
    ap.add_argument("--work-dir", default=os.path.join(PROJECT_ROOT, ".tooling", "ota-sim"))
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    api = args.api_base.rstrip("/")
    print("API:", api)
    url = "%s/api/version?platform=android&shell=%d&content=%d&channel=test" % (api, args.shell, args.current_version)
    manifest = http_json(url)
    content = manifest.get("content")
    print("manifest:", json.dumps(manifest, ensure_ascii=False)[:600])
    if not content:
        print("NO_CONTENT_ON_SERVER")
        return 0
    if content["version"] <= args.current_version:
        print("ALREADY_UP_TO_DATE  current=%d latest=%d" % (args.current_version, content["version"]))
        return 0
    if content.get("minShellVersion", 1) > args.shell:
        print("SHELL_TOO_OLD need>=%d shell=%d" % (content["minShellVersion"], args.shell))
        return 3

    work = args.work_dir
    if not args.keep and os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)
    zip_path = os.path.join(work, "download.zip")
    zip_url = content.get("zipUrl") or (api + content["zipPath"])
    started = time.time()
    size = download(zip_url, zip_path)
    dt = time.time() - started
    print("downloaded %d bytes in %.2fs (%.1f KB/s)" % (size, dt, size / 1024 / max(dt, 0.001)))

    problems = []
    actual_sha = sha256_file(zip_path)
    if actual_sha != content["sha256"]:
        problems.append("sha256 mismatch: %s != %s" % (actual_sha, content["sha256"]))
    if content.get("size") and size != content["size"]:
        problems.append("size mismatch: %d != %d" % (size, content["size"]))
    if size > 20 * 1024 * 1024:
        problems.append("too large: %d bytes > 20MB" % size)
    if problems:
        print("OTA_FAILED:", "; ".join(problems))
        return 2

    extract_dir = os.path.join(work, "web", str(content["version"]))
    if os.path.exists(extract_dir):
        shutil.rmtree(extract_dir)
    safe_extract(zip_path, extract_dir)
    problems = validate_bundle(extract_dir)
    if problems:
        print("BUNDLE_INVALID:", "; ".join(problems))
        return 2

    state = {
        "contentVersion": content["version"],
        "activeDir": extract_dir,
        "previousContentVersion": args.current_version,
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(os.path.join(work, "ota_state.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("=" * 60)
    print("OTA_APPLIED contentVersion=%d" % content["version"])
    print("dir   :", extract_dir)
    print("notes :", content.get("notes"))
    print("state :", os.path.join(work, "ota_state.json"))
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
