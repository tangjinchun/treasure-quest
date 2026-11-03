"""Check the deployed Treasure Quest backend: health, version manifest, stats.

Usage:
    # basic (health + public version manifest)
    python tools/server_status.py --base https://YOUR_DOMAIN/treasure

    # with admin stats (token from /data/treasure/treasure.env TREASURE_ADMIN_TOKEN)
    python tools/server_status.py --base https://YOUR_DOMAIN/treasure --admin-token <token>

Environment:
    TQ_PUBLIC_BASE   default https://zzysjqr.cn/treasure
    TQ_ADMIN_TOKEN   used when --admin-token is omitted
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = os.environ.get("TQ_PUBLIC_BASE", "https://zzysjqr.cn/treasure")


def get(url, token=None, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "tq-status"})
    if token:
        req.add_header("X-Admin-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, {"raw": body}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="API base, e.g. https://domain/treasure")
    ap.add_argument("--admin-token", default=os.environ.get("TQ_ADMIN_TOKEN", ""))
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print("=" * 64)
    print("base:", base)

    code, health = get(base + "/api/health")
    print("\n[health]", code, json.dumps(health, ensure_ascii=False))
    if code != 200:
        print("\nhealth check failed; verify nginx/systemd/network", file=sys.stderr)
        return 1

    code, ver = get(base + "/api/version?platform=android&shell=1&content=0&channel=test")
    print("\n[version]", code)
    content = (ver or {}).get("content") or {}
    apk = (ver or {}).get("apk") or {}
    print("  content:", content.get("version"), "size=", content.get("size"), "sha256=", (content.get("sha256") or "")[:16], "...")
    print("  notes  :", content.get("notes"))
    print("  zipUrl :", content.get("zipUrl"))
    print("  apk    :", apk.get("versionName"), apk.get("apkUrl"))
    print("  updateAvailable:", (ver or {}).get("updateAvailable"))

    if args.admin_token:
        code, stats = get(base + "/api/stats", token=args.admin_token)
        print("\n[stats]", code)
        if code == 200:
            print("  downloads:", json.dumps(stats.get("downloads"), ensure_ascii=False))
            print("  logins   :", json.dumps(stats.get("logins"), ensure_ascii=False))
            print("  recent   :")
            for row in (stats.get("recent") or [])[:10]:
                print("   ", row.get("ts"), row.get("event"), row.get("file") or row.get("username") or "", row.get("ip", ""))
        else:
            print("  stats unavailable (check admin token)")
    else:
        print("\n[stats] skipped (no admin token; set --admin-token or TQ_ADMIN_TOKEN)")

    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
