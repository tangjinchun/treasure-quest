# 更新记录

## v0.1.0 — 2026-11-03

首个可玩测试版。

### 游戏（H5 Canvas）
- 4 个关卡：迷雾森林、幽暗洞窟、失落神殿、云端秘殿（52×29，8 宝石 + 钥匙锁门）
- 玩家移动/瓦片碰撞/剑击/受伤无敌帧/3 心、3 种敌人 AI、尖刺机关、回血道具
- 粒子、屏幕震动、暗角、WebAudio 程序化音效、最佳用时与进度存档
- 触屏虚拟摇杆 + 攻击键；桌面 WASD/方向键 + J/空格
- 老存档跨内容版本迁移（第 4 关解锁）

### Android 壳
- WebView 加载内置或已下载内容包（`https://app.local` 本地拦截）
- 内容 OTA：版本检查、下载、sha256 校验、zip-slip 防护、原子切换、失败回退、更新后重启生效
- 白屏兜底、返回键/前后台生命周期、12s DOM 空页看门狗
- 158KB debug 签名 APK，minSdk 26 / targetSdk 35，横屏

### 后端与部署
- Python 3.11 标准库后端：版本清单（热读取）、登录 HMAC token、限流、静态下载、管理员统计
- systemd + nginx `/treasure/` 反代部署脚本（幂等、nginx 校验与备份）
- 内容发布脚本（SFTP 上传 + 原子更新版本清单）

### 测试与文档
- 37 个 Node 游戏逻辑测试、37 个 Python 后端接口测试、浏览器 UI 自动化
- **Android 15 模拟器端到端 OTA 实测通过**：真实 APK（内置 v1）连接真实服务器 → 发现 v2 → 下载 / sha256 校验 / 解压 → 重启生效（contentVersion=2、4 个关卡）
- 架构 / API / OTA / 游戏设计 / 安装 / 构建 / 部署 / 运维 / 测试计划文档
- GitHub Actions CI、GitHub Pages 在线试玩、MIT License
