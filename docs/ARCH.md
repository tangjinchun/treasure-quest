# 《寻宝奇兵》系统架构（v1 测试版）

> 本文档是四条开发线的公共契约。实现前必读；接口变更必须先改本文档并通知 维护者。
> 项目根目录：`<repo>`（即本仓库根目录）

## 1. 目标与非目标

**v1 目标（本次交付）**

1. 一台安卓手机侧载安装 APK 后，能登录（测试账号）、玩 4 个关卡（v2 新增第 4 关）、有存档、有音效与触屏操作。
2. 之后服务器发布新内容包，APP 内点「检查更新」→ 下载 → 校验 → 重启生效（内容 OTA）。
3. 全链路文档化：本地开发、浏览器测试、APK 构建、服务器部署、内容发布。

**v1 非目标**

- 用户注册/找回密码/第三方登录（后续版本）
- 云存档、排行榜、支付、广告、内购
- 上架应用商店、软著/版号（用户自行办理）
- iOS、横竖屏自适应（v1 固定横屏）

## 2. 技术选型（结论）

**H5 Canvas 游戏 + Android WebView 壳 + 原生内容 OTA 下载器 + Python 后端。**

| 选项 | 结论 | 理由 |
|---|---|---|
| H5 Canvas + WebView 壳（采用） | ✅ | 内容热更新 = 替换 web 资源包，无需重装 APK；同一份代码浏览器可直接测试；本机无 Unity/Android Studio 也能交付 |
| Unity + APK 整包自更新 | ❌ | 本机无 Unity；整包 OTA 每次都要下载安装 APK，链路重且慢 |
| 纯原生 Android 游戏 | ❌ | 开发量大 5–10 倍，且没有内容热更新能力 |

代价：3D/重度性能不如原生。本游戏是 2D 轻量玩法，WebView 足够。

## 3. 系统组成

```
[手机 APP] Android WebView 壳（Java，无 AndroidX 依赖）
  ├─ TQBridge               JS ↔ Java 桥（getState/checkUpdate/downloadUpdate/restartApp）
  ├─ OtaManager             调 /api/version，下载 zip，sha256 校验，解压，原子切换，失败回退
  ├─ BundleWebViewClient    拦截 https://app.local/*，从「生效内容目录」读文件
  └─ 内容目录优先级：files/web/<已下载版本>/  ＞  assets/web/（APK 内置）
        │
        │  HTTPS
        ▼
[服务器 <YOUR_DOMAIN>]（腾讯云轻量，OpenCloudOS 9.4，root 免密 SSH）
  nginx（现有 Docker 容器，80/443，证书至 2027-04-29）
      location /treasure/  ──proxy──▶ 172.17.0.1:3001（仅 docker0 网关可达，不对外暴露）
  treasure-server（Python 3.11 stdlib，systemd，/data/treasure）
      /api/health /api/version /api/login /api/me /api/stats
      /updates/*.zip  /apk/*.apk
      data/versions.json  data/users.json  data/updates/  data/apk/  data/stats.jsonl
        ▲
        │ SFTP 上传 zip + 更新 versions.json（不开放 HTTP 发布接口）
[本地开发机] Windows + Node24 + Python + JDK21 + Android SDK cmdline
  web/（H5 游戏源码） → build_web.ps1 → dist/treasure-content-<v>.zip
  android/（壳工程）   → build_apk.ps1 → dist/treasure-quest-<ver>.apk
```

## 4. 目录与归属（并行开发边界）

| 目录 | 负责人 | 内容 |
|---|---|---|
| `web/js/core/` | 游戏核心 | util / audio / input / graphics / level_data / game：引擎与玩法 |
| `web/index.html`、`web/css/`、`web/js/shell/` | 游戏外壳 | 页面骨架、登录/菜单/设置/更新 UI、存档、网络、启动流程 |
| `android/` | Android 壳 | WebView 壳、OTA 管理器、JS 桥、图标引用、Gradle 文件 |
| `server/` | backend | Python 服务、数据文件、部署脚本、后端测试 |
| `docs/`、`tools/`、`tests/`、`dist/` | 维护者 | 契约、构建/部署/发布脚本、集成测试、集成验证 |
| `.tooling/` | 维护者 | 本机 Android SDK 安装脚本等环境工具 |

**硬性规则**

1. 只能修改自己 write scope 内的文件；需要改契约/别人的文件，先发消息给 维护者。
2. 不执行 `git add/commit/push`；不修改 `.git/`；不碰 `README.md`（根仓库的）。
3. 服务器上已有的其它站点/容器/面板一律不动，游戏后端为独立新增服务，部署由维护者执行。
4. 所有路径用相对项目根目录；Windows 环境，命令用 PowerShell / Node / Python。

