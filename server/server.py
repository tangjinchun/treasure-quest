#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""《寻宝奇兵》后端服务（Python 3.11 标准库，无第三方依赖）。

严格实现 docs/API.md（v1 契约）：
    GET  /api/health                  健康检查
    GET  /api/version                 内容/APK 版本清单（versions.json 每次请求热读取）
    POST /api/login                   登录，返回 HMAC-SHA256 token（30 天）
    GET  /api/me                      token 换用户信息
    GET  /api/stats                   管理员统计（X-Admin-Token）
    GET/HEAD /updates/<file>.zip      内容包静态下载
    GET/HEAD /apk/<file>.apk          APK 静态下载

环境变量（见 docs/API.md 末尾「部署与环境变量」）：
    TREASURE_BIND          监听地址，默认 127.0.0.1
    TREASURE_PORT          监听端口，默认 3001
    TREASURE_DATA_DIR      数据目录，默认本文件同级 ./data
    TREASURE_PUBLIC_BASE   公网基地址，默认 https://zzysjqr.cn/treasure
    TREASURE_CHANNEL       默认渠道名，默认 test
    TREASURE_SECRET        token 签名密钥（生产必须显式设置，64 hex）
    TREASURE_ADMIN_TOKEN   /api/stats 管理员 token（生产必须显式设置，32 hex）

本地运行：
    python server/server.py            # http://127.0.0.1:3001
    python server/add_user.py admin 123456 --display-name 测试玩家 --role admin
"""

import base64
import binascii
import email.utils
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import signal
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

SERVER_SERVICE = "treasure-server"
SERVER_VERSION = "1.0"

TOKEN_TTL_SECONDS = 30 * 24 * 3600          # 30 天
LOGIN_RATE_LIMIT = 10                        # 10 次
LOGIN_RATE_WINDOW_SECONDS = 60               # / 分钟 / IP

MAX_BODY_BYTES = 64 * 1024                   # 登录请求体上限
STATIC_CHUNK_SIZE = 64 * 1024                # 静态文件分块发送
STATS_RECENT_LIMIT = 20                      # /api/stats 返回的最近事件条数
USERNAME_MAX_LEN = 64
PASSWORD_MAX_LEN = 256

CORS_HEADERS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
    ("Access-Control-Max-Age", "86400"),
)

# 允许的静态文件名：仅 ASCII 安全字符，防路径穿越/隐藏文件
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")

_STATS_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# 通用工具：时间 / base64 / 密码 / token
# ---------------------------------------------------------------------------


def now_iso():
    """当前时间，ISO 8601 带本地时区，如 2026-11-03T14:00:00+08:00。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def epoch_to_iso(epoch):
    """unix 秒 -> ISO 8601 带时区。"""
    return datetime.fromtimestamp(int(epoch)).astimezone().isoformat(timespec="seconds")


def b64url_encode(raw):
    """bytes -> base64url（无 = 填充）。"""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    """base64url（可无填充）-> bytes；非法输入抛 ValueError。"""
    if not isinstance(text, str):
        raise ValueError("not a string")
    padded = text + "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except (binascii.Error, UnicodeEncodeError) as exc:
        raise ValueError("invalid base64url") from exc


def new_salt():
    """随机盐（32 hex 字符）。"""
    return secrets.token_hex(16)


def password_sha256(salt, password):
    """sha256(salt + password) 的 hex —— 与 docs/API.md 的 users.json 约定一致。"""
    return hashlib.sha256((str(salt) + str(password)).encode("utf-8")).hexdigest()


def verify_password(record, password):
    """校验 users.json 中一条账号记录的密码。"""
    if not isinstance(record, dict):
        return False
    salt = record.get("salt")
    digest = record.get("passwordSha256")
    if not isinstance(salt, str) or not isinstance(digest, str) or not digest:
        return False
    try:
        candidate = password_sha256(salt, password)
    except (UnicodeEncodeError, ValueError):
        return False
    return hmac.compare_digest(candidate, digest.lower())


