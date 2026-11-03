#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""创建/更新 users.json 账号（加盐 SHA-256，Python 3.11 标准库）。

users.json 结构（见 docs/API.md）：
    {"users": [
      {"username": "admin", "salt": "<随机hex>", "passwordSha256": "<sha256(salt+password)的hex>",
       "displayName": "测试玩家", "role": "admin"}
    ]}

用法：
    # 创建/更新测试账号（密码 123456 只出现在命令里，不写死在代码中）
    python server/add_user.py admin 123456 --display-name 测试玩家 --role admin

    # 服务器上（脚本已复制到 /data/treasure/）
    cd /data/treasure && python3 add_user.py admin '新密码' --display-name 玩家 --role admin

    # 交互输入密码（不落 shell 历史）
    python server/add_user.py admin --data-dir server/data

    # 从标准输入读密码（脚本化）
    echo '123456' | python server/add_user.py admin --password-stdin

密码不写入代码、不写入日志；users.json 只保存 salt 与 sha256(salt+password)。
"""

import argparse
import getpass
import json
import os
import re
import sys

# 保证从任意工作目录运行都能 import 同目录的 server.py（复用哈希/常量实现）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as tq_server  # noqa: E402  （同目录模块，Python 标准库项目无需打包）

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")


def default_data_dir():
    """数据目录优先级：--data-dir > TREASURE_DATA_DIR > 本文件同级 ./data。"""
    env = os.environ.get("TREASURE_DATA_DIR", "").strip()
    if env:
        return env
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def users_path(data_dir):
    return os.path.join(os.path.abspath(data_dir), "users.json")


def load_db(path):
    """读取 users.json；不存在返回空库，损坏则报错退出（避免覆盖丢账号）。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"users": []}
    except (OSError, ValueError) as exc:
        raise SystemExit("[error] 读取 %s 失败：%s" % (path, exc))
    if not isinstance(data, dict):
        raise SystemExit("[error] %s 顶层必须是 JSON 对象" % path)
    users = data.get("users")
    if not isinstance(users, list):
        users = []
    data["users"] = users
    return data


def save_db(path, db):
    """原子写入 users.json（先写 .tmp 再 os.replace），权限 600。"""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(db, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    try:
        os.replace(tmp_path, path)
    except OSError:
        os.unlink(tmp_path)
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def upsert_user(db, username, password, display_name=None, role=None):
    """新增或更新账号；返回 "created" / "updated"。"""
    salt = tq_server.new_salt()
    digest = tq_server.password_sha256(salt, password)
    for item in db["users"]:
        if isinstance(item, dict) and item.get("username") == username:
            item["salt"] = salt
            item["passwordSha256"] = digest
            if display_name:
                item["displayName"] = display_name
            if role:
                item["role"] = role
            item.setdefault("displayName", display_name or username)
            item.setdefault("role", role or "player")
            return "updated"
    db["users"].append(
        {
            "username": username,
            "salt": salt,
            "passwordSha256": digest,
            "displayName": display_name or username,
            "role": role or "player",
        }
    )
    return "created"


def read_password(args):
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
        if not password:
            raise SystemExit("[error] 标准输入没有读到密码")
        return password
    if args.password is not None:
        return args.password
    password = getpass.getpass("密码: ")
    confirm = getpass.getpass("再次输入密码: ")
    if password != confirm:
        raise SystemExit("[error] 两次输入的密码不一致")
    return password


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="创建/更新《寻宝奇兵》users.json 账号（盐 + SHA-256）"
    )
    parser.add_argument("username", help="用户名（字母数字开头，可含 _ . -，最长 32）")
    parser.add_argument("password", nargs="?", help="密码；省略则交互输入（或 --password-stdin）")
    parser.add_argument("--display-name", default=None, help="游戏内显示名，默认同用户名")
    parser.add_argument("--role", default=None, choices=("admin", "player"), help="角色，默认 player")
    parser.add_argument("--data-dir", default=default_data_dir(), help="数据目录（默认 server/data 或 $TREASURE_DATA_DIR）")
    parser.add_argument("--password-stdin", action="store_true", help="从标准输入读取密码")
    args = parser.parse_args(argv)

    username = str(args.username).strip()
    if not USERNAME_RE.fullmatch(username):
        raise SystemExit("[error] 用户名不合法：需字母/数字开头，仅含 A-Z a-z 0-9 _ . -，最长 32")
    password = read_password(args)
    if not password:
        raise SystemExit("[error] 密码不能为空")
    if len(password) > 128:
        raise SystemExit("[error] 密码过长（最多 128 字符）")

    path = users_path(args.data_dir)
    db = load_db(path)
    action = upsert_user(db, username, password, args.display_name, args.role)
    save_db(path, db)

    shown = args.display_name or username
    role = args.role or "player"
    if action == "updated":
        # 更新时 role/displayName 可能沿用旧值，回读确认最终值
        for item in db["users"]:
            if item.get("username") == username:
                shown = item.get("displayName") or username
                role = item.get("role") or "player"
                break
    print("[ok] 已%s账号 %s（displayName=%s, role=%s）-> %s" % (
        "创建" if action == "created" else "更新",
        username,
        shown,
        role,
        path,
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
