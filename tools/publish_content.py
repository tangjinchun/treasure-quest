"""Publish a content package (and optionally an APK) to the server.

Uploads dist/treasure-content-<v>.zip to /data/treasure/data/updates/,
updates /data/treasure/data/versions.json atomically, then verifies the public
version manifest through https://zzysjqr.cn/treasure/api/version.

Usage:
    python tools/publish_content.py --version 1 --notes "首个版本：3 个关卡"
    python tools/publish_content.py --version 2 --notes "新增第 4 关" --apk dist/treasure-quest-0.1.0-debug.apk --apk-version-name 0.1.0
"""

import argparse
import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
REMOTE_DATA = "/data/treasure/data"
# 演示服默认值；部署到自己的服务器时设置 TQ_PUBLIC_BASE=https://<YOUR_DOMAIN>/treasure
PUBLIC_BASE = os.environ.get("TQ_PUBLIC_BASE", "https://zzysjqr.cn/treasure")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from remote import RemoteError, connect, read_remote, run, sftp_put, wait_http_ok, write_remote_atomic  # noqa: E402


def load_local_manifest(version):
    path = os.path.join(DIST_DIR, "manifest-%d.json" % version)
    if not os.path.exists(path):
        raise SystemExit("missing %s; run tools/build_web.py --version %d first" % (path, version))
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def remote_versions(client):
    path = REMOTE_DATA + "/versions.json"
    try:
        return json.loads(read_remote(client, path))
    except IOError:
        return {"channel": "test", "content": None, "apk": None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", type=int, required=True)
    ap.add_argument("--notes", default="")
    ap.add_argument("--channel", default="test")
    ap.add_argument("--apk", help="path to apk file to publish for sideload download")
    ap.add_argument("--apk-notes", default="")
    args = ap.parse_args()

    manifest = load_local_manifest(args.version)
    content = dict(manifest["content"])
    if args.notes:
        content["notes"] = args.notes
    zip_rel = manifest["local"]["zip"]
    zip_path = os.path.join(PROJECT_ROOT, zip_rel)
    zip_name = os.path.basename(zip_path)
    if not os.path.exists(zip_path):
        raise SystemExit("missing zip: " + zip_path)

    apk_meta = None
    apk_path = args.apk
    if apk_path:
        apk_path = os.path.abspath(apk_path)
        if not os.path.exists(apk_path):
            raise SystemExit("missing apk: " + apk_path)
        apk_file = os.path.basename(apk_path)
        candidates = sorted(
            os.path.join(DIST_DIR, n) for n in os.listdir(DIST_DIR)
            if n.startswith("apk-") and n.endswith(".json")
        )
        apk_meta = None
        for cand in candidates:
            with open(cand, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if os.path.basename(meta.get("file", "")) == apk_file:
                apk_meta = meta
                break
        if apk_meta is None:
            import hashlib

            h = hashlib.sha256()
            with open(apk_path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            apk_meta = {
                "file": os.path.relpath(apk_path, PROJECT_ROOT).replace(os.sep, "/"),
                "sha256": h.hexdigest(),
                "size": os.path.getsize(apk_path),
                "shellVersionCode": 1,
                "shellVersionName": "0.1.0",
            }
        apk_meta = dict(apk_meta)

    client = connect()
    print("connected to server")
    try:
        run(client, "mkdir -p %s/updates %s/apk && chown -R treasure:treasure %s 2>/dev/null || true" % (REMOTE_DATA, REMOTE_DATA, REMOTE_DATA))
        remote_zip = "%s/updates/%s" % (REMOTE_DATA, zip_name)
        sftp_put(client, zip_path, remote_zip)
        run(client, "chown treasure:treasure %s && chmod 644 %s" % (remote_zip, remote_zip))
        if apk_path:
            remote_apk = "%s/apk/%s" % (REMOTE_DATA, os.path.basename(apk_path))
            sftp_put(client, apk_path, remote_apk)
            run(client, "chown treasure:treasure %s && chmod 644 %s" % (remote_apk, remote_apk))

        versions = remote_versions(client)
        versions["channel"] = args.channel
        versions["content"] = {
            "version": content["version"],
            "minShellVersion": content.get("minShellVersion", 1),
            "notes": content.get("notes", ""),
            "publishedAt": content.get("publishedAt"),
            "file": "updates/" + zip_name,
            "sha256": content["sha256"],
            "size": content["size"],
        }
        if apk_meta is not None:
            versions["apk"] = {
                "versionCode": apk_meta.get("shellVersionCode", 1),
                "versionName": apk_meta.get("shellVersionName", "0.1.0"),
                "notes": args.apk_notes or "",
                "file": "apk/" + os.path.basename(apk_path),
                "sha256": apk_meta.get("sha256"),
                "size": apk_meta.get("size"),
            }
        payload = json.dumps(versions, ensure_ascii=False, indent=2) + "\n"
        write_remote_atomic(client, REMOTE_DATA + "/versions.json", payload, owner="treasure:treasure")

        body = wait_http_ok(PUBLIC_BASE + "/api/version", attempts=6)
        manifest_public = json.loads(body)
        got = manifest_public.get("content") or {}
        if got.get("version") != content["version"]:
            raise RemoteError("public manifest version mismatch: %s != %s" % (got.get("version"), content["version"]))
        if got.get("sha256") != content["sha256"]:
            raise RemoteError("public manifest sha256 mismatch")
        print("=" * 60)
        print("published content v%d" % content["version"])
        print("zip url :", got.get("zipUrl"))
        print("sha256  :", got.get("sha256"))
        if versions.get("apk"):
            print("apk url :", PUBLIC_BASE + "/apk/" + os.path.basename(versions["apk"]["file"]))
        print("=" * 60)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RemoteError as exc:
        print("PUBLISH FAILED:", exc, file=sys.stderr)
        sys.exit(1)
