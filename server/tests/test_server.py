#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""server/tests/test_server.py —— 后端单元测试（Python 标准库 unittest）。

运行（项目根目录）：
    python -m unittest discover -s server/tests -v

每个测试自行启动临时端口 + 临时数据目录，不依赖任何外部服务，也不会写 server/data/。
覆盖 docs/API.md：
    health、version（无包/content=null/有包/热加载）、login（成功/密码错误/坏请求/限流）、
    me（有效/无效/篡改/过期 token）、stats（鉴权/聚合）、
    静态 zip/apk 下载（GET/HEAD/404/路径穿越）、CORS 预检、404/405。
"""

import http.client
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import server as tq_server  # noqa: E402

_LOADED = Path(getattr(tq_server, "__file__", "")).resolve()
if _LOADED != (SERVER_DIR / "server.py").resolve():  # pragma: no cover - 防误导入
    raise ImportError("加载到了错误的 server 模块：%s" % _LOADED)

ADMIN_USER = "admin"
ADMIN_PASSWORD = "123456"
ADMIN_DISPLAY = "测试玩家"
ADMIN_TOKEN = "unit-test-admin-token-0123456789abcdef"
SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef"
PUBLIC_BASE = "https://example.test/treasure"


def setUpModule():
    # 测试期间静默服务端日志（不影响断言），避免大量 expected-error 日志刷屏
    logging.disable(logging.CRITICAL)


def tearDownModule():
    logging.disable(logging.NOTSET)


class ServerTestCase(unittest.TestCase):
    """每个测试一个独立服务实例 + 独立临时数据目录。"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(prefix="tq-server-test-")
        self.data_dir = self.tmpdir.name
        os.makedirs(os.path.join(self.data_dir, "updates"), exist_ok=True)
        os.makedirs(os.path.join(self.data_dir, "apk"), exist_ok=True)

        salt = tq_server.new_salt()
        self.write_users(
            [
                {
                    "username": ADMIN_USER,
                    "salt": salt,
                    "passwordSha256": tq_server.password_sha256(salt, ADMIN_PASSWORD),
                    "displayName": ADMIN_DISPLAY,
                    "role": "admin",
                }
            ]
        )

        self.config = tq_server.Config(
            bind="127.0.0.1",
            port=0,
            data_dir=self.data_dir,
            public_base=PUBLIC_BASE,
            channel="test",
            secret=SECRET,
            admin_token=ADMIN_TOKEN,
        )
        self.httpd = tq_server.TreasureHTTPServer(("127.0.0.1", 0), self.config)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

        self.addCleanup(self.tmpdir.cleanup)
        self.addCleanup(self._stop_server)

    def _stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    # -- 工具 -------------------------------------------------------------

    def request(self, method, path, body=None, headers=None):
        """发一个 HTTP 请求，返回 (status, lowercase headers dict, raw body bytes)。"""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            raw = response.read()
            status = response.status
            response_headers = {name.lower(): value for name, value in response.getheaders()}
            return status, response_headers, raw
        finally:
            conn.close()

    def get_json(self, path, headers=None):
        status, response_headers, raw = self.request("GET", path, headers=headers)
        return status, response_headers, json.loads(raw.decode("utf-8"))

    def post_json(self, path, obj, headers=None):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        merged = {"Content-Type": "application/json"}
        merged.update(headers or {})
        status, response_headers, raw = self.request("POST", path, body=payload, headers=merged)
        return status, response_headers, json.loads(raw.decode("utf-8"))

    def login(self, username=ADMIN_USER, password=ADMIN_PASSWORD):
        status, _headers, body = self.post_json(
            "/api/login", {"username": username, "password": password}
        )
        self.assertEqual(status, 200, body)
        return body["token"]

    def write_users(self, users):
        with open(os.path.join(self.data_dir, "users.json"), "w", encoding="utf-8") as fh:
            json.dump({"users": users}, fh, ensure_ascii=False, indent=2)

    def write_file(self, relative, data):
        path = os.path.join(self.data_dir, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def write_versions(self, data):
        with open(os.path.join(self.data_dir, "versions.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)

    def write_raw_versions(self, text):
        with open(os.path.join(self.data_dir, "versions.json"), "w", encoding="utf-8") as fh:
            fh.write(text)

    def assert_api_error(self, status, body, expected_status, expected_code):
        self.assertEqual(status, expected_status, body)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], expected_code)
        self.assertIsInstance(body["message"], str)
        self.assertTrue(body["message"])


# ---------------------------------------------------------------------------
# health / version
# ---------------------------------------------------------------------------


class HealthVersionTests(ServerTestCase):
    def test_health(self):
        status, headers, body = self.get_json("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(headers["access-control-allow-origin"], "*")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertTrue(body["ok"])
        self.assertEqual(body["service"], "treasure-server")
        self.assertEqual(body["version"], "1.0")
        # 时间必须是 ISO 8601 且带时区
        parsed = datetime.fromisoformat(body["time"])
        self.assertIsNotNone(parsed.tzinfo)

    def test_version_without_versions_file(self):
        status, _headers, body = self.get_json("/api/version")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["channel"], "test")
        self.assertIsNone(body["content"])
        self.assertIsNone(body["apk"])
        self.assertFalse(body["updateAvailable"])
        self.assertIsNotNone(datetime.fromisoformat(body["serverTime"]).tzinfo)

    def test_version_content_null(self):
        self.write_versions({"channel": "test", "content": None, "apk": None})
        status, _headers, body = self.get_json("/api/version?platform=android&shell=1&content=0")
        self.assertEqual(status, 200)
        self.assertIsNone(body["content"])
        self.assertFalse(body["updateAvailable"])

    def test_version_with_content_and_apk(self):
        self.write_versions(
            {
                "channel": "test",
                "content": {
                    "version": 2,
                    "minShellVersion": 1,
                    "notes": "新增第 4 关「云端秘殿」",
                    "publishedAt": "2026-11-03T15:30:00+08:00",
                    "file": "updates/treasure-content-2.zip",
                    "sha256": "3f2a9c1d",
                    "size": 183245,
                },
                "apk": {
                    "versionCode": 1,
                    "versionName": "0.1.0",
                    "notes": "首个测试包",
                    "file": "apk/treasure-quest-0.1.0.apk",
                    "size": 2097152,
                },
            }
        )
        status, _headers, body = self.get_json(
            "/api/version?platform=android&shell=1&content=1&channel=test"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["channel"], "test")
        content = body["content"]
        self.assertEqual(content["version"], 2)
        self.assertEqual(content["minShellVersion"], 1)
        self.assertEqual(content["notes"], "新增第 4 关「云端秘殿」")
        self.assertEqual(content["publishedAt"], "2026-11-03T15:30:00+08:00")
        self.assertEqual(content["size"], 183245)
        self.assertEqual(content["sha256"], "3f2a9c1d")
        self.assertEqual(content["zipPath"], "/updates/treasure-content-2.zip")
        self.assertEqual(content["zipUrl"], PUBLIC_BASE + "/updates/treasure-content-2.zip")
        apk = body["apk"]
        self.assertEqual(apk["versionCode"], 1)
        self.assertEqual(apk["versionName"], "0.1.0")
        self.assertEqual(apk["size"], 2097152)
        self.assertEqual(apk["apkPath"], "/apk/treasure-quest-0.1.0.apk")
        self.assertEqual(apk["apkUrl"], PUBLIC_BASE + "/apk/treasure-quest-0.1.0.apk")
        self.assertTrue(body["updateAvailable"])

        # 客户端已是最新（content=2）时不可更新
        _status, _headers, body_latest = self.get_json("/api/version?content=2")
        self.assertFalse(body_latest["updateAvailable"])

        # 缺省 content=0 时，有内容包即视为有更新
        _status, _headers, body_default = self.get_json("/api/version")
        self.assertTrue(body_default["updateAvailable"])

    def test_version_bare_filename_is_normalised(self):
        self.write_versions(
            {
                "content": {
                    "version": 3,
                    "minShellVersion": 1,
                    "file": "treasure-content-3.zip",
                }
            }
        )
        status, _headers, body = self.get_json("/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(body["content"]["zipPath"], "/updates/treasure-content-3.zip")

    def test_version_rejects_traversal_file_field(self):
        self.write_versions(
            {"content": {"version": 1, "file": "../../../etc/passwd", "size": 1}}
        )
        status, _headers, body = self.get_json("/api/version")
        self.assertEqual(status, 200)
        self.assertIsNone(body["content"]["zipPath"])
        self.assertIsNone(body["content"]["zipUrl"])

    def test_version_hot_reload(self):
        _status, _headers, body = self.get_json("/api/version")
        self.assertIsNone(body["content"])

        self.write_versions({"content": {"version": 1, "file": "updates/c1.zip"}})
        _status, _headers, body = self.get_json("/api/version")
        self.assertEqual(body["content"]["version"], 1)

        self.write_versions({"content": {"version": 5, "file": "updates/c5.zip"}})
        _status, _headers, body = self.get_json("/api/version")
        self.assertEqual(body["content"]["version"], 5, "versions.json 必须每次请求热读取")

    def test_version_invalid_json_is_treated_as_empty(self):
        self.write_raw_versions("{ this is not json")
        status, _headers, body = self.get_json("/api/version")
        self.assertEqual(status, 200)
        self.assertIsNone(body["content"])
        self.assertFalse(body["updateAvailable"])


# ---------------------------------------------------------------------------
# login
# ---------------------------------------------------------------------------


class LoginTests(ServerTestCase):
    def test_login_success(self):
        status, headers, body = self.post_json(
            "/api/login", {"username": ADMIN_USER, "password": ADMIN_PASSWORD}
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertTrue(body["ok"])
        self.assertEqual(body["username"], ADMIN_USER)
        self.assertEqual(body["displayName"], ADMIN_DISPLAY)
        self.assertIsNotNone(datetime.fromisoformat(body["expiresAt"]).tzinfo)

        token = body["token"]
        payload_b64, sig_b64 = token.split(".")
        self.assertTrue(payload_b64)
        self.assertTrue(sig_b64)
        payload = json.loads(tq_server.b64url_decode(payload_b64).decode("utf-8"))
        self.assertEqual(payload["u"], ADMIN_USER)
        ttl = payload["exp"] - int(time.time())
        self.assertGreater(ttl, 29 * 24 * 3600, "token 有效期应约 30 天")
        self.assertLessEqual(ttl, 30 * 24 * 3600 + 10)
        # 签名必须与 TREASURE_SECRET 匹配
        self.assertEqual(tq_server.verify_token(token, SECRET)["username"], ADMIN_USER)

    def test_login_wrong_password(self):
        status, _headers, body = self.post_json(
            "/api/login", {"username": ADMIN_USER, "password": "wrong-password"}
        )
        self.assert_api_error(status, body, 401, "invalid_credentials")

    def test_login_unknown_user(self):
        status, _headers, body = self.post_json(
            "/api/login", {"username": "nobody", "password": ADMIN_PASSWORD}
        )
        self.assert_api_error(status, body, 401, "invalid_credentials")

    def test_login_bad_request(self):
        status, _headers, raw = self.request(
            "POST",
            "/api/login",
            body=b"{not-json",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode("utf-8"))["error"], "bad_request")

        status, _headers, body = self.post_json("/api/login", {"username": ADMIN_USER})
        self.assert_api_error(status, body, 400, "bad_request")

        status, _headers, body = self.post_json("/api/login", {"username": "", "password": ""})
        self.assert_api_error(status, body, 400, "bad_request")

        status, _headers, raw = self.request(
            "POST",
            "/api/login",
            body=b'["not", "an", "object"]',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode("utf-8"))["error"], "bad_request")

    def test_login_rate_limit_10_per_minute(self):
        for attempt in range(10):
            status, _headers, body = self.post_json(
                "/api/login", {"username": ADMIN_USER, "password": "wrong-%d" % attempt}
            )
            self.assertEqual(status, 401, "第 %d 次尝试应为 401" % (attempt + 1))

        # 第 11 次（即使密码正确）也必须 429
        status, headers, body = self.post_json(
            "/api/login", {"username": ADMIN_USER, "password": ADMIN_PASSWORD}
        )
        self.assert_api_error(status, body, 429, "too_many_requests")
        self.assertIn("retry-after", headers)
        self.assertGreaterEqual(int(headers["retry-after"]), 1)

        # 限流按 IP 计：换一个 X-Real-IP 可以继续登录
        status, _headers, body = self.post_json(
            "/api/login",
            {"username": ADMIN_USER, "password": ADMIN_PASSWORD},
            headers={"X-Real-IP": "203.0.113.9"},
        )
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])

    def test_login_rate_limit_counts_bad_requests(self):
        for _ in range(10):
            self.request(
                "POST",
                "/api/login",
                body=b"garbage",
                headers={"Content-Type": "application/json"},
            )
        status, _headers, body = self.post_json(
            "/api/login", {"username": ADMIN_USER, "password": ADMIN_PASSWORD}
        )
        self.assert_api_error(status, body, 429, "too_many_requests")

    def test_login_wrong_method(self):
        status, headers, body = self.get_json("/api/login")
        self.assert_api_error(status, body, 405, "method_not_allowed")
        self.assertEqual(headers["allow"], "POST")


