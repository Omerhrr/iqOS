#!/usr/bin/env python3
"""iqOS trading-core kernel keeper daemon.

Same double-fork pattern as sidecar-keeper.py (survives the sandbox's
per-call process reaping). Keeps the kernel (bun index.ts, port 3030) up;
if the environment's own supervisor is present it will simply never win
the port race and idle.

Start detached from a tool shell:
  python3 /home/z/my-project/scripts/kernel-keeper.py
Stop:
  python3 /home/z/my-project/scripts/kernel-keeper.py stop
"""
import os
import signal
import subprocess
import sys
import time

PROJECT = "/home/z/my-project"
LOG = f"{PROJECT}/kernel-keeper.log"
KERNEL_LOG = f"{PROJECT}/kernel.log"
BUN = "/usr/local/bin/bun"
CMD = [BUN, "index.ts"]


def log(msg: str) -> None:
    line = f"[kernel-keeper {time.strftime('%T')}] {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")


def port_up(port: str) -> bool:
    try:
        out = subprocess.run(["ss", "-tln"], capture_output=True, text=True, timeout=5).stdout
        return f":{port} " in out
    except Exception:
        return True  # unsure -> do not double-spawn


def loop() -> None:
    log("daemon loop started (kernel :3030)")
    while True:
        try:
            if not port_up("3030"):
                log("starting trading-core kernel on :3030")
                with open(KERNEL_LOG, "a") as kf:
                    subprocess.Popen(
                        CMD, cwd=f"{PROJECT}/mini-services/trading-core",
                        stdout=kf, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL, start_new_session=True,
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
        print(f"kernel-keeper daemonized (see {LOG})")
        sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "stop":
        try:
            out = subprocess.run(["pgrep", "-f", "kernel-keeper.py"], capture_output=True, text=True).stdout
            for pid in out.split():
                if int(pid) != os.getpid():
                    os.kill(int(pid), signal.SIGTERM)
            print("stopped")
        except Exception as e:  # noqa: BLE001
            print(f"stop failed: {e}")
        sys.exit(0)
    daemonize()
    loop()