class TokenError(Exception):
    """token 校验失败；code 即 API.md 错误码：invalid_token / token_expired。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def make_token(username, secret, ttl=TOKEN_TTL_SECONDS):
    """生成 token：base64url(payload).base64url(hmac)，返回 (token, exp_unix)。

    payload = {"u": username, "exp": unix 秒}（紧凑 JSON）。
    签名对象 = payload 的 base64url 字符串（ASCII 字节），密钥 = TREASURE_SECRET。
    """
    exp = int(time.time()) + int(ttl)
    payload = {"u": username, "exp": exp}
    payload_b64 = b64url_encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    signature = hmac.new(
        str(secret).encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).digest()
    return payload_b64 + "." + b64url_encode(signature), exp


def verify_token(token, secret):
    """校验 token，成功返回 {"username": ..., "exp": ...}，失败抛 TokenError。"""
    if not isinstance(token, str) or token.count(".") != 1:
        raise TokenError("invalid_token")
    payload_b64, sig_b64 = token.split(".", 1)
    if not payload_b64 or not sig_b64:
        raise TokenError("invalid_token")
    try:
        expected = hmac.new(
            str(secret).encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        provided = b64url_decode(sig_b64)
    except (UnicodeEncodeError, ValueError):
        raise TokenError("invalid_token")
    if not hmac.compare_digest(expected, provided):
        raise TokenError("invalid_token")
    try:
        payload = json.loads(b64url_decode(payload_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise TokenError("invalid_token")
    if not isinstance(payload, dict):
        raise TokenError("invalid_token")
    username = payload.get("u")
    exp = payload.get("exp")
    if not isinstance(username, str) or not username or username != username.strip():
        raise TokenError("invalid_token")
    if isinstance(exp, bool) or not isinstance(exp, int):
        raise TokenError("invalid_token")
    if exp <= int(time.time()):
        raise TokenError("token_expired")
    return {"username": username, "exp": exp}


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def _default_data_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def _env(env, name, default=""):
    value = env.get(name)
    if value is None:
        return default
    value = str(value).strip()
    return value if value else default


@dataclass
class Config:
    """服务运行配置（本地可用默认值直接跑）。"""

    bind: str = "127.0.0.1"
    port: int = 3001
    data_dir: str = field(default_factory=_default_data_dir)
    public_base: str = "https://zzysjqr.cn/treasure"
    channel: str = "test"
    secret: str = ""
    admin_token: str = ""

    def public_url(self, path):
        """zipPath/apkPath -> 公网 URL。"""
        if not path:
            return None
        return self.public_base.rstrip("/") + path

    @classmethod
    def from_env(cls, env=None):
        """从环境变量构造配置（缺省时用本地开发默认值）。"""
        env = os.environ if env is None else env
        cfg = cls()
        cfg.bind = _env(env, "TREASURE_BIND", cfg.bind)
        cfg.data_dir = os.path.abspath(_env(env, "TREASURE_DATA_DIR", cfg.data_dir))
        cfg.public_base = _env(env, "TREASURE_PUBLIC_BASE", cfg.public_base)
        cfg.channel = _env(env, "TREASURE_CHANNEL", cfg.channel)
        cfg.secret = _env(env, "TREASURE_SECRET", "")
        cfg.admin_token = _env(env, "TREASURE_ADMIN_TOKEN", "")
        raw_port = _env(env, "TREASURE_PORT", "")
        if raw_port:
            try:
                cfg.port = int(raw_port)
            except ValueError:
                logging.warning("TREASURE_PORT 不是整数（%r），使用默认 3001", raw_port)
        return cfg


# ---------------------------------------------------------------------------
# 数据文件：users.json / versions.json / stats.jsonl
# ---------------------------------------------------------------------------


def load_users(data_dir):
    """读取 users.json -> {username: record}；文件缺失/损坏时返回空 dict。"""
    path = os.path.join(data_dir, "users.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        logging.warning("users.json 不存在：%s（登录将全部失败）", path)
        return {}
    except (OSError, ValueError) as exc:
        logging.warning("users.json 读取失败：%s", exc)
        return {}
    users = {}
    raw_users = data.get("users") if isinstance(data, dict) else None
    if isinstance(raw_users, list):
        for item in raw_users:
            if isinstance(item, dict) and isinstance(item.get("username"), str):
                users[item["username"]] = item
    return users


def _as_int(value, default=None):
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _normalise_rel(file_rel, subdir):
    """把 versions.json 里的 file 字段规范化为相对 data_dir 的安全路径。

    支持 "updates/x.zip"、"/updates/x.zip"、"x.zip"；拒绝 .. / 反斜杠 / 空段。
    返回 None 表示不可用（宁可不给下载地址，也不给可穿越的路径）。
    """
    if not isinstance(file_rel, str):
        return None
    rel = file_rel.strip().replace("\\", "/").lstrip("/")
    if not rel:
        return None
    segments = rel.split("/")
    if any(seg in ("", ".", "..") for seg in segments):
        logging.warning("versions.json file 字段非法（拒绝 .. 路径段）：%r", file_rel)
        return None
    if len(segments) == 1:
        segments = [subdir] + segments
    return "/".join(segments)


def _file_size(data_dir, rel):
    """相对路径文件真实大小（用于 versions.json 没写 size 的兜底）；失败返回 None。"""
    try:
        root = os.path.realpath(data_dir)
        target = os.path.realpath(os.path.join(root, rel))
        if target != root and not target.startswith(root + os.sep):
            return None
        return os.path.getsize(target)
    except (OSError, ValueError):
        return None


def read_versions(data_dir):
    """每次请求都重新读取 versions.json（发布后热生效）。"""
    path = os.path.join(data_dir, "versions.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        logging.warning("versions.json 读取失败（按无内容包处理）：%s", exc)
        return {}
    return data if isinstance(data, dict) else {}


def append_stats(data_dir, event):
    """追加一条事件到 data/stats.jsonl；失败只告警，不影响接口。"""
    path = os.path.join(data_dir, "stats.jsonl")
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    try:
        os.makedirs(data_dir, exist_ok=True)
        with _STATS_LOCK:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
    except OSError as exc:
        logging.warning("写入 stats.jsonl 失败：%s", exc)


def read_stats_events(data_dir):
    """读取 stats.jsonl 全部事件（跳过损坏行）。"""
    path = os.path.join(data_dir, "stats.jsonl")
    events = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if isinstance(item, dict):
                    events.append(item)
    except FileNotFoundError:
        return []
    except OSError as exc:
        logging.warning("读取 stats.jsonl 失败：%s", exc)
        return []
    return events


def build_stats_payload(data_dir, recent_limit=STATS_RECENT_LIMIT):
    """聚合 stats.jsonl -> /api/stats 的 downloads / logins / recent。"""
    events = read_stats_events(data_dir)
    downloads = {}
    logins_total = 0
    login_users = set()
    for event in events:
        kind = event.get("event")
        if kind == "download":
            filename = event.get("file")
            if not isinstance(filename, str) or not filename:
                continue
            item = downloads.get(filename)
            if item is None:
                downloads[filename] = {
                    "file": filename,
                    "count": 1,
                    "lastAt": event.get("ts"),
                }
            else:
                item["count"] += 1
                item["lastAt"] = event.get("ts")
        elif kind == "login" and event.get("ok") is True:
            logins_total += 1
            username = event.get("username")
            if isinstance(username, str) and username:
                login_users.add(username)
    recent = list(reversed(events[-recent_limit:])) if recent_limit else []
    return {
        "downloads": list(downloads.values()),
        "logins": {"total": logins_total, "uniqueUsers": len(login_users)},
        "recent": recent,
    }


# ---------------------------------------------------------------------------
# /api/version 响应构造
# ---------------------------------------------------------------------------


def build_version_payload(config, query, data_dir=None):
    """按 API.md 组装 /api/version 响应；versions.json 每次请求热读取。"""
    data_dir = data_dir or config.data_dir
    raw = read_versions(data_dir)

    requested_channel = ""
    for value in query.get("channel", []):
        if value:
            requested_channel = value
            break
    channel = requested_channel or raw.get("channel") or config.channel

    content = None
    raw_content = raw.get("content")
    if isinstance(raw_content, dict):
        version = _as_int(raw_content.get("version"))
        if version is None:
            logging.warning("versions.json content.version 非法，按无内容包处理")
        else:
            rel = _normalise_rel(raw_content.get("file"), "updates")
            if rel is None and not raw_content.get("file"):
                rel = "updates/treasure-content-%d.zip" % version
            size = _as_int(raw_content.get("size"))
            if size is None and rel:
                size = _file_size(data_dir, rel)
            zip_path = "/" + rel if rel else None
            content = {
                "version": version,
                "minShellVersion": _as_int(raw_content.get("minShellVersion"), 1),
                "notes": raw_content.get("notes") or "",
                "publishedAt": raw_content.get("publishedAt"),
                "size": size,
                "sha256": raw_content.get("sha256"),
                "zipPath": zip_path,
                "zipUrl": config.public_url(zip_path),
            }

    apk = None
    raw_apk = raw.get("apk")
    if isinstance(raw_apk, dict):
        rel = _normalise_rel(raw_apk.get("file"), "apk")
        size = _as_int(raw_apk.get("size"))
        if size is None and rel:
            size = _file_size(data_dir, rel)
        apk_path = "/" + rel if rel else None
        apk = {
            "versionCode": _as_int(raw_apk.get("versionCode")),
            "versionName": raw_apk.get("versionName"),
            "notes": raw_apk.get("notes") or "",
            "size": size,
            "apkPath": apk_path,
            "apkUrl": config.public_url(apk_path),
        }

    requested_content = 0
    for value in query.get("content", []):
        try:
            requested_content = int(value)
        except (TypeError, ValueError):
            requested_content = 0
        break

    update_available = bool(content is not None and content["version"] > requested_content)
    return {
        "ok": True,
        "serverTime": now_iso(),
        "channel": channel,
        "content": content,
        "apk": apk,
        "updateAvailable": update_available,
    }


# ---------------------------------------------------------------------------
# 登录限流（进程内，10 次/分钟/IP）
# ---------------------------------------------------------------------------


class LoginRateLimiter:
    """登录限流：滑动窗口，内存实现（重启重置）。"""

    def __init__(self, limit=LOGIN_RATE_LIMIT, window_seconds=LOGIN_RATE_WINDOW_SECONDS):
        self.limit = int(limit)
        self.window = float(window_seconds)
        self._lock = threading.Lock()
        self._hits = {}

    def check(self, ip):
        """返回 (allowed, retry_after_seconds)。"""
        now = time.monotonic()
        with self._lock:
            hits = self._hits.get(ip)
            if hits is None:
                hits = deque()
                self._hits[ip] = hits
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                retry_after = int(self.window - (now - hits[0])) + 1
                return False, max(retry_after, 1)
            hits.append(now)
            if len(self._hits) > 4096:
                self._prune(now)
            return True, 0

    def _prune(self, now):
        stale = [ip for ip, hits in self._hits.items() if not hits or now - hits[-1] > self.window]
        for ip in stale:
            self._hits.pop(ip, None)


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


def _error_payload(code, message):
    return {"ok": False, "error": code, "message": message}


def ensure_data_dirs(data_dir):
    """确保 data/、data/updates/、data/apk/ 存在。"""
    for sub in ("", "updates", "apk"):
        try:
            os.makedirs(os.path.join(data_dir, sub) if sub else data_dir, exist_ok=True)
        except OSError as exc:
            logging.warning("创建目录失败（%s）：%s", sub or data_dir, exc)


class TreasureHandler(BaseHTTPRequestHandler):
    """所有路由的入口；每个请求独立 try/except，异常只回 500 不泄露堆栈。"""

    protocol_version = "HTTP/1.1"
    server_version = SERVER_SERVICE + "/" + SERVER_VERSION
    sys_version = ""

    # -- 基础工具 ---------------------------------------------------------

    @property
    def config(self):
        return self.server.config

    def version_string(self):
        # 不暴露 Python 版本
        return self.server_version

    def log_message(self, fmt, *args):
        logging.info("%s %s", self.address_string(), fmt % args)

    def _client_ip(self):
        """优先取反向代理写入的 X-Real-IP / X-Forwarded-For（nginx 只在 docker0 网关上可达）。"""
        real_ip = self.headers.get("X-Real-IP")
        if real_ip and real_ip.strip():
            return real_ip.strip()
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded and forwarded.strip():
            return forwarded.split(",")[0].strip()
        if self.client_address:
            return str(self.client_address[0])
        return "-"

    # -- 响应封装 ---------------------------------------------------------

    def _send_json(self, status, payload, api=True, extra_headers=()):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._response_started = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if api:
            for name, value in CORS_HEADERS:
                self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def _send_no_content(self, api=True):
        self._response_started = True
        self.send_response(204)
        if api:
            for name, value in CORS_HEADERS:
                self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _api_error(self, status, code, message, extra_headers=()):
        self._send_json(
            status, _error_payload(code, message), api=True, extra_headers=extra_headers
        )

    def _plain_error(self, status, code, message, extra_headers=()):
        self._send_json(
            status, _error_payload(code, message), api=False, extra_headers=extra_headers
        )

    def _method_not_allowed(self, allow):
        self._api_error(
            405, "method_not_allowed", "方法不允许", extra_headers=(("Allow", allow),)
        )

    # -- 请求体 -----------------------------------------------------------

    def _read_json_object(self):
        """读取并解析 JSON 请求体；失败时已回 400 并返回 None。"""
        if self.headers.get("Transfer-Encoding"):
            self._api_error(400, "bad_request", "不支持分块请求体")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._api_error(400, "bad_request", "缺少请求体")
            return None
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            self._api_error(400, "bad_request", "Content-Length 非法")
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self._api_error(400, "bad_request", "请求体过大或长度非法")
            return None
        body = self.rfile.read(length) if length else b""
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._api_error(400, "bad_request", "JSON 格式错误")
            return None
        if not isinstance(data, dict):
            self._api_error(400, "bad_request", "请求体必须是 JSON 对象")
            return None
        return data

    # -- 分发 -------------------------------------------------------------

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def _dispatch(self, method):
        self._response_started = False
        try:
            self._route(method)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001 - 顶层兜底：绝不把堆栈返回给客户端
            logging.exception("处理请求异常: %s %s", method, self.path)
            if self._response_started:
                self.close_connection = True
                return
            try:
                self._send_json(
                    500,
                    _error_payload("internal_error", "服务端异常"),
                    api=self.path.startswith("/api"),
                )
            except Exception:  # noqa: BLE001
                self.close_connection = True

    def _route(self, method):
        split = urlsplit(self.path)
        path = split.path
        query = parse_qs(split.query, keep_blank_values=True)

        if method == "OPTIONS":
            if path == "/api" or path.startswith("/api/"):
                self._send_no_content(api=True)
            else:
                self._plain_error(405, "method_not_allowed", "方法不允许")
            return

        if path == "/api/health":
            if method != "GET":
                self._method_not_allowed("GET")
                return
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": SERVER_SERVICE,
                    "version": SERVER_VERSION,
                    "time": now_iso(),
                },
                api=True,
            )
            return

        if path == "/api/version":
            if method != "GET":
                self._method_not_allowed("GET")
                return
            self._send_json(200, build_version_payload(self.config, query), api=True)
            return

        if path == "/api/login":
            if method != "POST":
                self._method_not_allowed("POST")
                return
            self._handle_login()
            return

        if path == "/api/me":
            if method != "GET":
                self._method_not_allowed("GET")
                return
            self._handle_me()
            return

        if path == "/api/stats":
            if method != "GET":
                self._method_not_allowed("GET")
                return
            self._handle_stats()
            return

        if path.startswith("/updates/") or path.startswith("/apk/"):
            self._serve_static(method, path)
            return

        self._send_json(
            404,
            _error_payload("not_found", "路径或文件不存在"),
            api=(path == "/api" or path.startswith("/api/")),
        )

    # -- /api/login -------------------------------------------------------

    def _handle_login(self):
        config = self.config
        ip = self._client_ip()
        allowed, retry_after = self.server.login_limiter.check(ip)
        if not allowed:
            logging.warning("登录限流触发：ip=%s retry_after=%ss", ip, retry_after)
            self._api_error(
                429,
                "too_many_requests",
                "登录尝试过于频繁，请稍后再试",
                extra_headers=(("Retry-After", str(retry_after)),),
            )
            return

        payload = self._read_json_object()
        if payload is None:
            return
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not username.strip():
            self._api_error(400, "bad_request", "缺少 username 字段")
            return
        if not isinstance(password, str) or not password:
            self._api_error(400, "bad_request", "缺少 password 字段")
            return
        username = username.strip()
        if len(username) > USERNAME_MAX_LEN or len(password) > PASSWORD_MAX_LEN:
            self._api_error(400, "bad_request", "用户名或密码过长")
            return

        users = load_users(config.data_dir)
        record = users.get(username)
        ok = bool(record) and verify_password(record, password)
        append_stats(
            config.data_dir,
            {"ts": now_iso(), "event": "login", "username": username, "ip": ip, "ok": ok},
        )
        if not ok:
            logging.info("登录失败：username=%s ip=%s", username, ip)
            self._api_error(401, "invalid_credentials", "账号或密码错误")
            return

        token, exp = make_token(username, config.secret)
        display_name = record.get("displayName") or username
        logging.info("登录成功：username=%s ip=%s", username, ip)
        self._send_json(
            200,
            {
                "ok": True,
                "token": token,
                "displayName": display_name,
                "username": username,
                "expiresAt": epoch_to_iso(exp),
            },
            api=True,
        )

    # -- /api/me ----------------------------------------------------------

    def _handle_me(self):
        auth = self.headers.get("Authorization", "")
        token = ""
        parts = auth.split(None, 1) if auth else []
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1].strip()
        if not token:
            self._api_error(401, "invalid_token", "缺少或非法的 Authorization 头")
            return
        try:
            info = verify_token(token, self.config.secret)
        except TokenError as exc:
            message = "token 已过期" if exc.code == "token_expired" else "token 无效"
            self._api_error(401, exc.code, message)
            return

        users = load_users(self.config.data_dir)
        record = users.get(info["username"])
        if record is None:
            self._api_error(401, "invalid_token", "token 对应的用户不存在")
            return
        self._send_json(
            200,
            {
                "ok": True,
                "username": info["username"],
                "displayName": record.get("displayName") or info["username"],
                "expiresAt": epoch_to_iso(info["exp"]),
            },
            api=True,
        )

    # -- /api/stats -------------------------------------------------------

    def _handle_stats(self):
        expected = self.config.admin_token or ""
        provided = self.headers.get("X-Admin-Token") or ""
        if not expected or not provided or not hmac.compare_digest(
            provided.encode("utf-8"), expected.encode("utf-8")
        ):
            self._api_error(403, "forbidden", "管理员 token 错误")
            return
        payload = {"ok": True}
        payload.update(build_stats_payload(self.config.data_dir))
        self._send_json(200, payload, api=True)

    # -- 静态下载 ---------------------------------------------------------

    def _serve_static(self, method, raw_path):
        if method not in ("GET", "HEAD"):
            self._plain_error(
                405, "method_not_allowed", "方法不允许", extra_headers=(("Allow", "GET, HEAD"),)
            )
            return
        try:
            path = unquote(raw_path, errors="strict")
        except (UnicodeDecodeError, ValueError):
            self._static_not_found()
            return

        if path.startswith("/updates/"):
            subdir, extension, content_type, kind = (
                "updates",
                ".zip",
                "application/zip",
                "updates",
            )
            filename = path[len("/updates/"):]
        elif path.startswith("/apk/"):
            subdir, extension, content_type, kind = (
                "apk",
                ".apk",
                "application/vnd.android.package-archive",
                "apk",
            )
            filename = path[len("/apk/"):]
        else:
            self._static_not_found()
            return

        if not self._is_safe_filename(filename, extension):
            logging.warning("拒绝非法静态路径：%s（ip=%s）", raw_path, self._client_ip())
            self._static_not_found()
            return

        root = os.path.realpath(os.path.join(self.config.data_dir, subdir))
        target = os.path.realpath(os.path.join(root, filename))
        # 双保险：只允许 data/<subdir>/ 下的普通文件（realpath 后仍在 root 内）
        if target != root and not target.startswith(root + os.sep):
            self._static_not_found()
            return
        if not os.path.isfile(target):
            self._static_not_found()
            return
        try:
            stat = os.stat(target)
        except OSError:
            self._static_not_found()
            return

        self._response_started = True
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Last-Modified", email.utils.formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        if method == "HEAD":
            return

        # 只有真正发起的 GET 下载才计入统计（HEAD 不算）
        append_stats(
            self.config.data_dir,
            {"ts": now_iso(), "event": "download", "file": filename, "ip": self._client_ip()},
        )
        try:
            with open(target, "rb") as fh:
                while True:
                    chunk = fh.read(STATIC_CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            logging.info("客户端中断下载：%s", filename)
        except OSError as exc:
            logging.warning("读取静态文件失败：%s（%s）", target, exc)
            self.close_connection = True

    @staticmethod
    def _is_safe_filename(filename, extension):
        """文件名白名单：仅 basename、安全字符、指定扩展名。"""
        if not filename or len(filename) > 200:
            return False
        if not _SAFE_FILENAME_RE.fullmatch(filename):
            return False
        if ".." in filename:
            return False
        return filename.lower().endswith(extension)

    def _static_not_found(self):
        self._plain_error(404, "not_found", "文件不存在")


class TreasureHTTPServer(ThreadingHTTPServer):
    """带 config / 登录限流器的 HTTP 服务（测试可直接实例化，端口传 0）。"""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, address, config):
        self.config = config
        self.login_limiter = LoginRateLimiter()
        super().__init__(address, TreasureHandler)


# ---------------------------------------------------------------------------
# 启动入口
# ---------------------------------------------------------------------------


def setup_logging(level=logging.INFO):
    """日志统一写 stdout（systemd/journald 捕获），不写文件、不记录密码。"""
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
        )
        root.addHandler(handler)
    root.setLevel(level)


def load_config(env=None):
    """读环境变量；生产必须设置 secret/admin token，本地开发缺省时生成临时值并告警。"""
    config = Config.from_env(env)
    if not config.secret:
        config.secret = secrets.token_hex(32)
        logging.warning(
            "TREASURE_SECRET 未设置：已生成临时密钥（重启后所有 token 失效，仅适合本地开发）"
        )
    if not config.admin_token:
        config.admin_token = secrets.token_hex(16)
        logging.warning(
            "TREASURE_ADMIN_TOKEN 未设置：本次进程临时管理员 token = %s", config.admin_token
        )
    ensure_data_dirs(config.data_dir)
    return config


def main(argv=None):
    setup_logging()
    config = load_config()
    try:
        httpd = TreasureHTTPServer((config.bind, config.port), config)
    except OSError as exc:
        logging.error("无法监听 %s:%s：%s", config.bind, config.port, exc)
        return 1

    logging.info(
        "treasure-server %s 启动：http://%s:%d（data=%s, channel=%s, public_base=%s）",
        SERVER_VERSION,
        config.bind,
        config.port,
        config.data_dir,
        config.channel,
        config.public_base,
    )

    def _stop(signum, _frame):
        logging.info("收到信号 %s，正在停止…", signum)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):
            pass

    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    logging.info("treasure-server 已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