## 5. 版本模型

| 名称 | 位置 | 说明 |
|---|---|---|
| shellVersionCode / shellVersionName | `AndroidManifest.xml` | APK 版本；改原生代码才递增 |
| contentVersion | `web/version.json`、`bundle.json`、服务端 `versions.json` | 内容包版本，整数，**严格递增** |
| bundledContentVersion | APK 内置内容版本，构建时由脚本写入 `AndroidManifest` 或 Java 常量 | 用于和已下载版本比较 |
| save schema | localStorage `tq.save.v1` | 存档，不随内容版本升级重置 |

**生效规则**：`state.json` 指向的已下载内容版本 > 内置版本，且目录完整 → 用已下载内容；否则用 APK 内置内容。
**兼容规则**：内容包里的 `minShellVersion` > 当前 APK 的 shellVersionCode 时，APP 不提示内容更新（要求先升级 APK）。
**回退规则**：已下载内容加载失败/校验失败 → 自动回退上一版本或内置内容，删除损坏目录。

## 6. 运行时序

**冷启动**
1. Activity 创建 WebView + TQBridge，解析生效内容目录（见第 3 节）。
2. `loadUrl("https://app.local/index.html")`，`shouldInterceptRequest` 从生效目录读文件。
3. JS `boot.js`：读取 `TQNative.getState()` → 初始化 `TQ.Net` / `TQ.Save` / `TQ.UI` → 显示登录（有未过期 token 则直接进菜单）。
4. 启动 3 秒后静默调用一次 `checkUpdate`；有新版只在设置页显示红点/角标，不打断游戏。

**内容更新**
5. 设置页「检查更新」→ `TQNative.checkUpdate()` → `GET {apiBase}/api/version`。
6. 有新版 → 原生回调 `TQNativeEvent("ota_available", {...})` → UI 展示说明/大小 → 用户点「下载更新」。
7. 原生下载 → 回调进度事件 → sha256 校验 → 解压到 `files/web/<newVersion>/` → 写 `ota_state.json` → `ota_done`。
8. UI 显示「重启生效」→ `TQNative.restartApp()` → WebView reload，新内容生效（无需重装 APK）。
9. 若新内容有 JS 致命错误：WebView `onReceivedError` / 启动探活失败 → 自动回退上一版本。

## 7. 安全与运维约束

- 全部走现有 HTTPS 证书（`<YOUR_DOMAIN>`，Let's Encrypt，有效期至 2027-04-29）；APP 禁止明文流量。
- 内容包必须：sha256 校验、zip-slip 路径穿越防护、解压大小上限 20MB、文件白名单校验（至少校验 index.html 存在）。
- 后端只监听 `172.17.0.1:3001`（docker0 网关），公网只能经 nginx `/treasure/` 访问；不开放发布/上传接口。
- 登录 v1 仅测试账号 `admin / 123456`；密码加盐哈希存储；登录限流 10 次/分钟/IP；日志不记录密码。
- 服务器数据放 `/data/treasure`，专用系统用户 `treasure` 运行；改动现有 nginx 配置前必须备份并 `nginx -t`。
- 不引入新的公网端口；不改动服务器上已有的其它服务/容器。

## 8. 环境

| 环境 | 说明 |
|---|---|
| 开发机 | Windows，Node 24，Python 3.13（含 bundled Python），JDK 21，Android SDK cmdline（platform-tools / platforms;android-35 / build-tools;35.0.0） |
| 本地联调 | `python tools/dev_server.py`：静态站点 `http://127.0.0.1:5173` + 本地 API `http://127.0.0.1:3001` |
| 构建 | `python tools/build_web.py`（内容 zip）、`python tools/build_apk.py`（aapt2/d8/apksigner 手动链，不需 Android Studio） |
| 服务器 | `<YOUR_SERVER_IP>`（示例环境 OpenCloudOS 9.4），Python 3.11，nginx 入口 |

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 脚手架 + 契约 + SDK | 文档齐备、SDK 可用 |
| M2 | 四线并行开发 | 各自模块可独立运行/测试 |
| M3 | 本地集成 | 浏览器完整通关 4 关；Node/后端测试全绿 |
| M4 | APK 构建 | `apksigner verify` 通过，用户手机侧载成功 |
| M5 | 服务器部署 + 发布 v1 | `https://<YOUR_DOMAIN>/treasure/api/health` 200 |
| M6 | OTA 验证 | 发布 content v2 → 手机 APP 内更新生效 |
| M7 | 文档收尾 | README/RUNBOOK/TEST 报告齐备 |
