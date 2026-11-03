# treasure-server（《寻宝奇兵》后端）

Python 3.11 标准库实现的后端服务，严格按 [`docs/API.md`](../docs/API.md) v1 契约提供：版本清单、登录/token、内容包与 APK 静态下载、管理员统计。**无第三方依赖**，`python server.py` 即可本地运行。

- 本地地址：`http://127.0.0.1:3001`
- 公网地址（nginx 反代）：`https://<YOUR_DOMAIN>/treasure/`（生产只监听 docker0 网关 `172.17.0.1:3001`，不暴露公网端口）

## 文件清单

| 文件 | 说明 |
|---|---|
| `server.py` | 服务主程序（全部接口 + 限流 + token + 静态下载） |
| `add_user.py` | 创建/更新 `data/users.json` 账号（盐 + `sha256(salt+password)`，不硬编码密码） |
| `data/versions.json` | 版本清单样例（初始 `content=null`、`apk=null`，发布时更新，**每次请求热读取**） |
| `data/users.json` | 账号样例：`admin / 123456`（displayName 测试玩家，role admin，仅供测试版） |
| `data/stats.jsonl` | 运行时追加的事件日志（下载/登录），首次请求后自动生成 |
| `data/updates/` `data/apk/` | 内容包 zip / APK 存放目录（发布时由发布脚本通过 SFTP 上传） |
| `tests/test_server.py` | 37 个 unittest 用例（见「测试」） |
| `deploy/treasure-server.service` | systemd unit |
| `deploy/treasure-nginx-locations.inc` | nginx `/treasure/` 反代片段 |
| `deploy/install.sh` | 服务器 root 一键安装脚本（幂等） |

## 本地运行

```powershell
# 项目根目录；默认数据目录 = server/data，监听 127.0.0.1:3001
python server/server.py

# 建议本地联调时显式指定密钥/管理员 token（否则进程启动时生成临时值并打印到 stdout）
$env:TREASURE_SECRET = "0123456789abcdef" * 4
$env:TREASURE_ADMIN_TOKEN = "0123456789abcdef0123456789abcdef"
python server/server.py
```

本地浏览器联调：终端 A `python server/server.py`，终端 B `python tools/dev_server.py`，打开 `http://127.0.0.1:5173/?api=http://127.0.0.1:3001`。

### 环境变量（见 `docs/API.md` 末尾）

| 变量 | 默认（本地） | 生产（`/data/treasure/treasure.env`） |
|---|---|---|
| `TREASURE_BIND` | `127.0.0.1` | `172.17.0.1`（仅 docker0 网关可达） |
| `TREASURE_PORT` | `3001` | `3001` |
| `TREASURE_DATA_DIR` | 本文件同级 `./data` | `/data/treasure/data` |
| `TREASURE_PUBLIC_BASE` | `https://<YOUR_DOMAIN>/treasure` | `https://<YOUR_DOMAIN>/treasure` |
| `TREASURE_CHANNEL` | `test` | `test` |
| `TREASURE_SECRET` | 未设置则生成临时值 | 随机 64 hex（**必须备份**，改了会让所有 token 失效） |
| `TREASURE_ADMIN_TOKEN` | 未设置则生成临时值并打印 | 随机 32 hex（`/api/stats` 用） |

## 测试

```powershell
# 项目根目录（推荐）
python -m unittest discover -s server/tests -v

# 或在 server/ 目录内
python -m unittest discover -s tests -v
```

测试自己启动临时端口 + 临时数据目录（`tempfile`），**不依赖、不写入 `server/data/`**，可并行/反复运行。覆盖：

