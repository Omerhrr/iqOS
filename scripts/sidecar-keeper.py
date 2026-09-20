#!/usr/bin/env python3
"""iqOS live-sidecar keeper daemon.

Same double-fork pattern as web-keeper.py (survives the sandbox's per-call
process reaping). Keeps live/iqair_sidecar.py - the IQ Option bridge the
kernel talks to on 127.0.0.1:8788 - up for live PRACTICE sessions.

Start detached from a tool shell:
  python3 /home/z/my-project/scripts/sidecar-keeper.py
Stop:
  python3 /home/z/my-project/scripts/sidecar-keeper.py stop
"""
import os
import signal
import subprocess
import sys
import time

PROJECT = "/home/z/my-project"
LOG = f"{PROJECT}/sidecar-keeper.log"
SIDECAR_LOG = f"{PROJECT}/sidecar.log"
PY = "/home/z/.venv/bin/python3"
CMD = [PY, f"{PROJECT}/live/iqair_sidecar.py"]


def log(msg: str) -> None:
    line = f"[sidecar-keeper {time.strftime('%T')}] {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")


def port_up(port: str) -> bool:
    try:
        out = subprocess.run(["ss", "-tln"], capture_output=True, text=True, timeout=5).stdout
        return f":{port} " in out
    except Exception:
        return True  # unsure -> do not double-spawn


def loop() -> None:
    log("daemon loop started (sidecar :8788)")
    while True:
        try:
            if not port_up("8788"):
                log("starting iqair sidecar on :8788")
                with open(SIDECAR_LOG, "a") as sf:
                    subprocess.Popen(
                        CMD, cwd=f"{PROJECT}/live", stdout=sf,
                        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
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
        print(f"sidecar-keeper daemonized (see {LOG})")
        sys.exit(0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "stop":
        try:
            out = subprocess.run(["pgrep", "-f", "sidecar-keeper.py"], capture_output=True, text=True).stdout
            for pid in out.split():
                if int(pid) != os.getpid():
                    os.kill(int(pid), signal.SIGTERM)
            print("stopped")
        except Exception as e:  # noqa: BLE001
            print(f"stop failed: {e}")
        sys.exit(0)
    daemonize()
    loop()
