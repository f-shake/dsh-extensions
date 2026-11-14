import ctypes
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import webbrowser

PORT = int(os.environ.get("DSH_LAUNCH_PORT", "8791"))
OPEN_BROWSER = os.environ.get("DSH_LAUNCH_NO_BROWSER") != "1"
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "dsh.out.log")
ERR = os.path.join(BASE, "dsh.err.log")
URL_LAN = os.path.join(BASE, "lan-url.txt")
URL_LOCAL = os.path.join(BASE, "local-url.txt")
PID_FILE = os.path.join(BASE, "dsh.pid")

# No console at all: a console-level CTRL_C from any process (including a
# dsh-controlled shell or terminal) cannot reach this server.
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def append(path, text):
    with open(path, "ab") as handle:
        handle.write((text + "\r\n").encode("utf-8"))


def note(message):
    append(OUT, "[{}] {}".format(time.strftime("%Y-%m-%dT%H:%M:%S"), message))


def message_box(text):
    ctypes.windll.user32.MessageBoxW(0, text, "DeepSeek Harness", 0x10)


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def is_up(ip):
    try:
        with socket.create_connection((ip, PORT), timeout=0.4):
            return True
    except OSError:
        return False


def stored_token():
    for path in (URL_LAN, URL_LOCAL):
        try:
            with open(path, "r", encoding="ascii") as handle:
                match = re.search(r"token=([^&\s]+)", handle.read())
                if match:
                    return match.group(1)
        except OSError:
            pass
    return None


def url_for(host):
    token = stored_token()
    return "http://{}:{}/?token={}".format(host, PORT, token) if token else "http://{}:{}/".format(host, PORT)


def write_url_files(url, host_ip):
    with open(URL_LAN, "w", encoding="ascii") as handle:
        handle.write(url)
    with open(URL_LOCAL, "w", encoding="ascii") as handle:
        handle.write(url.replace(host_ip, "127.0.0.1"))


def open_url(url):
    if not OPEN_BROWSER:
        return
    try:
        os.startfile(url)
    except OSError:
        webbrowser.open(url)


def start():
    host_ip = lan_ip()

    if is_up(host_ip):
        open_url(url_for(host_ip))
        return 0

    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    bin_js = os.path.join(
        os.environ.get("APPDATA", ""),
        "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js",
    )
    if not os.path.isfile(bin_js):
        message_box("找不到 dsh:\n{}\n请先运行: npm install -g @deepseek-ai/dsh".format(bin_js))
        return 1

    offset = os.path.getsize(OUT) if os.path.exists(OUT) else 0
    note("starting: {} {} web --host {} --port {} --no-open".format(node, bin_js, host_ip, PORT))

    with open(OUT, "ab") as stdout, open(ERR, "ab") as stderr:
        proc = subprocess.Popen(
            [node, bin_js, "web", "--host", host_ip, "--port", str(PORT), "--no-open"],
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            cwd=os.path.expanduser("~"),
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )

    with open(PID_FILE, "w", encoding="ascii") as handle:
        handle.write(str(proc.pid))

    url = None
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            with open(OUT, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read().decode("utf-8", "replace")
            match = re.search(r"dsh web: (http://\S+\?token=\S+)", chunk)
            if match:
                url = match.group(1).strip()
                break
        except OSError:
            pass
        time.sleep(0.5)

    if not url:
        note("start failed (exit={}); see {} and {}".format(proc.poll(), OUT, ERR))
        message_box("DeepSeek Harness 启动失败（exit={}）。\n详情见:\n{}\n{}".format(proc.poll(), OUT, ERR))
        return 1

    write_url_files(url, host_ip)
    open_url(url)
    return 0


if __name__ == "__main__":
    sys.exit(start())