- `health`、`version`（无 versions.json / `content=null` / 有内容包 / 裸文件名归一化 / 非法 `file` 拒绝 / 热加载 / 坏 JSON 容错）
- `login`（成功、密码错、未知用户、坏 JSON/缺字段、10 次/分/IP 限流、按 IP 隔离）
- `me`（有效 token、缺失/畸形头、篡改签名、异密钥、过期 `token_expired`、用户已删除）
- `stats`（无/错 token 403、空统计、下载与登录聚合、HEAD/404 不计下载、倒序 recent）
- 静态下载（zip/apk 的 GET/HEAD、Content-Type/Content-Length、404、错误扩展名、嵌套路径、8 种路径穿越）
- CORS/OPTIONS 预检 204、`/api/*` 的 CORS 与 `no-store`、404/405
- `add_user.py` 与 `server.py` 的哈希契约（子进程建号后能登录）

## 手工验证（curl 清单）

```powershell
# 1) 健康检查
curl.exe -s http://127.0.0.1:3001/api/health
# {"ok": true, "service": "treasure-server", "version": "1.0", "time": "..."}

# 2) 版本清单（无内容包时 content=null、updateAvailable=false）
curl.exe -s "http://127.0.0.1:3001/api/version?platform=android&shell=1&content=0"

# 3) 登录（失败：401 invalid_credentials；错误 JSON：400 bad_request）
curl.exe -s -X POST http://127.0.0.1:3001/api/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"123456\"}"

# 4) 用 token 取用户信息
curl.exe -s http://127.0.0.1:3001/api/me -H "Authorization: Bearer <token>"

# 5) 管理员统计（403 表示 token 错）
curl.exe -s http://127.0.0.1:3001/api/stats -H "X-Admin-Token: <TREASURE_ADMIN_TOKEN>"

# 6) CORS 预检（应 204 + CORS 头）
curl.exe -s -i -X OPTIONS http://127.0.0.1:3001/api/login -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST"

# 7) 静态下载（本地先放测试文件：server/data/updates/treasure-content-2.zip）
curl.exe -s -I http://127.0.0.1:3001/updates/treasure-content-2.zip
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:3001/updates/../secret.zip   # 应 404
```

## 账号管理

```powershell
# 新增/更新账号（密码只出现在命令里，不写入代码；交互输入可用省略 password 参数）
python server/add_user.py admin 123456 --display-name "测试玩家" --role admin
python server/add_user.py player1 '<强密码>' --display-name "玩家一" --role player

# 服务器上（脚本已复制到 /data/treasure/）
cd /data/treasure
python3 add_user.py player2 '<强密码>' --display-name "玩家二" --role player
```

- `users.json` 只保存 `salt`（32 hex）与 `sha256(salt+password)`（hex），**不保存明文密码，也不会把密码写日志**。
- 修改密码 = 同用户名再执行一次（重新生成盐）。
- 文件写入为「临时文件 + `os.replace`」原子替换，权限 `600`。
- 测试账号 `admin / 123456` 仅用于 v1 测试，上线前建议改密码。

## 数据文件与发布

### `data/versions.json`（服务端每次请求热读取）

初始样例（仓库内）：

```json
{"channel": "test", "content": null, "apk": null}
```

发布内容包后（由 维护者 的发布脚本/SFTP 更新）：

```json
{
  "channel": "test",
  "content": {
    "version": 2,
    "minShellVersion": 1,
    "notes": "新增第 4 关「云端秘殿」，修复洞窟卡墙问题",
    "publishedAt": "2026-11-03T15:30:00+08:00",
    "file": "updates/treasure-content-2.zip",
    "sha256": "<zip 的 sha256 hex>",
    "size": 183245
  },
  "apk": {
    "versionCode": 1,
    "versionName": "0.1.0",
    "notes": "首个测试包",
    "file": "apk/treasure-quest-0.1.0.apk",
    "sha256": "<apk 的 sha256 hex>",
    "size": 2097152
  }
}
```

