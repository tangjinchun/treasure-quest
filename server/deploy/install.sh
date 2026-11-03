#!/usr/bin/env bash
# =============================================================================
# 《寻宝奇兵》后端服务器安装脚本（在服务器 root 下执行，幂等、无交互）
#
# 部署方式（维护者执行）：
#   把 server.py、add_user.py、deploy/ 打成 tar 上传到 /data/treasure/_deploy 解压，
#   然后：
#       bash /data/treasure/_deploy/deploy/install.sh
#
# 脚本做的事：
#   1. 检查环境（root / python3 / 源文件 / nginx 容器）
#   2. 创建系统用户 treasure；建 /data/treasure/{data/{updates,apk},deploy}
#   3. 复制 _deploy/server.py、_deploy/add_user.py 到 /data/treasure/
#   4. 首次初始化数据：versions.json（content=null）、users.json（admin/123456）
#   5. 生成/保留 /data/treasure/treasure.env（含随机 secret 与 admin token，权限 600）
#   6. 安装 systemd unit 并 enable/restart，等待本地 health 检查通过
#   7. 复制 nginx include 到 /data/nginx/conf.d/，在 443 server 块内幂等插入 include 行，
#      改前备份、nginx -t、成功才 reload
#   8. 打印自检结果（systemctl is-active / curl health / nginx -t），失败退出非 0
#
# 注意：不修改服务器上的其它现有服务/容器配置，只新增本项目所需内容。
# =============================================================================

set -euo pipefail
umask 022

INSTALL_DIR="/data/treasure"
DATA_DIR="$INSTALL_DIR/data"
ENV_FILE="$INSTALL_DIR/treasure.env"
SERVICE_NAME="treasure-server"
SERVICE_USER="treasure"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
HEALTH_URL="http://172.17.0.1:3001/api/health"

NGINX_CONF_DIR="/data/nginx/conf.d"
NGINX_MAIN_CONF="$NGINX_CONF_DIR/default.conf"
NGINX_INCLUDE_HOST="$NGINX_CONF_DIR/treasure-locations.inc"
NGINX_INCLUDE_CONTAINER="/etc/nginx/conf.d/treasure-locations.inc"
NGINX_CONTAINER="${TREASURE_NGINX_CONTAINER:-nginx}"
MARKER="# TREASURE-GAME-INCLUDE"

PYTHON_BIN="${TREASURE_PYTHON_BIN:-/usr/bin/python3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # _deploy/（含 server.py、add_user.py）

