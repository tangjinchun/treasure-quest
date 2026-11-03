# 服务器部署

> 本文档用占位符表示你自己环境的信息：`<YOUR_SERVER_IP>`、`<USER>`、`<YOUR_DOMAIN>`、`<repo>`。作者演示服为 `https://zzysjqr.cn/treasure/`，可能随时关闭。

## 1. 前提

- 一台 Linux 服务器（示例环境：OpenCloudOS 9.4 / RHEL 系，2C 3.6G）
- Python 3.11（`/usr/bin/python3`）
- 已安装 nginx（宿主机或 Docker 容器均可），已为 `<YOUR_DOMAIN>` 配置 HTTPS 证书
- root 或可 sudo 的 SSH 账号；本地配置好 SSH 公钥

## 2. 部署架构

```
nginx（80/443，现有入口）
  └── location /treasure/  proxy_pass → 172.17.0.1:3001（Docker 网关）
        Python 后端 systemd 服务（仅监听内网地址，不暴露公网端口）
        /data/treasure/
          server.py add_user.py treasure.env
          data/versions.json  data/updates/*.zip  data/apk/*.apk
```

- 后端服务以专用系统用户 `treasure` 运行，数据目录 `/data/treasure/data`
- nginx 配置只需要在 443 server 块内增加一行 include，不影响现有其它站点
- 密钥（HMAC secret / 管理员 token）由安装脚本随机生成到 `/data/treasure/treasure.env`（600 权限）

## 3. 首次部署

1. 把 `server/`（server.py、add_user.py、deploy/）上传到服务器 `/data/treasure/_deploy`
2. 以 root 执行：

```bash
bash /data/treasure/_deploy/deploy/install.sh
```

安装脚本（幂等）会：

- 创建系统用户 `treasure`、目录 `/data/treasure/{data/{updates,apk},deploy}`
- 复制代码、初始化 `versions.json`（content=null）与测试账号 `admin/123456`
- 生成/保留 `treasure.env`（随机 secret 与 admin token）
- 安装并启动 systemd 服务 `treasure-server`
- 复制 nginx 片段 `treasure-locations.inc`，在 443 server 块内幂等插入 include（改前备份、`nginx -t` 通过才 reload）
- 自检：`systemctl is-active`、内网 health、`nginx -t`

> 如果你的 nginx 容器名不是 `nginx`：`TREASURE_NGINX_CONTAINER=<name> bash install.sh`。
> 如果你的域名不是默认值，请修改 `install.sh` 中的 `TREASURE_PUBLIC_BASE` 或服务器上的 `treasure.env`。

详细字段与路径见 `server/deploy/install.sh` 注释。

## 4. 发布内容包与 APK

在本地仓库执行（需要 `paramiko`：`python -m pip install paramiko`）：

```bash
# 构建内容包（递增 contentVersion）
python tools/build_web.py --version 1 --notes "首个版本"

# 发布到服务器（上传 zip、原子更新 versions.json、公网校验）
# 先设置 SSH 连接环境变量：
export TQ_SSH_HOST=<YOUR_SERVER_IP>
export TQ_SSH_USER=root
export TQ_PUBLIC_BASE=https://<YOUR_DOMAIN>/treasure
python tools/publish_content.py --version 1 --notes "首个版本" \
  --apk dist/treasure-quest-0.1.0-debug.apk --apk-notes "首个测试包"
```

Windows PowerShell 用 `$env:TQ_SSH_HOST="..."` 形式设置环境变量。

## 5. 验证

```bash
# 服务器本机
curl -s http://172.17.0.1:3001/api/health
systemctl status treasure-server --no-pager

# 公网
curl -s https://<YOUR_DOMAIN>/treasure/api/health
curl -s https://<YOUR_DOMAIN>/treasure/api/version
curl -sI https://<YOUR_DOMAIN>/treasure/updates/treasure-content-1.zip
```

## 6. 回滚

| 场景 | 操作 |
|---|---|
| 后端代码回滚 | 重新上传上一版 `server/` 并 `systemctl restart treasure-server` |
| nginx 配置回滚 | install.sh 改动前会备份 default.conf；复制回备份后 `nginx -t && nginx -s reload` |
| 内容包回滚 | 客户端只升不降；如需回滚内容需发布新版本号修复（旧 zip 保留在 updates/） |
| 停用游戏服务 | `systemctl disable --now treasure-server`（只影响 `/treasure/`） |

## 7. 安全建议

- 不要将后端端口暴露到公网，只经 nginx 反代
- `treasure.env` 内的 secret/token 不要泄漏、不要提交仓库
- 测试账号 `admin/123456` 只用于内测；对外前替换为用户体系
- 发布/部署脚本需要 SSH 权限，只在可信环境运行；不要把私钥提交到仓库
