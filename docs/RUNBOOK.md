# 运维手册（RUNBOOK）

## 1. 服务速查

| 项目 | 值 |
|---|---|
| 公网入口 | `https://<YOUR_DOMAIN>/treasure/` |
| 后端进程 | systemd `treasure-server`，用户 `treasure`，监听 `172.17.0.1:3001`（仅内网） |
| 代码/数据 | `/data/treasure/`（`server.py`、`treasure.env`、`data/`） |
| 日志 | `journalctl -u treasure-server`；业务事件 `/data/treasure/data/stats.jsonl` |
| 管理员统计 | `GET https://<YOUR_DOMAIN>/treasure/api/stats`，Header `X-Admin-Token: <treasure.env 中的值>` |

## 2. 常用命令

```bash
# 状态/重启/日志
systemctl status treasure-server --no-pager
systemctl restart treasure-server
journalctl -u treasure-server -n 100 --no-pager

# 健康检查
curl -s http://172.17.0.1:3001/api/health
curl -s https://<YOUR_DOMAIN>/treasure/api/health

# 状态汇总（health + 版本清单 + 下载/登录统计）
python tools/server_status.py --base https://<YOUR_DOMAIN>/treasure --admin-token <token>

# nginx 校验与重载（容器部署示例）
docker exec nginx nginx -t && docker exec nginx nginx -s reload

# 当前发布版本
python3 -c "import json;print(json.load(open('/data/treasure/data/versions.json'))['content'])"

# 下载/登录事件
tail -n 20 /data/treasure/data/stats.jsonl
```

## 3. 发布新内容（标准流程）

1. 修改 `web/`，把 `web/version.json` 的 `contentVersion` +1
2. `python tools/build_web.py --version N --notes "..."`（产出 zip + manifest）
3. 本地自测：`python tools/validate_web.py`、`node --test tests/game/`
4. `python tools/publish_content.py --version N --notes "..."`
5. 验证公网 `/api/version`，手机 APP 内检查更新
6. 核对 `stats.jsonl` 中对应下载记录

## 4. 发布/更新壳（APK）

```bash
python tools/build_apk.py
python tools/publish_content.py --version N --apk dist/treasure-quest-0.1.0-debug.apk --apk-notes "..."
```

- APK 更新不是自动的：用户需重新下载并覆盖安装（同签名保留数据）
- 正式发布前必须改用 release keystore，并备份签名文件（丢失后无法更新应用）
- 当前测试版为 debug 签名，仅限内测分发

## 5. 故障排查

| 现象 | 排查 |
|---|---|
| `/treasure/api/health` 502 | 服务是否 active、是否监听 3001、`curl http://172.17.0.1:3001/api/health` |
| 502 且服务正常 | nginx 容器能否访问 `172.17.0.1:3001`；include 是否生效；`nginx -t` |
| 404 默认页 | include 注入位置错误或未 reload |
| 手机检查更新报网络错误 | 手机能否打开 `https://<YOUR_DOMAIN>/treasure/api/health`；证书是否过期 |
| 下载校验失败 | 服务器 zip 与 versions.json 的 sha256 不一致，重新 publish |
| APP 更新后白屏 | 新内容包 JS 错误；客户端会自动回退上一版本；发布修复版 |
| 磁盘空间不足 | 清理 `/data/treasure/data/updates` 的旧 zip（保留最近 2–3 个） |

## 6. 备份

```bash
tar czf /root/treasure-backup-$(date +%F).tar.gz -C /data treasure
cp /etc/nginx/.../default.conf /root/default.conf.bak-$(date +%F)   # 按你的 nginx 路径调整
```

## 7. 安全

- `treasure.env` 中 `TREASURE_SECRET` / `TREASURE_ADMIN_TOKEN` 权限 600，禁止外传
- 测试账号只用于内测；上线前替换用户体系
- 不开放后端端口到公网；不把私钥/密码提交到仓库
