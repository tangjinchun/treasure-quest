# 内容 OTA 契约（v1）

## 1. 内容包（zip）结构

zip 根目录即内容根：

```
bundle.json                  # {"contentVersion": 2, "minShellVersion": 1, "builtAt": "...", "notes": "..."}
version.json                 # 运行时可读，与 bundle.json 的 contentVersion 一致
index.html
css/style.css
js/core/*.js
js/shell/*.js
```

约束：

- 解压后总大小 ≤ 20MB（v1 实际预计 < 500KB）。
- 必须包含 `bundle.json` 与 `index.html`。
- 禁止符号链接、绝对路径、`..` 路径段（zip-slip 防护）。
- 文件清单由 `tools/build_web.ps1` 生成，禁止手工改 zip。

## 2. 发布流程

1. 修改 `web/` 源码，把 `web/version.json` 的 `contentVersion` 递增（如 1 → 2）。
2. `python tools/build_web.py --version 2 --notes "新增第4关..."` → 产出：
   - `dist/treasure-content-2.zip`
   - `dist/treasure-content-2.sha256`
   - `dist/manifest-2.json`（含 version/sha256/size/notes/publishedAt）
3. 发布（维护者执行）：`python tools/publish_content.py --version 2 --notes "..."` —— SFTP 上传 zip 到服务器 `/data/treasure/data/updates/`，更新 `versions.json`。
4. 验证：浏览器打开 `https://<YOUR_DOMAIN>/treasure/api/version`，确认 version/notes/sha256 正确。
5. APP 设置页点「检查更新」→ 下载 → 重启生效。

## 3. 原生（Android）OTA 管理器行为

### 3.1 启动时解析生效内容目录

```
files/ota/ota_state.json   {"contentVersion": 2, "activeDir": "files/web/2", "previousVersion": 1}
```

- 若 state 有效：`activeDir = <app内部存储>/web/<version>/`，检查 `bundle.json`、`index.html` 存在。
- 否则：使用内置 `assets/web/`。
- 加载失败时自动回退：优先上一版本目录，其次内置资源；删除坏目录并修正 state。

### 3.2 更新状态机

```
IDLE → CHECKING → UP_TO_DATE | AVAILABLE → DOWNLOADING(进度) → VERIFY(sha256) → UNZIP → READY(重启生效) 
                                                          └─ 失败 → ERROR（保留当前版本）
```

- 检查：`GET {apiBase}/api/version?platform=android&shell=<shellVersionCode>&content=<当前内容版本>&channel=test`，超时 8s。
- 仅当 `content.version > 当前内容版本` 且 `content.minShellVersion <= shellVersionCode` 时可更新。
- 下载到 `<files>/ota/download/tmp.zip`，同时计算 sha256；与 manifest 不一致 → 删除并报错 `sha256_mismatch`。
- 解压到 `<files>/web/<version>/`（先解压到 `web/.tmp-<version>/`，成功后再 rename，保证原子性）。
- 写 `ota_state.json`，保留上一版本目录用于回退；最多保留 2 个版本目录。
- 大小上限：20MB；超限报 `too_large`。
- 网络错误可重试 2 次（指数退避 1s/2s）。

### 3.3 JS ↔ Java 桥

Java 注册接口名：`TQNative`（`addJavascriptInterface(new TQBridge(...), "TQNative")`）。

| JS 调用 | 说明 |
|---|---|
| `TQNative.getState()` → String(JSON) | 立即返回运行状态（见下） |
| `TQNative.checkUpdate()` | 异步检查更新；结果通过事件回调 |
| `TQNative.downloadUpdate()` | 下载并安装当前可用更新；进度通过事件回调 |
| `TQNative.restartApp()` | 重启 WebView，让新内容生效 |
| `TQNative.openExternal(url)` | 用系统浏览器打开链接（如 APK 下载/更新说明） |
| `TQNative.getLogInfo()` → String | 调试用：当前内容版本/目录/内置版本 |

`getState()` 返回 JSON：