# ---------------------------------------------------------------------------
# me
# ---------------------------------------------------------------------------


class MeTests(ServerTestCase):
    def test_me_with_valid_token(self):
        token = self.login()
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer " + token}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["username"], ADMIN_USER)
        self.assertEqual(body["displayName"], ADMIN_DISPLAY)
        self.assertIsNotNone(datetime.fromisoformat(body["expiresAt"]).tzinfo)

    def test_me_missing_or_malformed_header(self):
        for headers in ({}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer"}):
            status, _headers, body = self.get_json("/api/me", headers=headers)
            self.assert_api_error(status, body, 401, "invalid_token")

    def test_me_invalid_token(self):
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer not.a.token"}
        )
        self.assert_api_error(status, body, 401, "invalid_token")

    def test_me_tampered_signature(self):
        token = self.login()
        payload_b64, sig_b64 = token.split(".")
        flipped = "A" if sig_b64[-1] != "A" else "B"
        tampered = payload_b64 + "." + sig_b64[:-1] + flipped
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer " + tampered}
        )
        self.assert_api_error(status, body, 401, "invalid_token")

    def test_me_token_signed_with_other_secret(self):
        token, _exp = tq_server.make_token(ADMIN_USER, "a-different-secret")
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer " + token}
        )
        self.assert_api_error(status, body, 401, "invalid_token")

    def test_me_expired_token(self):
        token, _exp = tq_server.make_token(ADMIN_USER, SECRET, ttl=-120)
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer " + token}
        )
        self.assert_api_error(status, body, 401, "token_expired")

    def test_me_token_for_deleted_user(self):
        token, _exp = tq_server.make_token("ghost-user", SECRET)
        status, _headers, body = self.get_json(
            "/api/me", headers={"Authorization": "Bearer " + token}
        )
        self.assert_api_error(status, body, 401, "invalid_token")


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------


