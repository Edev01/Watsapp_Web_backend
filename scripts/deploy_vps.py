#!/usr/bin/env python3
"""
Reusable Contabo VPS deploy for Watsapp_Web_backend.

Usage (from anywhere):
  python scripts/deploy_vps.py
  python scripts/deploy_vps.py server.js ai/normalizer.js
  python scripts/deploy_vps.py --all-js

Env (optional overrides):
  VPS_HOST  VPS_USER  VPS_PASS  VPS_REMOTE_DIR
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time

try:
    import paramiko
except ImportError:
    print("paramiko required: pip install paramiko")
    sys.exit(1)

HOST = os.environ.get("VPS_HOST", "194.233.90.150")
USER = os.environ.get("VPS_USER", "omer")
PASS = os.environ.get("VPS_PASS", "omer123")
REMOTE = os.environ.get("VPS_REMOTE_DIR", "/home/omer/whatsapp_scrapper_backend")
LOCAL = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

DEFAULT_FILES = [
    "server.js",
    "pakistanLocalities.js",
    "smartLocationSearch.js",
    "propertyHelper.js",
    "ai/normalizer.js",
    "ai/geminiClient.js",
    "ai/geocodeClient.js",
    "ai/cascadeMerge.js",
    "ai/config.js",
    "ai/normalizePrompt.js",
    "ai/index.js",
    "ai/llmClient.js",
    "ai/localNer.js",
    ".env.example",
]


def run(ssh, cmd, timeout=120):
    print("=====", cmd[:160])
    sys.stdout.flush()
    chan = ssh.get_transport().open_session()
    chan.get_pty(width=160, height=40)
    chan.settimeout(timeout)
    chan.exec_command(cmd)
    out = b""
    while True:
        if chan.recv_ready():
            chunk = chan.recv(65535)
            if not chunk:
                break
            out += chunk
        elif chan.exit_status_ready():
            while chan.recv_ready():
                out += chan.recv(65535)
            break
        else:
            time.sleep(0.05)
            if chan.exit_status_ready() and not chan.recv_ready():
                break
    code = chan.recv_exit_status()
    text = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", out.decode("utf-8", "replace"))
    # never echo secrets
    text = re.sub(r"AQ\.[A-Za-z0-9_-]+", "AQ.***", text)
    text = re.sub(r"(GEMINI_API_KEYS=).*", r"\1***", text)
    text = re.sub(r"(LLM_API_KEY=).*", r"\1***", text)
    try:
        print(text)
    except Exception:
        print(text.encode("ascii", "replace").decode())
    print("EXIT", code)
    sys.stdout.flush()
    return code


def collect_files(args):
    if args.all_js:
        files = []
        for root, _, names in os.walk(LOCAL):
            if "node_modules" in root or ".git" in root:
                continue
            for name in names:
                if name.endswith(".js") or name == ".env.example":
                    rel = os.path.relpath(os.path.join(root, name), LOCAL).replace("\\", "/")
                    if rel.startswith("scripts/"):
                        continue
                    files.append(rel)
        return sorted(files)
    if args.files:
        return [f.replace("\\", "/") for f in args.files]
    return list(DEFAULT_FILES)


def main():
    parser = argparse.ArgumentParser(description="Deploy backend files to Contabo VPS")
    parser.add_argument("files", nargs="*", help="Relative paths under backend root")
    parser.add_argument("--all-js", action="store_true", help="Upload all .js files")
    parser.add_argument("--no-restart", action="store_true", help="Skip pm2 restart")
    args = parser.parse_args()

    files = collect_files(args)
    missing = [f for f in files if not os.path.isfile(os.path.join(LOCAL, f.replace("/", os.sep)))]
    if missing:
        print("Missing local files:", missing)
        sys.exit(1)

    print(f"LOCAL={LOCAL}")
    print(f"REMOTE={REMOTE}")
    print(f"FILES ({len(files)}):", ", ".join(files))

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=25, allow_agent=False, look_for_keys=False)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    run(ssh, f"mkdir -p {REMOTE}/ai {REMOTE}/scripts {REMOTE}/.deploy_backup_{stamp}/ai")

    sftp = ssh.open_sftp()
    for rel in files:
        local = os.path.join(LOCAL, rel.replace("/", os.sep))
        remote = f"{REMOTE}/{rel}"
        remote_dir = os.path.dirname(remote).replace("\\", "/")
        try:
            sftp.stat(remote_dir)
        except FileNotFoundError:
            # mkdir -p style
            parts = remote_dir.replace(REMOTE, "").strip("/").split("/")
            cur = REMOTE
            for p in parts:
                if not p:
                    continue
                cur = f"{cur}/{p}"
                try:
                    sftp.stat(cur)
                except FileNotFoundError:
                    sftp.mkdir(cur)
        # backup if exists
        try:
            sftp.stat(remote)
            run(ssh, f"mkdir -p $(dirname {REMOTE}/.deploy_backup_{stamp}/{rel}) && cp -a {remote} {REMOTE}/.deploy_backup_{stamp}/{rel}")
        except FileNotFoundError:
            pass
        print("UPLOAD", rel)
        sftp.put(local, remote)
    sftp.close()

    js_files = [f for f in files if f.endswith(".js")]
    if js_files:
        checks = " && ".join([f"node --check {REMOTE}/{f}" for f in js_files])
        if run(ssh, f"{checks} && echo SYNTAX_OK") != 0:
            print("SYNTAX FAILED — restore from backup if needed")
            sys.exit(1)

    if not args.no_restart:
        if run(ssh, "pm2 restart whatsapp-backend --update-env && sleep 2 && curl -s -o /dev/null -w 'health=%{http_code}\\n' http://127.0.0.1:3000/") != 0:
            sys.exit(1)

    ssh.close()
    print("DEPLOY_OK")


if __name__ == "__main__":
    main()