```json
{
  "platform": "android",
  "appVersionCode": 1,
  "appVersionName": "0.1.0",
  "bundledContentVersion": 1,
  "contentVersion": 1,
  "contentDir": "assets",
  "channel": "test",
  "apiBase": "https://<YOUR_DOMAIN>/treasure",
  "deviceId": "随机持久 uuid",
  "isDebug": true
}
```

Java → JS 事件：调用 `webView.evaluateJavascript("window.TQNativeEvent && TQNativeEvent('" + type + "', " + json + ")", null)`。type 与 payload：

| type | payload |
|---|---|
| `ota_checking` | `{"contentVersion":1}` |
| `ota_up_to_date` | `{"contentVersion":1}` |
| `ota_available` | `{"version":2,"notes":"...","size":183245,"publishedAt":"..."}` |
| `ota_progress` | `{"phase":"download"\|"verify"\|"unzip","percent":0-100,"received":123,"total":456}` |
| `ota_done` | `{"contentVersion":2,"restartRequired":true}` |
| `ota_error` | `{"code":"network"\|"sha256_mismatch"\|"unzip_failed"\|"too_large"\|"not_available","message":"中文"}` |

JS 侧统一入口：`window.TQNativeEvent = function(type, payload) { ... }`（由 `web/js/shell/net.js` 定义）。

### 3.4 WebView 资源加载

- 所有页面资源通过 `https://app.local/…` 加载。
- `shouldInterceptRequest` 规则：
  - host 必须是 `app.local`，否则放行（让 CDN/接口走网络）。
  - path 规范化后映射到生效内容目录内的相对路径；拒绝含 `..`、`\`、绝对路径的请求。
  - 按扩展名返回 MIME：`.html→text/html`、`.js→application/javascript`、`.css→text/css`、`.json→application/json`、`.png→image/png`、`.svg→image/svg+xml`、`.woff2→font/woff2`。
  - 响应头 `Cache-Control: no-cache`（更新后 reload 必须拿到新文件）。
  - 找不到文件返回 404，不得回退读取服务器或 assets 以外的路径。
- 更新生效后必须 `webView.clearCache(true)` 再 reload。

### 3.5 JS 侧更新 UI（游戏外壳 负责）

- 设置页显示：`内容版本 v{contentVersion}（内置 v{bundledContentVersion}）`、`检查更新` 按钮、状态文本/进度条。
- 收到 `ota_available` → 显示更新弹窗（说明、大小、`下载更新` 按钮）。
- `ota_done` → 显示「立即重启生效」按钮，点击调用 `TQNative.restartApp()`。
- 浏览器环境（无 `TQNative`）：`TQ.Net.checkUpdate()` 直接 fetch `/api/version`，可展示「有新版」但安装按钮置灰并提示「浏览器模式无法应用更新，请在 APP 内操作」——用于本地联调演示。
- 冷启动静默检查结果仅在设置页显示红点，不弹窗。

## 4. 测试场景（验收用）

| 场景 | 步骤 | 预期 |
|---|---|---|
| 首次安装 | 装 APK → 打开 | 显示内置内容 v1，可离线玩 |
| 登录 | admin/123456 | 进入主菜单；错误密码提示错误 |
| 检查更新（无新版） | 设置 → 检查更新 | 提示已是最新 |
| 发布 v2 | 发布脚本上传 → APP 检查更新 | 弹窗显示 v2 说明/大小 |
| 下载安装 | 点下载 → 等完成 | 进度正常；重启后设置页显示内容版本 v2，新关卡出现 |
| 断网更新 | 飞行模式 → 检查更新 | 报网络错误，当前版本不受影响 |
| 损坏包 | 服务器放错 sha256 → 更新 | 报校验失败，当前版本不受影响 |
| 回退 | 手动破坏 v2 目录 → 重启 APP | 自动回退 v1 并可玩 |

## 5. 后续预留（v1 不实现）

- APK 整包自更新（下载 APK + FileProvider 安装）：服务器已预留 `/apk/` 与 `versions.json.apk`。
- 增量更新（bsdiff）、灰度渠道、强制更新、静默校验时机策略。