- `content: null` = 服务器还没有任何内容包；`apk: null` = 还没上传 APK。
- `file` 兼容 `updates/x.zip`、`/updates/x.zip`、裸文件名 `x.zip`（自动补目录前缀）；含 `..` 段会被拒绝（不下发 `zipPath`）。
- 服务端响应里自动生成 `zipPath`（`/updates/x.zip`）与 `zipUrl`（`TREASURE_PUBLIC_BASE + zipPath`）；`size` 缺省时用磁盘文件真实大小兜底。
- **不需要重启服务**，改完文件下一次 `/api/version` 立即生效。

### 发布内容包流程（维护者 执行，详见 `docs/OTA.md` 第 2 节）

1. `web/version.json` 的 `contentVersion` +1 → `powershell tools/build_web.ps1 -Version 2 -Notes "..."`
2. 产出 `dist/treasure-content-2.zip` / `.sha256` / `manifest-2.json`
3. `powershell tools/publish_content.ps1 -Version 2`：SFTP 上传 zip 到服务器 `/data/treasure/data/updates/`，并更新 `/data/treasure/data/versions.json`
4. 验证：浏览器打开 `https://<YOUR_DOMAIN>/treasure/api/version`，确认 `content.version/notes/sha256/size` 正确（热生效，无需重启）
5. APP 设置页「检查更新」→ 下载 → 重启生效

APK 侧载同理：上传到 `/data/treasure/data/apk/` + 更新 `versions.json.apk`。

### `data/stats.jsonl`

每行一个 JSON 事件，只追加、不轮转（v1 流量很小）：

```json
{"ts":"2026-11-03T15:40:00+08:00","event":"download","file":"treasure-content-2.zip","ip":"1.2.3.4"}
{"ts":"2026-11-03T15:41:00+08:00","event":"login","username":"admin","ip":"1.2.3.4","ok":true}
```

`GET /api/stats` 聚合口径：`downloads` 按文件聚合成功 GET 下载（HEAD 不算）；`logins.total` 只统计**成功**登录次数，`uniqueUsers` 为成功登录过的用户名数；`recent` 为最近 20 条事件（倒序）。事件里不记录密码。

## 服务器部署（维护者 执行，其他人不要 SSH）

前置：服务器 OpenCloudOS 9.4（`/usr/bin/python3` 3.11.6）、Docker 容器 `nginx` 是唯一 80/443 入口、宿主机 `/data/nginx/conf.d/` 挂载到容器 `/etc/nginx/conf.d/`。

```bash
# 1) 本地打包（示例）
#    tar 包内容结构：
#    server.py
#    add_user.py
#    deploy/install.sh
#    deploy/treasure-server.service
#    deploy/treasure-nginx-locations.inc

# 2) 上传并解压到服务器 /data/treasure/_deploy
#    （维护者 用 SFTP/SCP）

# 3) 服务器 root 执行（无交互；可重复执行）
bash /data/treasure/_deploy/deploy/install.sh
```

`install.sh` 的行为（幂等）：

1. 检查 root / `/usr/bin/python3` / 源文件 / `nginx` 容器；
2. 创建系统用户 `treasure`（已存在则跳过）、目录 `/data/treasure/data/{updates,apk}`；
3. 复制 `_deploy/server.py`、`_deploy/add_user.py` 到 `/data/treasure/`（覆盖代码，不动数据）；
4. 首次初始化数据：`versions.json`（`content=null` 样例）、`users.json`（用 `add_user.py` 生成测试账号 `admin/123456`）；已存在则**原样保留**；
5. 生成 `/data/treasure/treasure.env`（随机 `TREASURE_SECRET` 64 hex / `TREASURE_ADMIN_TOKEN` 32 hex，权限 600、属主 treasure）；**已存在则保留原值**，只补齐缺失的非密钥项；
6. 安装 systemd unit（`ExecStart=/usr/bin/python3 /data/treasure/server.py`，`User=treasure`，`Restart=on-failure`），`daemon-reload` + `enable` + `restart`，轮询本地 health 最多 30s；
7. 复制 `treasure-locations.inc` 到 `/data/nginx/conf.d/`；在 `/data/nginx/conf.d/default.conf` 的 **443 server 块内**（优先 `server_name` 含 `<YOUR_DOMAIN>` 的块，插在 n8n 等 location 之后、块结束 `}` 之前）幂等插入：
   ```nginx
       # TREASURE-GAME-INCLUDE
       include /etc/nginx/conf.d/treasure-locations.inc;
   ```
   改前备份到 `/root/default.conf.bak-treasure-<时间戳>`；`docker exec nginx nginx -t` 通过才 `nginx -s reload`，失败自动回滚；
