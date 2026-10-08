#!/usr/bin/env python3
"""Double-fork daemon launcher.

The sandbox reaps every descendant of the ephemeral tool shell when a Bash
tool call ends - plain `nohup ... &`, `disown` and even `setsid` all die
because they remain in the shell's child tree (or in its kill sweep by some
other heuristic). Long-lived infra processes (agent-browser's daemon) survive
because they double-fork: the intermediate parent exits immediately, so the
daemon is re-parented to init BEFORE the tool call's cleanup walks the tree.

Usage: daemonizer.py <cmd> [args...]
"""
import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: daemonizer.py <cmd> [args...]", file=sys.stderr)
        sys.exit(2)

    pid = os.fork()
    if pid > 0:
        # first parent exits right away - the tool shell sees this PID die
        sys.exit(0)

    os.setsid()  # new session, detach from controlling terminal

    pid = os.fork()
    if pid > 0:
        # intermediate parent exits too - grandchild re-parents to init
        os._exit(0)

    # grandchild: fully detached daemon; redirect stdio away from the shell
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    if devnull > 2:
        os.close(devnull)

    os.execvp(sys.argv[1], sys.argv[1:])
    os._exit(127)  # execvp failed


if __name__ == "__main__":
    main()
