# 构建与本地开发

## 1. 环境

| 组件 | 版本/路径 |
|---|---|
| Node.js | 24.x（仅用于 `node --check` 和 `node --test`） |
| Python | 3.13（conda，装 paramiko 用于部署脚本） |
| JDK | 21（`C:\Program Files\Java\jdk-21.0.11`） |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`，含 platform-tools、platforms;android-35、build-tools;35.0.0 |
| 部署依赖 | `python -m pip install paramiko` |

首次安装 Android SDK：`python tools/install_android_sdk.py`（从 Google 官方仓库下载，带断点续传/重试；国内网络不稳时会自动重试）。

## 2. 本地开发

```powershell
cd <repo>   # 进入本仓库根目录

# 终端 1：本地后端 API（默认 127.0.0.1:3001，CORS 已开）
python server\server.py

# 终端 2：游戏静态站点
python tools\dev_server.py
# 打开 http://127.0.0.1:5173/
# 想连本地 API：http://127.0.0.1:5173/?api=http://127.0.0.1:3001
```

浏览器调试要点：
- 游客试玩不需要后端；登录需要后端 + `users.json` 里存在测试账号。
- 内容版本、内置版本、检查更新在「设置」页。
- 浏览器模式无法真正应用 OTA，只演示接口返回。

## 3. 静态校验与测试

```powershell
# web 资源完整性 + JS 语法 + 脚本顺序 + 体积
python tools\validate_web.py

# 关卡/逻辑测试（游戏核心 提供）
node --test tests\game\

# 后端单元测试
python -m unittest discover -s server\tests -v
```

## 4. 构建内容包（OTA 用）

```powershell
python tools\build_web.py --version 1 --notes "首个版本：3 个关卡"
```

产出：
- `dist/treasure-content-1.zip`（zip 根含 bundle.json + index.html + 资源）
- `dist/treasure-content-1.sha256`
- `dist/manifest-1.json`
- 同时更新 `web/version.json` 的 contentVersion / builtAt / notes

规则：contentVersion 必须严格递增；`bundle.json.minShellVersion` 默认 1。

## 5. 构建 APK

```powershell
python tools\build_apk.py
```

内部步骤（不需要 Android Studio/Gradle）：
1. 生成图标（`tools/make_icons.py`）→ `android/app/src/main/res/mipmap-*/ic_launcher.png`
2. 复制 `web/` → `android/app/src/main/assets/web/`
3. 把 `web/version.json` 的 contentVersion 写入 `AppConfig.BUNDLED_CONTENT_VERSION`
4. `aapt2 compile` + `aapt2 link` → 基础 APK（含 assets）
5. `javac --release 8` 编译 Java → `d8` 生成 classes.dex
6. 组装 APK → `zipalign -f 4` → `apksigner sign`（debug keystore `.tooling/debug.keystore`）
7. 输出 `dist/treasure-quest-<versionName>-debug.apk` + `dist/apk-<versionName>.json`

版本来源：`android/app/src/main/AndroidManifest.xml` 的 `android:versionCode/versionName`。改原生壳才需要递增；纯内容更新只递增 contentVersion。

如需打一个「内置指定内容版本」的 APK（例如 OTA 升级测试：内置 v1、服务器已发布 v2）：

```powershell
# zip 根即 web 根
Expand-Archive dist\treasure-content-1.zip -DestinationPath .tooling\web-v1
$env:TQ_WEB_DIR = ".tooling\web-v1"
python tools\build_apk.py
Remove-Item Env:\TQ_WEB_DIR
```

## 6. 构建产物一览

| 产物 | 用途 |
|---|---|
| `dist/treasure-content-<n>.zip` | OTA 内容包（发布到服务器） |
| `dist/manifest-<n>.json` | 发布脚本读取，用于写服务器 versions.json |
| `dist/treasure-quest-<ver>-debug.apk` | 手机侧载安装 |
| `dist/apk-<ver>.json` | APK 元信息（版本/哈希/大小），发布脚本使用 |
| `dist/icon-512.png` | 图标预览 |

## 7. 常见构建问题

| 现象 | 处理 |
|---|---|
| `missing Android SDK component` | 重跑 `python tools/install_android_sdk.py` |
| `BUNDLED_CONTENT_VERSION constant not found` | 检查 `AppConfig.java` 是否有该常量 |
| javac 报 android.jar 版本错误 | 确认用 JDK 21 的 javac（脚本会自动找） |
| assets/web 未更新 | 重新运行 build_apk.py（会先删除旧 assets/web） |
| 安装 APK 报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 旧的同包名不同签名：先卸载旧 APP |