8. 打印自检：`systemctl is-active treasure-server`、`curl http://172.17.0.1:3001/api/health`、`docker exec nginx nginx -t`。任何一步失败 `exit 非 0`。

部署后验证：

```bash
cat /data/treasure/treasure.env              # 备份其中的 SECRET / ADMIN_TOKEN（不要在聊天里贴）
systemctl status treasure-server --no-pager
journalctl -u treasure-server -n 50 --no-pager
curl -s http://172.17.0.1:3001/api/health
curl -s https://<YOUR_DOMAIN>/treasure/api/health
curl -s "https://<YOUR_DOMAIN>/treasure/api/version?platform=android&shell=1&content=0"
```

回滚 nginx（如需）：`cp /root/default.conf.bak-treasure-<时间戳> /data/nginx/conf.d/default.conf && docker exec nginx nginx -t && docker exec nginx nginx -s reload`。

## 接口实现细节（契约之外需知道的点）

- **token**：`base64url(JSON {"u":用户名,"exp":unix秒})` + `.` + `base64url(HMAC-SHA256(TREASURE_SECRET, payloadB64))`，无 `=` 填充；有效期 30 天；签名对象是 payload 的 base64url 字符串（ASCII）。
- **限流**：`POST /api/login` 按 IP 滑动窗口 10 次/分钟，第 11 次起 `429 too_many_requests` 并带 `Retry-After`；限流在内存里，重启重置。IP 优先取 nginx 传来的 `X-Real-IP` / `X-Forwarded-For`。
- **CORS**：所有 `/api/*` 响应（含错误）带 4 个 CORS 头 + `Cache-Control: no-store`；`OPTIONS` 返回 204。
- **静态下载**：仅允许 `data/updates/*.zip`、`data/apk/*.apk`；文件名必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`；`unquote` 后校验 + `realpath` 二次确认仍在目标目录内（防路径穿越/编码穿越/符号链接逃逸）；支持 GET/HEAD，`Content-Type` 分别为 `application/zip`、`application/vnd.android.package-archive`。
- **错误响应**：统一 `{"ok":false,"error":"机器码","message":"中文说明"}`；异常只回 `500 internal_error`，堆栈只写日志（stdout/journald），不回客户端；`Server` 头不暴露 Python 版本。
- **日志**：stdout（systemd → journald），格式 `时间 级别 内容`，记录请求行、登录成功/失败用户名（不含密码）、限流与下载中断；不写文件日志。

## 安全约束与已知限制

- 只监听 `172.17.0.1:3001`，公网仅经 nginx `/treasure/`；**不提供 HTTP 发布/上传接口**，内容发布走 SFTP。
- 密钥只放 `treasure.env`（600，属主 treasure），不入库、不写客户端、不打印到日志（未设置时生成的临时 token 会打印一次，仅本地开发用）。
- 登录限流为单进程内存实现：systemd 重启后清零；v1 单实例足够。
- `stats.jsonl` 不自动轮转；量级很小（测试版），如长期运行可手动归档（先 `copytruncate` 或停服压缩）。
- 渠道参数 `channel` 目前只回显/取默认值（v1 单渠道 `test`），不做多渠道路由。
- 管理员统计 `logins.total` 按「成功登录次数」统计（产品口径已与 维护者 确认）。
