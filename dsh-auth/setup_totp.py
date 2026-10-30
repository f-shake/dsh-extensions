# -*- coding: utf-8 -*-
"""生成（或读取）TOTP 密钥、写 .env、输出二维码 PNG 与 otpauth 链接。

用法：
    .venv\\Scripts\\python.exe setup_totp.py            # 首次：生成密钥 + 二维码
    .venv\\Scripts\\python.exe setup_totp.py --show     # 只显示现有 otpauth 链接

已存在的 DSH_TOTP_SECRET / DSH_COOKIE_SECRET 会原样保留，重复运行不会换密钥
（换密钥 = Authenticator 里旧条目全部失效，只在确实需要时手工删 .env 那两行）。
"""
from __future__ import annotations

import base64
import os
import secrets
import sys
from pathlib import Path

import pyotp
import qrcode

BASE = Path(__file__).resolve().parent
ENV_FILE = BASE / ".env"
PNG_FILE = BASE / "totp-qr.png"
ISSUER = "DSH"
ACCOUNT = "admin"


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
    order = [
        "DSH_TOTP_SECRET",
        "DSH_PWD_HASH",
        "DSH_COOKIE_SECRET",
        "DSH_PUBLIC_HOST",
        "DSH_TOKEN_FILE",
        "DSH_CRED_FILE",
        "DSH_SESSION_TTL",
    ]
    lines = ["# dsh-auth 配置 —— 由 setup_totp.py / set-password.py 维护，改完重启 dsh-auth 服务"]
    for key in order:
        if key in data:
            lines.append(f"{key}={data[key]}")
    for key in sorted(set(data) - set(order)):
        lines.append(f"{key}={data[key]}")
    tmp = ENV_FILE.with_suffix(".env.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, ENV_FILE)          # 原子替换：写一半失败不会留下 0 字节文件


def main() -> int:
    env = load_env()

    env.setdefault("DSH_COOKIE_SECRET", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("="))
    env.setdefault("DSH_PUBLIC_HOST", "dsn.example.com")
    env.setdefault("DSH_TOKEN_FILE", r"C:\dsh\aa.out.log")
    env.setdefault("DSH_CRED_FILE", str(Path.home() / ".dsh" / ".credentials.yaml"))
    env.setdefault("DSH_SESSION_TTL", str(7 * 24 * 3600))

    created = "DSH_TOTP_SECRET" not in env
    if created:
        env["DSH_TOTP_SECRET"] = pyotp.random_base32()

    save_env(env)

    uri = pyotp.TOTP(env["DSH_TOTP_SECRET"]).provisioning_uri(name=ACCOUNT, issuer_name=ISSUER)
    if "--show" not in sys.argv:
        qrcode.make(uri).save(PNG_FILE)
        print(f"[ok] 二维码已写入 {PNG_FILE}")

    print(f"[{'新生成' if created else '沿用已有'}] TOTP 密钥")
    print(f"otpauth : {uri}")
    print(f"secret  : {env['DSH_TOTP_SECRET']}")
    if not env.get("DSH_PWD_HASH"):
        print("[!] 还没有密码哈希，接着跑：.venv\\Scripts\\python.exe set-password.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
