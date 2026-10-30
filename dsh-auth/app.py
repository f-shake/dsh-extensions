# -*- coding: utf-8 -*-
"""
dsh-auth — DeepSeek Harness 的密码 + TOTP 双因子网关。

部署形态（与另一套已部署实例一致，仅登录方式改为 POST）：

    VPS nginx :443
      /_app_auth  -> 127.0.0.1:12313 (隧道) -> 本机 127.0.0.1:8099/check-cookie
      /_app_login -> 同上 /auth
      /login.html -> 同上 /login-page

设计要点：
  * 密码用 PBKDF2-SHA256（310k 轮）校验，比对走 hmac.compare_digest；
  * TOTP ±1 窗口，同一个 6 位码 120 秒内只接受一次（防重放）；
  * 会话 cookie 无状态：v1.<exp>.<HMAC(secret, pwd_hash|exp)>，
    服务重启不掉线，改密码即全部失效（等价于吊销）；
  * 认证通过后不「代种」DSH 的 cookie，而是 302 到 /?token=<token>，
    让浏览器带着正确的 Host 自己完成交换（DSH 的 cookie 绑定 authority）；
    取不到 token 时退化为离线签发 cookie（复用 dsh-cookie.mjs 的算法）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pyotp
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse

BASE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- 配置


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_env(BASE / ".env")

PWD_HASH = os.environ.get("DSH_PWD_HASH", "")
TOTP_SECRET = os.environ.get("DSH_TOTP_SECRET", "")
COOKIE_SECRET = os.environ.get("DSH_COOKIE_SECRET", "")
TOKEN_FILE = Path(os.environ.get("DSH_TOKEN_FILE", r"C:\dsh\aa.out.log"))
CRED_FILE = Path(os.environ.get("DSH_CRED_FILE", str(Path.home() / ".dsh" / ".credentials.yaml")))
PUBLIC_HOST = os.environ.get("DSH_PUBLIC_HOST", "dsn.example.com")
LOG_FILE = BASE / "totp-auth.log"
SESSION_TTL = int(os.environ.get("DSH_SESSION_TTL", str(7 * 24 * 3600)))
COOKIE_NAME = "dsh_auth"
PBKDF2_ROUNDS = 310_000

if not (PWD_HASH and TOTP_SECRET and COOKIE_SECRET):
    raise SystemExit("缺少 .env 配置：先跑 setup_totp.py 生成密钥，再跑 set-password.py 设密码")

APP_START = time.time()
_seen_codes: dict[str, float] = {}          # 6 位码 -> 过期时间戳（防重放）
_sessions: dict[str, float] = {}            # 兼容用：当前实现无状态，保留给手工吊销
app = FastAPI(title="dsh-auth", docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------- 工具


def log_event(event: str, request: Request, detail: str = "") -> None:
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "-")
    ua = (request.headers.get("user-agent") or "-")[:80]
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    line = f"{ts} event={event} ip={ip} ua={ua!r}"
    if detail:
        line += f" detail={detail}"
    try:
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    print(line, flush=True)


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def verify_password(candidate: str) -> bool:
    """PBKDF2-SHA256 校验；常数时间比对。"""
    try:
        scheme, rounds, salt_b64, hash_b64 = PWD_HASH.split("$", 3)
    except ValueError:
        return False
    if scheme != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256", candidate.encode("utf-8"), _b64d(salt_b64), int(rounds)
    )
    return hmac.compare_digest(_b64e(digest), hash_b64)


def verify_totp(code: str) -> bool:
    code = (code or "").strip().replace(" ", "")
    if not re.fullmatch(r"\d{6}", code):
        return False
    if not pyotp.TOTP(TOTP_SECRET).verify(code, valid_window=1):
        return False
    now = time.time()
    for stale in [k for k, exp in _seen_codes.items() if exp < now]:
        _seen_codes.pop(stale, None)
    if code in _seen_codes:          # 同一个码在 120 秒内重复使用 = 重放
        return False
    _seen_codes[code] = now + 120
    return True


def issue_cookie() -> str:
    """无状态会话：v1.<过期时间戳>.<HMAC(secret, pwd_hash|exp)>。"""
    exp = int(time.time()) + SESSION_TTL
    mac = hmac.new(
        _b64d(COOKIE_SECRET), f"{PWD_HASH}|{exp}".encode(), hashlib.sha256
    ).digest()
    return f"v1.{exp}.{_b64e(mac)}"


def check_cookie_value(value: Optional[str]) -> bool:
    if not value or not value.startswith("v1."):
        return False
    parts = value.split(".")
    if len(parts) != 3:
        return False
    _, exp, mac = parts
    if not exp.isdigit() or int(exp) < time.time():
        return False
    expect = hmac.new(
        _b64d(COOKIE_SECRET), f"{PWD_HASH}|{exp}".encode(), hashlib.sha256
    ).digest()
    return hmac.compare_digest(_b64e(expect), mac)


def is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip()
    return proto == "https"


TOKEN_FILES = [
    Path(p.strip())
    for p in (os.environ.get("DSH_TOKEN_FILES") or str(TOKEN_FILE)).split(";")
    if p.strip()
]
DSH_LOCAL = os.environ.get("DSH_LOCAL_ORIGIN", "http://127.0.0.1:8791")


def _token_candidates() -> list[str]:
    """按日志文件的修改时间倒序收集候选 token（最新的优先）。"""
    files = sorted(
        [p for p in TOKEN_FILES if p.exists()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    out: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        found = re.findall(r"token=([A-Za-z0-9_\-]{20,})", text)
        if found and found[-1] not in out:
            out.append(found[-1])
    return out


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不让 urllib 跟跳转：token 交换的 Set-Cookie 只在 303 响应本身上。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def token_is_live(token: str) -> bool:
    """拿 token 去 DSH 换一次 cookie：能换到 dsh-auth-* cookie 才算可用。

    日志被覆写、进程重启后旧 token 会失效，只看文本无法区分，必须实证。
    """
    req = urllib.request.Request(
        f"{DSH_LOCAL}/?token={token}",
        headers={"Host": DSH_LOCAL.split("//", 1)[1]},
        method="GET",
    )
    # 只装一个重定向处理器：默认那份会跟着 303 跑掉，之后就看不到 Set-Cookie 了。
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(req, timeout=3) as resp:
            cookies = " ".join(resp.headers.get_all("set-cookie") or [])
            return "dsh-auth-" in cookies
    except urllib.error.HTTPError as exc:
        cookies = " ".join(exc.headers.get_all("set-cookie") or [])
        return "dsh-auth-" in cookies
    except Exception:
        return False


def read_dsh_token() -> Optional[str]:
    """取当前可用 token：候选里第一个能真正换到 cookie 的。"""
    for token in _token_candidates():
        if token_is_live(token):
            return token
    return None


def mint_dsh_cookie(authority: str) -> Optional[str]:
    """离线签发 DSH 的 browser-session cookie（算法同 dsh 自带的 dsh-cookie.mjs）。"""
    try:
        raw = CRED_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(r"client-connection/browser-session:[\s\S]*?secret:\s*(\S+)", raw)
    if not m:
        return None
    secret = _b64d(m.group(1).replace("-", "+").replace("_", "/"))
    now = int(time.time() * 1000)
    body = _b64e(
        json.dumps(
            {"version": 1, "authority": authority, "issuedAt": now,
             "expiresAt": now + 30 * 24 * 3600 * 1000},
            separators=(",", ":"),
        ).encode()
    )
    sig = _b64e(hmac.new(secret, body.encode(), hashlib.sha256).digest())
    name = "dsh-auth-" + _b64e(hashlib.sha256(authority.encode()).digest())
    return f"{name}=v1.{body}.{sig}"


def set_session_cookie(response, request: Request) -> None:
    response.set_cookie(
        COOKIE_NAME,
        issue_cookie(),
        max_age=SESSION_TTL,
        path="/",
        httponly=True,
        secure=is_https(request),
        samesite="lax",
    )


# ---------------------------------------------------------------- 路由


@app.get("/healthz")
def healthz() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "uptime_s": int(time.time() - APP_START),
            "public_host": PUBLIC_HOST,
            "token_file": str(TOKEN_FILE),
            "token_available": read_dsh_token() is not None,
        }
    )


@app.get("/login-page", response_class=HTMLResponse)
def login_page(e: str = "") -> HTMLResponse:
    page = (BASE / "login.html").read_text(encoding="utf-8")
    message = ""
    if e == "bad":
        message = "密码或动态验证码不正确（验证码 30 秒一换，别用上一条消息里的旧码）"
    elif e == "replay":
        message = "这个验证码刚刚已经用过一次，等下一个 30 秒窗口再试"
    return HTMLResponse(page.replace("{{ERROR}}", message))


@app.api_route("/auth", methods=["GET", "POST"])
async def auth(request: Request) -> RedirectResponse:
    """入口：nginx 把 /_app_login 代理到这里。成功 302 到 /?token=<token>。

    只接受 POST 表单；GET 仅作兼容（参数在 query 里，会被 access.log 记录，
    不是推荐用法——登录页用的是 POST）。
    """
    if request.method == "POST":
        form = await request.form()
        # 登录页用 password / code（与 dw 一致）；p / t 是文档里的旧字段名，一并兼容。
        password = str(form.get("password") or form.get("p") or "")
        code = str(form.get("code") or form.get("t") or "")
    else:
        password = request.query_params.get("password") or request.query_params.get("p") or ""
        code = request.query_params.get("code") or request.query_params.get("t") or ""

    if not verify_password(password):
        log_event("PWD_FAIL", request)
        return RedirectResponse("/login.html?e=bad", status_code=302)

    if not verify_totp(code):
        log_event("TOTP_FAIL", request, detail=f"code={code[:2]}**")
        return RedirectResponse("/login.html?e=bad", status_code=302)

    log_event("AUTH_OK", request)
    token = read_dsh_token()
    response = RedirectResponse(f"/?token={token}" if token else "/", status_code=302)
    set_session_cookie(response, request)

    if not token:
        # 日志里没有可用 token（被覆盖/未重定向），退化为离线签发 DSH cookie
        minted = mint_dsh_cookie(PUBLIC_HOST)
        if minted:
            name, value = minted.split("=", 1)
            response.headers.append(
                "set-cookie",
                f"{name}={value}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax",
            )
            log_event("TOKEN_MISSING_MINTED", request)
    return response


@app.get("/check-cookie")
def check_cookie(request: Request):
    """nginx auth_request 子请求：200 放行，401 触发登录跳转。"""
    if check_cookie_value(request.cookies.get(COOKIE_NAME)):
        return PlainTextResponse("ok")
    log_event("COOKIE_FAIL", request)
    return PlainTextResponse("unauthorized", status_code=401)


@app.get("/logout")
def logout(request: Request) -> RedirectResponse:
    response = RedirectResponse("/login.html", status_code=302)
    response.delete_cookie(COOKIE_NAME, path="/")
    log_event("LOGOUT", request)
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("DSH_AUTH_PORT", "8099")), log_level="info")
