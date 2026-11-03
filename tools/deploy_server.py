"""Deploy the Treasure Quest backend to the Tencent server (idempotent).

What it does:
  1. packages server/*.py + server/deploy/* into a tarball
  2. uploads it to /data/treasure/_deploy
  3. runs server/deploy/install.sh on the server (creates user, systemd unit,
     nginx include, starts service)
  4. verifies http://172.17.0.1:3001/api/health on the server and
     https://zzysjqr.cn/treasure/api/health from the public internet

Usage:
    python tools/deploy_server.py            # full deploy
    python tools/deploy_server.py --dry-run  # only check inputs / ssh
"""

import argparse
import io
import os
import sys
import tarfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(PROJECT_ROOT, "server")
DEPLOY_FILES = [
    "server.py",
    "add_user.py",
    "README.md",
    "deploy/install.sh",
    "deploy/treasure-server.service",
    "deploy/treasure-nginx-locations.inc",
]
REMOTE_TMP = "/tmp/tq-server-deploy.tar.gz"
REMOTE_DIR = "/data/treasure/_deploy"
PUBLIC_BASE = os.environ.get("TQ_PUBLIC_BASE", "https://zzysjqr.cn/treasure")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from remote import RemoteError, connect, run, run_stream, sftp_put, wait_http_ok  # noqa: E402


def build_tarball():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in DEPLOY_FILES:
            path = os.path.join(SERVER_DIR, rel)
            if not os.path.exists(path):
                raise SystemExit("missing server file: " + os.path.relpath(path, PROJECT_ROOT))
            tar.add(path, arcname=rel)
    data = buf.getvalue()
    out = os.path.join(PROJECT_ROOT, "dist", "tq-server-deploy.tar.gz")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(data)
    print("packaged %d bytes -> %s" % (len(data), os.path.relpath(out, PROJECT_ROOT)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-install", action="store_true", help="upload only, do not run install.sh")
    args = ap.parse_args()

    tarball = build_tarball()
    client = connect()
    print("connected to server")
    try:
        run(client, "mkdir -p %s" % REMOTE_DIR)
        sftp_put(client, tarball, REMOTE_TMP)
        run(client, "tar xzf %s -C %s && ls -la %s" % (REMOTE_TMP, REMOTE_DIR, REMOTE_DIR))
        if args.dry_run:
            print("dry-run: upload ok, skipping install.sh")
            return 0
        if not args.skip_install:
            run_stream(client, "bash %s/deploy/install.sh" % REMOTE_DIR)
        # verification
        run(client, "systemctl is-active treasure-server || true")
        run(client, "curl -s -m 10 http://172.17.0.1:3001/api/health || true")
        run(client, "curl -s -m 10 -o /dev/null -w 'nginx-internal=%{http_code}\\n' http://172.17.0.1:3001/api/version || true")
        run(client, "docker exec nginx nginx -t 2>&1 | tail -2")
        wait_http_ok(PUBLIC_BASE.rstrip("/") + "/api/health", attempts=6)
        print("=" * 60)
        print("backend deployed:", PUBLIC_BASE.rstrip("/") + "/api/health")
        print("next: python tools/publish_content.py --version 1 --notes \"首个版本\"")
        print("=" * 60)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RemoteError as exc:
        print("DEPLOY FAILED:", exc, file=sys.stderr)
        sys.exit(1)