class StatsTests(ServerTestCase):
    def test_stats_forbidden(self):
        for headers in ({}, {"X-Admin-Token": "wrong-token"}):
            status, _headers, body = self.get_json("/api/stats", headers=headers)
            self.assert_api_error(status, body, 403, "forbidden")
        # 错误响应也要带 CORS / no-store（/api/* 统一约定）
        status, response_headers, body = self.get_json("/api/stats")
        self.assert_api_error(status, body, 403, "forbidden")
        self.assertEqual(response_headers["access-control-allow-origin"], "*")
        self.assertEqual(response_headers["cache-control"], "no-store")

    def test_stats_empty(self):
        status, _headers, body = self.get_json(
            "/api/stats", headers={"X-Admin-Token": ADMIN_TOKEN}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["downloads"], [])
        self.assertEqual(body["logins"], {"total": 0, "uniqueUsers": 0})
        self.assertEqual(body["recent"], [])

    def test_stats_aggregates_downloads_and_logins(self):
        self.login()  # 1 次成功登录
        self.write_file("updates/treasure-content-2.zip", b"PK\x03\x04content-v2")
        self.write_file("apk/treasure-quest-0.1.0.apk", b"APK-DATA")

        for _ in range(2):
            status, _headers, _raw = self.request("GET", "/updates/treasure-content-2.zip")
            self.assertEqual(status, 200)
        status, _headers, _raw = self.request("GET", "/apk/treasure-quest-0.1.0.apk")
        self.assertEqual(status, 200)
        # HEAD 与 404 都不应计入下载统计
        self.request("HEAD", "/updates/treasure-content-2.zip")
        self.request("GET", "/updates/does-not-exist.zip")

        status, _headers, body = self.get_json(
            "/api/stats", headers={"X-Admin-Token": ADMIN_TOKEN}
        )
        self.assertEqual(status, 200)
        by_file = {item["file"]: item for item in body["downloads"]}
        self.assertEqual(by_file["treasure-content-2.zip"]["count"], 2)
        self.assertEqual(by_file["treasure-quest-0.1.0.apk"]["count"], 1)
        self.assertEqual(len(body["downloads"]), 2)
        self.assertIsNotNone(datetime.fromisoformat(by_file["treasure-content-2.zip"]["lastAt"]).tzinfo)
        self.assertEqual(body["logins"], {"total": 1, "uniqueUsers": 1})
        self.assertGreaterEqual(len(body["recent"]), 4)
        self.assertLessEqual(len(body["recent"]), 20)
        # recent 为倒序：最后发生的事件在最前
        self.assertEqual(body["recent"][0]["event"], "download")
        events = [item.get("event") for item in body["recent"]]
        self.assertIn("login", events)
        # 事件里不记录密码
        for item in body["recent"]:
            self.assertNotIn("password", item)

    def test_stats_wrong_method(self):
        status, _headers, body = self.post_json(
            "/api/stats", {}, headers={"X-Admin-Token": ADMIN_TOKEN}
        )
        self.assert_api_error(status, body, 405, "method_not_allowed")


