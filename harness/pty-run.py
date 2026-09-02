#!/usr/bin/env python3
"""Run a command in a pty with a fixed size, feed scripted keys, capture output.
Usage: pty-run.py --cols 140 --rows 40 --timeout 25 --keys "2:/tree\r" --keys "6:q" -- opencode ...
Each --keys is "<delay_seconds>:<text>" (\\r for Enter, \\x1b for Esc, \\x11 for ctrl+q)."""
import argparse, os, pty, select, sys, time, fcntl, termios, struct, signal
p = argparse.ArgumentParser(); p.add_argument("--cols", type=int, default=140); p.add_argument("--rows", type=int, default=40)
p.add_argument("--timeout", type=float, default=20); p.add_argument("--keys", action="append", default=[]); p.add_argument("--out", default="pty.out")
p.add_argument("cmd", nargs=argparse.REMAINDER); a = p.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"; os.environ["COLUMNS"] = str(a.cols); os.environ["LINES"] = str(a.rows)
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
keys = sorted([(float(k.split(":", 1)[0]), k.split(":", 1)[1].encode().decode("unicode_escape").encode("latin1")) for k in a.keys])
start = time.time(); buf = b""; ki = 0
while time.time() - start < a.timeout:
    while ki < len(keys) and time.time() - start >= keys[ki][0]:
        os.write(fd, keys[ki][1]); ki += 1
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
try: os.kill(pid, signal.SIGTERM)
except Exception: pass
open(a.out, "wb").write(buf)
# strip ANSI for a readable dump
import re
txt = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([A-Z]", b"", buf).decode("utf8", "replace")
open(a.out + ".txt", "w").write(txt)
print(f"captured {len(buf)} bytes -> {a.out} / {a.out}.txt")
