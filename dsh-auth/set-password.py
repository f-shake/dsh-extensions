# -*- coding: utf-8 -*-
"""设置/修改登录密码：写 PBKDF2-SHA256 哈希到 .env，然后重启 dsh-auth 服务。

用法：
    .venv\\Scripts\\python.exe set-password.py            # 交互输入两次
    .venv\\Scripts\\python.exe set-password.py 新密码      # 命令行给（会留在命令历史里，不推荐）

改密码的副作用：所有已发放的会话 cookie 立即失效（cookie 的 HMAC 掺了密码哈希，
这是有意设计的吊销机制）。TOTP 密钥不变，Authenticator 里的条目不用重建。
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
ENV_FILE = BASE / ".env"
ROUNDS = 310_000


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def load_env() -> dict[str, str]:
    data: dict[str, str] = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                data[k.strip()] = v.strip()
    return data


def save_env(data: dict[str, str]) -> None:
    tmp = ENV_FILE.with_suffix(".env.tmp")
    tmp.write_text("\n".join(f"{k}={v}" for k, v in data.items()) + "\n", encoding="utf-8")
    os.replace(tmp, ENV_FILE)


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--stdin":
        pwd = sys.stdin.readline().strip()
    elif len(sys.argv) > 1:
        pwd = sys.argv[1]
    else:
        pwd = getpass.getpass("新密码: ")
        again = getpass.getpass("再输一次: ")
        if pwd != again:
            print("[x] 两次输入不一致")
            return 2

    if len(pwd) < 12:
        print(f"[!] 密码只有 {len(pwd)} 位，建议至少 16 位。继续。")

    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt, ROUNDS)

    env = load_env()
    if ENV_FILE.exists():
        bak = ENV_FILE.with_suffix(f".env.bak-{datetime.now():%Y%m%d-%H%M%S}")
        bak.write_text(ENV_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    env["DSH_PWD_HASH"] = f"pbkdf2_sha256${ROUNDS}${b64e(salt)}${b64e(digest)}"
    save_env(env)
    print("[ok] 密码哈希已写入 .env（旧会话全部失效）")

    # 进程必须重启才会加载新的 .env；两种托管方式都要能处理：
    #   · NSSM 服务 dsh-auth（有管理员权限时的那种）
    #   · 计划任务 dsh-auth（当前实际用法，无管理员权限）
    restarted = False
    if subprocess.run(["sc.exe", "query", "dsh-auth"], capture_output=True, check=False).returncode == 0:
        subprocess.run(["sc.exe", "stop", "dsh-auth"], capture_output=True, check=False)
        subprocess.run(["sc.exe", "start", "dsh-auth"], capture_output=True, check=False)
        restarted = True

    if not restarted:
        # 杀掉占用 8099 的进程，再让计划任务把它拉起来
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=False
        ).stdout
        pids = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(":8099"):
                pids.add(parts[4])
        for pid in pids:
            subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, check=False)
            print(f"[ok] 已结束旧进程 pid={pid}")
        time.sleep(2)
        subprocess.run(
            ["schtasks", "/run", "/tn", "dsh-auth"], capture_output=True, check=False
        )
        time.sleep(4)
        restarted = True

    if restarted:
        print("[ok] 已重启 dsh-auth（等待 3 秒后自检）")
        time.sleep(3)
        try:
            import urllib.request

            with urllib.request.urlopen("http://127.0.0.1:8099/healthz", timeout=5) as resp:
                print(f"[ok] healthz = {resp.status}")
        except Exception as exc:  # noqa: BLE001
            print(f"[!] healthz 失败，请手动检查：{exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