# ---------------------------------------------------------------------------
# 静态下载 /updates/*.zip、/apk/*.apk
# ---------------------------------------------------------------------------


class StaticFileTests(ServerTestCase):
    def test_download_zip_get_and_head(self):
        payload = b"PK\x03\x04 fake zip bytes for unit test"
        self.write_file("updates/treasure-content-2.zip", payload)

        status, headers, body = self.request("GET", "/updates/treasure-content-2.zip")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/zip")
        self.assertEqual(headers["content-length"], str(len(payload)))
        self.assertEqual(body, payload)

        status, headers, body = self.request("HEAD", "/updates/treasure-content-2.zip")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/zip")
        self.assertEqual(headers["content-length"], str(len(payload)))
        self.assertEqual(body, b"")

    def test_download_apk_get_and_head(self):
        payload = b"PK\x03\x04 fake apk bytes"
        self.write_file("apk/treasure-quest-0.1.0.apk", payload)

        status, headers, body = self.request("GET", "/apk/treasure-quest-0.1.0.apk")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/vnd.android.package-archive")
        self.assertEqual(headers["content-length"], str(len(payload)))
        self.assertEqual(body, payload)

        status, headers, body = self.request("HEAD", "/apk/treasure-quest-0.1.0.apk")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/vnd.android.package-archive")
        self.assertEqual(body, b"")

    def test_missing_files_return_404_json(self):
        for path in (
            "/updates/treasure-content-9.zip",
            "/apk/treasure-quest-9.9.9.apk",
            "/updates/",
            "/apk/",
        ):
            status, headers, raw = self.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertIn("application/json", headers["content-type"])
            parsed = json.loads(raw.decode("utf-8"))
            self.assertEqual(parsed["error"], "not_found")
            self.assertFalse(parsed["ok"])

    def test_wrong_extension_and_nested_paths(self):
        self.write_file("updates/notes.txt", b"should not be served")
        self.write_file("updates/sub/dir.zip", b"nested")
        for path in (
            "/updates/notes.txt",
            "/apk/treasure.zip",
            "/updates/sub/dir.zip",
            "/updates/.hidden.zip",
        ):
            status, _headers, _raw = self.request("GET", path)
            self.assertEqual(status, 404, path)

    def test_path_traversal_blocked(self):
        secret = b"TOP-SECRET-OUTSIDE-UPDATES"
        # 放在 data/ 根（updates/ 的上一级），各种穿越都不允许读到
        self.write_file("secret.zip", secret)
        outside = self.write_file("../secret-2.zip", secret)  # 临时目录之外，测完删除
        self.addCleanup(lambda: os.path.exists(outside) and os.remove(outside))
        attempts = (
            "/updates/../secret.zip",
            "/updates/%2e%2e/secret.zip",
            "/updates/..%2Fsecret.zip",
            "/updates/..%5Csecret.zip",
            "/updates/%2e%2e%2f%2e%2e%2fsecret-2.zip",
            "/apk/..%2f..%2fsecret-2.zip",
            "/updates/C%3A%5CWindows%5Cwin.ini",
            "/updates/..%2f..%2f..%2fetc%2fpasswd",
        )
        for path in attempts:
            status, headers, raw = self.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(secret, raw, path)
            self.assertIn("application/json", headers["content-type"])

    def test_static_wrong_method(self):
        self.write_file("updates/treasure-content-2.zip", b"PK")
        status, headers, raw = self.request("POST", "/updates/treasure-content-2.zip")
        self.assertEqual(status, 405)
        parsed = json.loads(raw.decode("utf-8"))
        self.assertEqual(parsed["error"], "method_not_allowed")
        self.assertEqual(headers["allow"], "GET, HEAD")


