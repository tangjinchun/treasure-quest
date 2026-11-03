# API 契约（v1）

Base URL（公网）：`https://<YOUR_DOMAIN>/treasure`
Base URL（本地）：`http://127.0.0.1:3001`
nginx 规则：`location /treasure/ { proxy_pass http://172.17.0.1:3001/; }`，即 `/treasure` 前缀由 nginx 剥掉后转发给后端。

通用约定：

- 除静态文件外，响应均为 `application/json; charset=utf-8`。
- 成功：HTTP 200，`{"ok": true, ...}`；失败：HTTP 4xx/5xx，`{"ok": false, "error": "机器码", "message": "中文说明"}`。
- `/api/*` 全部返回 CORS 头：`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type, Authorization`、`Access-Control-Max-Age: 86400`；`OPTIONS` 返回 204。
- `/api/*` 响应头 `Cache-Control: no-store`。
- 时间统一 ISO 8601 带时区（如 `2026-11-03T14:00:00+08:00`）。

---

## GET /api/health

健康检查，无需鉴权。

```json
{"ok": true, "service": "treasure-server", "version": "1.0", "time": "2026-11-03T14:00:00+08:00"}
```

## GET /api/version

内容版本清单。查询参数均可选：`platform=android`、`shell=1`、`content=0`、`channel=test`。服务端以 `versions.json` 为准（文件热加载，发布后无需重启）。

```json
{
  "ok": true,
  "serverTime": "2026-11-03T14:00:00+08:00",
  "channel": "test",
  "content": {
    "version": 2,
    "minShellVersion": 1,
    "notes": "新增第 4 关「云端秘殿」，修复洞窟卡墙问题",
    "publishedAt": "2026-11-03T15:30:00+08:00",
    "size": 183245,
    "sha256": "3f2a...9c1d",
    "zipPath": "/updates/treasure-content-2.zip",
    "zipUrl": "https://<YOUR_DOMAIN>/treasure/updates/treasure-content-2.zip"
  },
  "apk": {
    "versionCode": 1,
    "versionName": "0.1.0",
    "notes": "首个测试包",
    "size": 2097152,
    "apkPath": "/apk/treasure-quest-0.1.0.apk",
    "apkUrl": "https://<YOUR_DOMAIN>/treasure/apk/treasure-quest-0.1.0.apk"
  },
  "updateAvailable": true
}
```

- `content` 为 `null` 表示服务器还没有任何内容包。
- `updateAvailable` 表示 `content.version > 请求参数 content`（缺省 content=0 时 true）。
- 客户端必须自行再校验 `sha256` 与 `minShellVersion`。

## GET /updates/<file>.zip

静态内容包下载。`Content-Type: application/zip`，支持 `HEAD`。文件来自 `/data/treasure/data/updates/`。

## GET /apk/<file>.apk

静态 APK 下载（给手机浏览器侧载用）。`Content-Type: application/vnd.android.package-archive`，支持 `HEAD`。文件来自 `/data/treasure/data/apk/`。

## POST /api/login

请求：

```json
{"username": "admin", "password": "123456"}
```

成功 200：

```json
{
  "ok": true,
  "token": "<base64url payload>.<base64url hmac>",
  "displayName": "测试玩家",
  "username": "admin",
  "expiresAt": "2026-12-03T14:00:00+08:00"
}
```

失败：401 `invalid_credentials`（账号或密码错误）；400 `bad_request`；429 `too_many_requests`（限流：10 次/分钟/IP）。

Token 规则：`payload = {"u": username, "exp": unix秒}`，HMAC-SHA256 用服务端密钥 `TREASURE_SECRET` 签名；有效期 30 天。密钥不写入客户端。

## GET /api/me

请求头：`Authorization: Bearer <token>`

成功 200：

```json
{"ok": true, "username": "admin", "displayName": "测试玩家", "expiresAt": "2026-12-03T14:00:00+08:00"}
```

失败：401 `invalid_token` / `token_expired`。

## GET /api/stats

管理员统计（用于验证 OTA 下载是否真的发生），请求头 `X-Admin-Token: <TREASURE_ADMIN_TOKEN>`。

```json
{
  "ok": true,
  "downloads": [{"file": "treasure-content-2.zip", "count": 3, "lastAt": "2026-11-03T15:40:00+08:00"}],
  "logins": {"total": 12, "uniqueUsers": 1},
  "recent": [{"ts": "2026-11-03T15:40:00+08:00", "event": "download", "file": "treasure-content-2.zip", "ip": "1.2.3.4"}]
}
```

失败：403 `forbidden`。

---

## 服务端数据文件

`/data/treasure/data/versions.json`（由发布脚本更新，服务端每次请求读取，热生效）：

```json
{
  "channel": "test",
  "content": {
    "version": 1,
    "minShellVersion": 1,
    "notes": "首个版本：3 个关卡",
    "publishedAt": "2026-11-03T18:00:00+08:00",
    "file": "updates/treasure-content-1.zip",
    "sha256": "…",
    "size": 123456
  },
  "apk": {
    "versionCode": 1,
    "versionName": "0.1.0",
    "notes": "首个测试包",
    "file": "apk/treasure-quest-0.1.0.apk",
    "sha256": "…",
    "size": 2097152
  }
}
```

`data/users.json`：

```json
{"users": [
  {"username": "admin", "salt": "随机hex", "passwordSha256": "sha256(salt+password)的hex", "displayName": "测试玩家", "role": "admin"}
]}
```

`data/stats.jsonl`：每行一个事件，追加写：

```json
{"ts": "2026-11-03T15:40:00+08:00", "event": "download", "file": "treasure-content-2.zip", "ip": "1.2.3.4"}
{"ts": "2026-11-03T15:41:00+08:00", "event": "login", "username": "admin", "ip": "1.2.3.4", "ok": true}
```

---

## 错误码表

| HTTP | error | 含义 |
|---|---|---|
| 400 | `bad_request` | JSON 格式错误/缺字段 |
| 401 | `invalid_credentials` | 账号或密码错误 |
| 401 | `invalid_token` / `token_expired` | token 无效/过期 |
| 403 | `forbidden` | 管理员 token 错误 |
| 404 | `not_found` | 路径或文件不存在 |
| 405 | `method_not_allowed` | 方法不允许 |
| 429 | `too_many_requests` | 登录限流 |
| 500 | `internal_error` | 服务端异常（不泄露堆栈） |

## 部署与环境变量（systemd `/data/treasure/treasure.env`）

```ini
TREASURE_BIND=172.17.0.1
TREASURE_PORT=3001
TREASURE_DATA_DIR=/data/treasure/data
TREASURE_PUBLIC_BASE=https://<YOUR_DOMAIN>/treasure
TREASURE_CHANNEL=test
TREASURE_SECRET=<随机 64 hex>
TREASURE_ADMIN_TOKEN=<随机 32 hex>
```
