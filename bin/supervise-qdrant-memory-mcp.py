#!/usr/bin/env python3
import os
import signal
import subprocess
import sys
import threading
import time


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: supervise-qdrant-memory-mcp.py COMMAND [ARG...]", file=sys.stderr)
        return 64

    parent_pid = os.getppid()
    child = subprocess.Popen(
        sys.argv[1:],
        stdin=sys.stdin,
        stdout=sys.stdout,
        stderr=sys.stderr,
        start_new_session=True,
    )

    terminating = threading.Event()

    def terminate_child() -> None:
        if terminating.is_set():
            return
        terminating.set()
        if child.poll() is not None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except PermissionError:
            child.terminate()

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if child.poll() is not None:
                return
            time.sleep(0.1)

        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except PermissionError:
            child.kill()

    def handle_signal(signum, _frame) -> None:
        terminate_child()
        raise SystemExit(128 + signum)

    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, handle_signal)

    def parent_watchdog() -> None:
        while child.poll() is None:
            if os.getppid() != parent_pid or not os.path.exists(f"/proc/{parent_pid}"):
                terminate_child()
                return
            time.sleep(1)

    threading.Thread(target=parent_watchdog, daemon=True).start()

    try:
        return child.wait()
    finally:
        terminate_child()


if __name__ == "__main__":
    raise SystemExit(main())
