"""Shared SSH/SFTP helpers (paramiko) for deployment and publishing.

Environment variables (required):
    TQ_SSH_HOST   server host or IP, e.g. 203.0.113.10
    TQ_SSH_USER   ssh user (default root)
"""

import os
import sys
import time

import paramiko

HOST = os.environ.get("TQ_SSH_HOST", "")
USER = os.environ.get("TQ_SSH_USER", "root")
SSH_DIR = os.path.expanduser(os.path.join("~", ".ssh"))


class RemoteError(RuntimeError):
    pass


def load_private_key():
    for name in ("id_ed25519", "id_rsa"):
        path = os.path.join(SSH_DIR, name)
        if not os.path.exists(path):
            continue
        for cls in (paramiko.Ed25519Key, paramiko.RSAKey):
            try:
                return cls.from_private_key_file(path)
            except Exception:  # noqa: BLE001
                continue
    raise RemoteError("no usable private key in ~/.ssh")


def connect(timeout=20):
    if not HOST:
        raise RemoteError("set TQ_SSH_HOST to your server IP/host (and TQ_SSH_USER if not root)")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, pkey=load_private_key(), timeout=timeout, auth_timeout=timeout)
    return client


def run(client, cmd, check=True, timeout=120, quiet=False):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if not quiet:
        if out.strip():
            print(out.rstrip())
        if err.strip():
            print("[stderr]", err.rstrip(), file=sys.stderr)
    if check and code != 0:
        raise RemoteError("remote command failed (%d): %s" % (code, cmd))
    return code, out, err


def run_stream(client, cmd, timeout=900):
    print("+ remote:", cmd, flush=True)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    channel = stdout.channel
    out = []
    while True:
        line = stdout.readline()
        if line:
            out.append(line)
            sys.stdout.write(line)
            sys.stdout.flush()
        if channel.exit_status_ready() and not line:
            break
    code = channel.recv_exit_status()
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        print("[stderr]", err.rstrip(), file=sys.stderr)
    if code != 0:
        raise RemoteError("remote stream command failed (%d): %s" % (code, cmd))
    return code, "".join(out)


def sftp_put(client, local_path, remote_path, mode=None):
    sftp = client.open_sftp()
    try:
        total = os.path.getsize(local_path)
        print("upload %s -> %s (%d bytes)" % (local_path, remote_path, total), flush=True)
        last = [0]

        def cb(done, _total):
            pct = int(done * 100 / total) if total else 100
            if pct >= last[0] + 20 or done == total:
                last[0] = pct
                print("  ... %d%%" % pct, flush=True)

        sftp.put(local_path, remote_path, callback=cb)
        if mode is not None:
            sftp.chmod(remote_path, mode)
    finally:
        sftp.close()


def read_remote(client, path):
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8")
    finally:
        sftp.close()


def write_remote_atomic(client, path, content, owner="treasure:treasure", mode="644"):
    tmp = path + ".tmp-%d" % int(time.time())
    sftp = client.open_sftp()
    try:
        with sftp.open(tmp, "w") as f:
            f.write(content.encode("utf-8"))
        sftp.chmod(tmp, int(mode, 8))
    finally:
        sftp.close()
    run(client, "mv -f %s %s" % (sh_quote(tmp), sh_quote(path)))
    if owner:
        run(client, "chown %s %s" % (owner, sh_quote(path)))


def sh_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def wait_http_ok(url, attempts=8, delay=3, timeout=10):
    """Poll a URL until 200. Uses urllib first, then falls back to curl.exe.

    The Windows TLS stack occasionally fails with UNEXPECTED_EOF on this network;
    curl is more reliable, so both are attempted on every round.
    """
    import subprocess
    import urllib.request

    last = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tq-deploy-check"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
                if resp.status == 200:
                    print("HTTP OK:", url, body[:200])
                    return body
        except Exception as exc:  # noqa: BLE001
            last = exc
        try:
            r = subprocess.run(
                ["curl.exe", "-s", "-m", str(timeout), "-w", "\n%{http_code}", url],
                capture_output=True,
                text=True,
                timeout=timeout + 5,
            )
            body, _, code = r.stdout.rpartition("\n")
            if r.returncode == 0 and code.strip() == "200":
                print("HTTP OK (curl):", url, body[:200])
                return body
            last = "curl exit=%s code=%s" % (r.returncode, code.strip())
        except Exception as exc:  # noqa: BLE001
            last = exc
        print("  http check %d/%d failed: %s" % (attempt, attempts, last), flush=True)
        time.sleep(delay)
    raise RemoteError("http check failed: %s (%s)" % (url, last))