# ---------------------------------------------------------------------------
# CORS / 路由兜底
# ---------------------------------------------------------------------------


class CorsAndRoutingTests(ServerTestCase):
    def test_options_preflight(self):
        for path in ("/api/login", "/api/me", "/api/health", "/api/version"):
            status, headers, raw = self.request(
                "OPTIONS",
                path,
                headers={
                    "Origin": "https://example.test",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type, authorization",
                },
            )
            self.assertEqual(status, 204, path)
            self.assertEqual(raw, b"", path)
            self.assertEqual(headers["access-control-allow-origin"], "*")
            self.assertEqual(
                headers["access-control-allow-methods"], "GET, POST, OPTIONS"
            )
            self.assertEqual(
                headers["access-control-allow-headers"], "Content-Type, Authorization"
            )
            self.assertEqual(headers["access-control-max-age"], "86400")

    def test_api_responses_have_cors_and_no_store(self):
        for path, headers in (
            ("/api/health", None),
            ("/api/version", None),
            ("/api/me", None),
            ("/api/stats", None),
            ("/api/does-not-exist", None),
            ("/api/login", {"Authorization": "Bearer x"}),
        ):
            status, response_headers, _raw = self.request("GET", path, headers=headers or {})
            self.assertEqual(
                response_headers.get("access-control-allow-origin"), "*", path
            )
            self.assertEqual(response_headers.get("cache-control"), "no-store", path)
            self.assertIn(status, (200, 401, 403, 404, 405), path)

    def test_unknown_paths(self):
        status, _headers, body = self.get_json("/api/does-not-exist")
        self.assert_api_error(status, body, 404, "not_found")

        status, headers, raw = self.request("GET", "/")
        self.assertEqual(status, 404)
        self.assertIn("application/json", headers["content-type"])
        self.assertEqual(json.loads(raw.decode("utf-8"))["error"], "not_found")

    def test_method_not_allowed(self):
        status, headers, body = self.post_json("/api/health", {})
        self.assert_api_error(status, body, 405, "method_not_allowed")
        self.assertEqual(headers["allow"], "GET")

        status, headers, body = self.request(
            "PUT", "/api/version", body=b"{}", headers={"Content-Type": "application/json"}
        )
        self.assertEqual(status, 405)
        self.assertEqual(json.loads(body.decode("utf-8"))["error"], "method_not_allowed")

        status, _headers, body = self.get_json("/api/login")
        self.assert_api_error(status, body, 405, "method_not_allowed")


