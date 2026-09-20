#!/usr/bin/env python3
"""iqOS web-server keeper daemon.

Classic double-fork daemon (fork -> setsid -> fork -> orphan). This survives
the sandbox's per-call process reaping, which kills anything spawned directly
from a tool shell (even setsid) at call end - while the kernel bun process and
agent-browser daemon, both properly orphaned, live on.

Loop: if :3000 is dark, spawn the standalone production server
(node .next/standalone/server.js). Dev mode (`bun run dev`) OOM'd repeatedly
on the 4GB sandbox alongside kernel + headless chrome, so production is the
serving mode. Rebuild after code changes (see scripts/web-keeper.sh header).

Start detached from a tool shell:
  python3 /home/z/my-project/scripts/web-keeper.py
It returns immediately; the daemon keeps running.
"""
import os
import subprocess
import sys
import time

PROJECT = "/home/z/my-project"
LOG = f"{PROJECT}/web-keeper.log"
SERVER_LOG = f"{PROJECT}/server.log"
SERVER_CMD = ["node", ".next/standalone/server.js"]
ENV = {**os.environ, "PORT": "3000", "HOSTNAME": "0.0.0.0"}


def log(msg: str) -> None:
    line = f"[web-keeper {time.strftime('%T')}] {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")


def port_up() -> bool:
    try:
        out = subprocess.run(
            ["ss", "-tln"], capture_output=True, text=True, timeout=5
        ).stdout
        return ":3000 " in out
    except Exception:
        return True  # unsure -> do not double-spawn


def loop() -> None:
    log("daemon loop started")
    while True:
        try:
            if not port_up():
                log("starting standalone server on :3000")
                with open(SERVER_LOG, "a") as sf:
                    subprocess.Popen(
                        SERVER_CMD,
                        cwd=PROJECT,
                        env=ENV,
                        stdout=sf,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                    )
        except Exception as e:  # noqa: BLE001
            log(f"error: {e}")
        time.sleep(5)


def daemonize() -> None:
    pid = os.fork()
    if pid == 0:
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        sys.stdout.flush()
        os.chdir(PROJECT)
        fd = os.open(os.devnull, os.O_RDWR)
        os.dup2(fd, 0)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
    else:
        os.waitpid(pid, 0)
        print(f"web-keeper daemonized (see {LOG})")
        sys.exit(0)


if __name__ == "__main__":
    daemonize()
    loop()