log() { printf '[treasure-install] %s\n' "$*"; }
die() { printf '[treasure-install][ERROR] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 环境检查
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "必须以 root 身份执行本脚本"
[ -f "$SRC_DIR/server.py" ] || die "找不到 $SRC_DIR/server.py（请确认 tar 已解压到 /data/treasure/_deploy）"
[ -f "$SRC_DIR/add_user.py" ] || die "找不到 $SRC_DIR/add_user.py"
[ -f "$SRC_DIR/deploy/treasure-server.service" ] || die "找不到 $SRC_DIR/deploy/treasure-server.service"
[ -f "$SRC_DIR/deploy/treasure-nginx-locations.inc" ] || die "找不到 $SRC_DIR/deploy/treasure-nginx-locations.inc"
[ -f "$NGINX_MAIN_CONF" ] || die "找不到 nginx 配置 $NGINX_MAIN_CONF（宿主机应挂载到容器 /etc/nginx/conf.d/）"
[ -x "$PYTHON_BIN" ] || die "找不到 python3：$PYTHON_BIN"
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NGINX_CONTAINER" \
  || die "nginx 容器（$NGINX_CONTAINER）未运行；可用 TREASURE_NGINX_CONTAINER=xxx 指定容器名"
command -v curl >/dev/null 2>&1 || die "找不到 curl 命令"

log "python3：$($PYTHON_BIN -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')（$PYTHON_BIN）"

# ---------------------------------------------------------------------------
# 2. 系统用户与目录
# ---------------------------------------------------------------------------
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "系统用户 $SERVICE_USER 已存在，跳过创建"
else
    useradd --system --home-dir "$INSTALL_DIR" --shell /sbin/nologin \
        --comment "Treasure Quest backend" "$SERVICE_USER"
    log "已创建系统用户 $SERVICE_USER"
fi

install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"
install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/updates"
install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/apk"
install -d -m 0755 "$INSTALL_DIR/deploy"
log "目录就绪：$DATA_DIR/{updates,apk}"

# ---------------------------------------------------------------------------
# 3. 复制服务代码（永远覆盖为本次上传版本；只读业务数据）
# ---------------------------------------------------------------------------
install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SRC_DIR/server.py" "$INSTALL_DIR/server.py"
install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SRC_DIR/add_user.py" "$INSTALL_DIR/add_user.py"
install -m 0644 "$SRC_DIR/deploy/treasure-server.service" "$INSTALL_DIR/deploy/treasure-server.service"
install -m 0644 "$SRC_DIR/deploy/treasure-nginx-locations.inc" "$INSTALL_DIR/deploy/treasure-nginx-locations.inc"
install -m 0644 "$SCRIPT_DIR/install.sh" "$INSTALL_DIR/deploy/install.sh"
log "已复制 server.py / add_user.py / deploy 资产到 $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 4. 首次初始化数据（已存在则原样保留，绝不覆盖线上数据）
# ---------------------------------------------------------------------------
if [ -f "$DATA_DIR/versions.json" ]; then
    log "保留已有 versions.json（不覆盖）"
elif [ -f "$SRC_DIR/data/versions.json" ]; then
    install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_USER" \
        "$SRC_DIR/data/versions.json" "$DATA_DIR/versions.json"
    log "已复制 versions.json 样例（content=null）"
else
    cat > "$DATA_DIR/versions.json" <<'JSON'
{
  "channel": "test",
  "content": null,
  "apk": null
}
JSON
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/versions.json"
    chmod 0644 "$DATA_DIR/versions.json"
    log "已生成 versions.json 样例（content=null）"
fi

if [ -f "$DATA_DIR/users.json" ]; then
    log "保留已有 users.json（不覆盖）"
else
    log "初始化测试账号 admin/123456（displayName=测试玩家, role=admin）"
    ( cd "$INSTALL_DIR" && "$PYTHON_BIN" add_user.py admin 123456 \
        --display-name "测试玩家" --role admin --data-dir "$DATA_DIR" )
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/users.json"
    chmod 0600 "$DATA_DIR/users.json"
fi

# ---------------------------------------------------------------------------
# 5. 环境变量文件（已存在保留原值；不存在才生成随机密钥）
# ---------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
    log "保留已有 $ENV_FILE（不重新生成密钥）"
    # 补齐缺失的非密钥配置项（不覆盖任何已存在的键）
    for pair in \
        "TREASURE_BIND=172.17.0.1" \
        "TREASURE_PORT=3001" \
        "TREASURE_DATA_DIR=$DATA_DIR" \
        "TREASURE_PUBLIC_BASE=https://zzysjqr.cn/treasure" \
        "TREASURE_CHANNEL=test"
    do
        key="${pair%%=*}"
        if ! grep -q "^[[:space:]]*${key}=" "$ENV_FILE"; then
            printf '%s\n' "$pair" >> "$ENV_FILE"
            log "  补写缺失配置：$pair"
        fi
    done
else
    TREASURE_SECRET="$("$PYTHON_BIN" -c 'import secrets; print(secrets.token_hex(32))')"
    TREASURE_ADMIN_TOKEN="$("$PYTHON_BIN" -c 'import secrets; print(secrets.token_hex(16))')"
    umask 077
    cat > "$ENV_FILE" <<EOF
# 由 server/deploy/install.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S %z')
# 权限 600、属主 treasure；包含密钥，勿提交 git、勿外传。
TREASURE_BIND=172.17.0.1
TREASURE_PORT=3001
TREASURE_DATA_DIR=$DATA_DIR
TREASURE_PUBLIC_BASE=https://zzysjqr.cn/treasure
TREASURE_CHANNEL=test
TREASURE_SECRET=$TREASURE_SECRET
TREASURE_ADMIN_TOKEN=$TREASURE_ADMIN_TOKEN
EOF
    umask 022
    log "已生成 $ENV_FILE（随机 TREASURE_SECRET / TREASURE_ADMIN_TOKEN，请备份）"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"

# data 目录整体归 treasure，保证服务可写 stats.jsonl
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ---------------------------------------------------------------------------
# 6. systemd unit：安装 / enable / restart
# ---------------------------------------------------------------------------
install -m 0644 "$SRC_DIR/deploy/treasure-server.service" "$UNIT_FILE"
log "已安装 systemd unit：$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || die "systemctl enable $SERVICE_NAME 失败"
systemctl restart "$SERVICE_NAME" || die "systemctl restart $SERVICE_NAME 失败"
log "已启动 $SERVICE_NAME，等待健康检查……"

wait_health() {
    local attempt
    for attempt in $(seq 1 30); do
        if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
            log "健康检查通过：$HEALTH_URL"
            curl -fsS --max-time 3 "$HEALTH_URL" || true
            printf '\n'
            return 0
        fi
        sleep 1
    done
    printf '[treasure-install][ERROR] 健康检查失败：%s\n' "$HEALTH_URL" >&2
    systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null || true
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager 2>/dev/null || true
    exit 1
}
wait_health

# ---------------------------------------------------------------------------
# 7. nginx：复制 include 片段 + 在 443 server 块内幂等注入 include 行
# ---------------------------------------------------------------------------
install -m 0644 "$SRC_DIR/deploy/treasure-nginx-locations.inc" "$NGINX_INCLUDE_HOST"
log "已复制 nginx include：$NGINX_INCLUDE_HOST"

BACKUP_FILE=""
if grep -q "$MARKER" "$NGINX_MAIN_CONF"; then
    log "nginx 已包含标记 $MARKER，跳过注入（幂等）"
else
    BACKUP_FILE="/root/default.conf.bak-treasure-$(date +%Y%m%d-%H%M%S)"
    cp -a "$NGINX_MAIN_CONF" "$BACKUP_FILE"
    log "已备份 nginx 配置：$BACKUP_FILE"

    "$PYTHON_BIN" - "$NGINX_MAIN_CONF" "$NGINX_INCLUDE_CONTAINER" "$MARKER" <<'PYEOF'
"""在 nginx default.conf 的 443 server 块结束 } 之前插入 include 行。

优先选择 server_name 含 zzysjqr.cn 的 443 server 块；
插入内容（4 空格缩进，便于人工审阅）：
    # TREASURE-GAME-INCLUDE
    include /etc/nginx/conf.d/treasure-locations.inc;
"""
import re
import sys

path, include_path, marker = sys.argv[1], sys.argv[2], sys.argv[3]

with open(path, "r", encoding="utf-8", errors="surrogateescape") as fh:
    lines = fh.readlines()

if any(marker in line for line in lines):
    print("TREASURE_SKIP: marker already present")
    sys.exit(0)

blocks = []          # [{start, end, listen443, preferred}]
current = None       # 正在扫描的 server 块
pending_server = False
depth = 0

for index, line in enumerate(lines):
    code = line.split("#", 1)[0]
    stripped = code.strip()

    if current is None:
        if stripped == "server":
            # 兼容「server」与「{」分两行的 nginx 风格
            pending_server = True
        elif pending_server and "{" in code:
            current = {
                "start": index,
                "base_depth": depth,
                "listen443": False,
                "preferred": False,
                "end": None,
            }
            pending_server = False
        elif re.match(r"^server\s*\{", stripped):
            current = {
                "start": index,
                "base_depth": depth,
                "listen443": False,
                "preferred": False,
                "end": None,
            }
            pending_server = False
        elif pending_server and stripped:
            pending_server = False

    if current is not None:
        if stripped.startswith("listen") and "443" in stripped:
            current["listen443"] = True
        if stripped.startswith("server_name") and "zzysjqr.cn" in code:
            current["preferred"] = True

    delta = code.count("{") - code.count("}")
    depth += delta

    if current is not None and depth == current["base_depth"]:
        current["end"] = index
        blocks.append(current)
        current = None

candidates = [b for b in blocks if b["listen443"] and b["end"] is not None]
if not candidates:
    sys.exit("找不到 listen 443 的 server 块，无法注入 nginx include")

preferred = [b for b in candidates if b["preferred"]]
block = preferred[0] if preferred else candidates[0]

# 缩进跟随 server 块结束行的缩进（location 缩进 = server 缩进 + 4 空格）
if block["end"] == block["start"]:  # 单行 server { ... } 的极端情况：插到该行之后
    insert_at = block["end"] + 1
    base_indent = re.match(r"[ \t]*", lines[block["start"]]).group(0)
else:
    insert_at = block["end"]
    base_indent = re.match(r"[ \t]*", lines[block["end"]]).group(0)
indent = base_indent + "    "

lines.insert(insert_at, indent + marker + "\n")
lines.insert(insert_at + 1, indent + "include " + include_path + ";\n")

with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
    fh.writelines(lines)

print(
    "TREASURE_INJECTED: 443 server 块（第 %d 行开始）注入 include，插入位置第 %d 行"
    % (block["start"] + 1, insert_at + 1)
)
PYEOF
    log "已注入 include：$NGINX_INCLUDE_CONTAINER"
fi

if ! docker exec "$NGINX_CONTAINER" nginx -t; then
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        cp -a "$BACKUP_FILE" "$NGINX_MAIN_CONF"
        log "nginx -t 失败，已从 $BACKUP_FILE 回滚 default.conf"
    fi
    die "nginx -t 校验失败，未执行 reload"
fi
docker exec "$NGINX_CONTAINER" nginx -s reload || die "nginx -s reload 失败"
log "nginx 已 reload"

# ---------------------------------------------------------------------------
# 8. 最终自检与输出
# ---------------------------------------------------------------------------
log "==== 部署自检 ===="

ACTIVE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
printf 'systemctl is-active %s: %s\n' "$SERVICE_NAME" "$ACTIVE"
[ "$ACTIVE" = "active" ] || die "服务未处于 active 状态，请查看 journalctl -u $SERVICE_NAME -n 50"

printf 'health: '
curl -fsS --max-time 5 "$HEALTH_URL" || die "curl $HEALTH_URL 失败"
printf '\n'

docker exec "$NGINX_CONTAINER" nginx -t || die "nginx -t 失败"

if curl -fsS --max-time 8 "https://zzysjqr.cn/treasure/api/health" >/dev/null 2>&1; then
    log "公网自检通过：https://zzysjqr.cn/treasure/api/health"
else
    log "提示：公网自检未通过（DNS/证书/nginx 尚未生效？），请人工验证 https://zzysjqr.cn/treasure/api/health"
fi

log "部署完成。"
log "  日志：journalctl -u $SERVICE_NAME -f"
log "  管理员 token：grep '^TREASURE_ADMIN_TOKEN=' $ENV_FILE"
log "  新增账号：cd $INSTALL_DIR && $PYTHON_BIN add_user.py <用户名> <密码> --role player"
exit 0