# ---------------------------------------------------------------------------
# add_user.py（与 server.py 的哈希契约必须一致）
# ---------------------------------------------------------------------------


class AddUserTests(ServerTestCase):
    def test_add_user_cli_creates_loginable_account(self):
        script = SERVER_DIR / "add_user.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                "tester",
                "s3cret-pass",
                "--display-name",
                "Tester",
                "--role",
                "player",
                "--data-dir",
                self.data_dir,
            ],
            capture_output=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode, 0, completed.stderr.decode("utf-8", "replace")
        )

        with open(os.path.join(self.data_dir, "users.json"), "r", encoding="utf-8") as fh:
            db = json.load(fh)
        usernames = [item["username"] for item in db["users"]]
        self.assertIn(ADMIN_USER, usernames)
        self.assertIn("tester", usernames)

        record = next(item for item in db["users"] if item["username"] == "tester")
        self.assertEqual(record["role"], "player")
        self.assertEqual(record["displayName"], "Tester")
        self.assertEqual(
            record["passwordSha256"],
            tq_server.password_sha256(record["salt"], "s3cret-pass"),
        )
        self.assertNotIn("s3cret-pass", json.dumps(db, ensure_ascii=False))

        status, _headers, body = self.post_json(
            "/api/login", {"username": "tester", "password": "s3cret-pass"}
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(body["displayName"], "Tester")


if __name__ == "__main__":
    unittest.main(verbosity=2)
