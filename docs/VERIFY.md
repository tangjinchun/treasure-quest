# 验证记录（Evidence Log）

> 记录 v0.1.0 的实际验证证据，便于复核。命令均可在仓库根目录复跑。

## 1. 自动化测试

| 测试 | 命令 | 结果 |
|---|---|---|
| 游戏逻辑/地图 | `node --test tests/game/` | **37/37 通过**（含第 4 关地图校验、锁门门槛、BFS 可达性、无头渲染玩法） |
| 后端 API | `python -m unittest discover -s server/tests -v` | **37/37 通过**（health/version/login/me/stats/静态下载/CORS/限流/路径穿越） |
| Web 静态校验 | `python tools/validate_web.py` | VALIDATE_WEB_OK（10 JS ≈ 256KB，无外链、脚本顺序正确） |
| 浏览器 UI 自动化 | Edge CDP（登录/游客/第 1 关/暂停/设置） | 14/14 通过，控制台/页面零错误 |
| v2 内容验收 | Edge CDP（4 关卡片/旧存档迁移/第 4 关可玩/版本 v2） | 通过（第 4 关运行、迁移 `unlockedLevel=3`、设置显示 v2） |
| 内容包构建 | `python tools/build_web.py --version 2` | `dist/treasure-content-2.zip`，14 文件，sha256 `68132d7a…` |
| APK 构建 | `python tools/build_apk.py` | `dist/treasure-quest-0.1.0-debug.apk`，≈158KB，package `cn.zzysjqr.treasurequest`，v1/0.1.0，minSdk 26 / target 35，debug 签名，`apksigner verify` 通过 |
| APK 内容检查 | unzip | `assets/web`（13 文件）、`classes.dex`、`resources.arsc`、图标齐全 |
| OTA 客户端模拟 | `python tools/ota_client_sim.py --api-base https://zzysjqr.cn/treasure --current-version 0` | OTA_APPLIED content v1：下载、sha256、解压、bundle 校验通过 |
| OTA 客户端模拟（v1→v2） | `... --current-version 1` | OTA_APPLIED content v2：sha256 `68132d7a…` 校验通过 |

## 2. 发布产物

| 项 | 值 |
|---|---|
| 内容版本 | v2（`contentVersion=2`，`minShellVersion=1`） |
| 内容包 | `updates/treasure-content-2.zip`（sha256 `68132d7a…`，71,219 B） |
| APK | `apk/treasure-quest-0.1.0-debug.apk`（161,492 B，debug 签名） |
| 登录测试 | `POST /treasure/api/login` admin/123456 → 200 + token + displayName |
| 下载统计 | `/api/stats` 可看到内容包/APK 下载与登录事件 |

## 3. 真机验证（用户）

| 项 | 结果 |
|---|---|
| 手机 | Xiaomi 15 Pro，Android 16 |
| 下载并侧载 APK | ✅ 成功 |
| 首次启动 + 登录 admin | ✅ 成功 |
| 触屏游玩体验 | ✅ 用户反馈「体验很棒」 |
| APP 内检查更新 → 下载 → 重启生效（v1→v2） | ⏳ 待用户体验后确认 |

## 4. 说明

- 测试环境为作者自建服务器（详见 `docs/DEPLOY.md`；仓库中 IP 等已用占位符替换）。
- APK 为 debug 签名，仅用于个人测试分发。
