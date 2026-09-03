#!/usr/bin/env python3
"""Run a command in a pty with a fixed size, feed scripted keys, capture output.
Usage: pty-run.py --cols 140 --rows 40 --timeout 25 --keys "2:/tree\r" --keys "6:q" -- opencode ...
Each --keys is "<delay_seconds>:<text>" (\\r for Enter, \\x1b for Esc, \\x11 for ctrl+q), or
"@<regex>+<delay_seconds>:<text>" to wait until <regex> appears in the ANSI-stripped output, then
<delay_seconds> more, before sending ("@!<regex>+..." matches only output produced after the previous
key was sent). Conditional keys are processed in order after all timed keys."""
import argparse, os, pty, select, sys, time, fcntl, termios, struct, signal
p = argparse.ArgumentParser(); p.add_argument("--cols", type=int, default=140); p.add_argument("--rows", type=int, default=40)
p.add_argument("--timeout", type=float, default=20); p.add_argument("--keys", action="append", default=[]); p.add_argument("--out", default="pty.out")
p.add_argument("--exit-when-done", dest="exit_when_done", action="store_true", help="stop capturing 1s after the last key was sent")
p.add_argument("--png-dir", dest="png_dir", default=None, help="also render every screen snapshot to <dir>/<n>-<label>.png (needs Pillow)")
p.add_argument("cmd", nargs=argparse.REMAINDER); a = p.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"; os.environ["COLUMNS"] = str(a.cols); os.environ["LINES"] = str(a.rows)
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
import re
def decode(t): return t.encode().decode("unicode_escape").encode("latin1")
timed = []; cond = []
for k in a.keys:
    if k.startswith("@"):
        fresh = k.startswith("@!")
        pat, rest = k[2 if fresh else 1:].split("+", 1); delay, text = rest.split(":", 1)
        cond.append((re.compile(pat), float(delay), decode(text), fresh))
    else:
        delay, text = k.split(":", 1); timed.append((float(delay), decode(text)))
timed.sort(key=lambda x: x[0])
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([A-Z]")
start = time.time(); buf = b""; ki = 0; ci = 0; seen_at = None; mark = 0
timings = []; last_sent = start
try:
    import pyte
    screen = pyte.Screen(a.cols, a.rows); stream = pyte.ByteStream(screen)
except Exception:
    screen = None; stream = None
screens = []
PALETTE = {"default": None, "black": "#1e1e1e", "red": "#ff6b6b", "green": "#6bd36b", "brown": "#ffd76b", "yellow": "#ffd76b",
           "blue": "#6b9bff", "magenta": "#d78bff", "cyan": "#6bd7ff", "white": "#e6e6e6"}
def color(v, default):
    if v is None or v == "default": return default
    if v.startswith("bright"): v = v[6:]
    if v in PALETTE: return PALETTE[v] or default
    if len(v) == 6:
        try: int(v, 16); return "#" + v
        except ValueError: pass
    return default
def render_png(path):
    from PIL import Image, ImageDraw, ImageFont
    size = 15
    regular = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", size, index=0)
    bold = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", size, index=1)
    # Menlo has no U+2387 (⎇); Apple Symbols does
    try: symbols = ImageFont.truetype("/System/Library/Fonts/Apple Symbols.ttf", size)
    except Exception: symbols = None
    cw, ch = int(regular.getlength("M")), int(size * 1.3)
    img = Image.new("RGB", (cw * a.cols + 16, ch * a.rows + 16), "#1e1e1e")
    d = ImageDraw.Draw(img)
    for y in range(a.rows):
        row = screen.buffer[y]
        for x in range(a.cols):
            c = row[x]
            fg, bg = color(c.fg, "#d4d4d4"), color(c.bg, None)
            if c.reverse: fg, bg = (bg or "#1e1e1e"), (fg or "#d4d4d4")
            px, py = 8 + x * cw, 8 + y * ch
            if bg: d.rectangle([px, py, px + cw, py + ch], fill=bg)
            if c.data and c.data != " ":
                font = symbols if (symbols and c.data == "\u2387") else (bold if c.bold else regular)
                d.text((px, py), c.data, font=font, fill=fg)
    img.save(path)
def snapshot(label):
    if screen is None: return
    screens.append((label, "\n".join(line.rstrip() for line in screen.display)))
    if a.png_dir:
        try:
            os.makedirs(a.png_dir, exist_ok=True)
            safe = "".join(ch if ch.isalnum() else "_" for ch in label)[:40]
            render_png(os.path.join(a.png_dir, f"{len(screens):02d}-{safe}.png"))
        except Exception as e:
            sys.stderr.write(f"png render failed: {e}\n")
while time.time() - start < a.timeout:
    now = time.time() - start
    while ki < len(timed) and now >= timed[ki][0]:
        snapshot(f"before timed key {ki}: {timed[ki][1]!r}")
        os.write(fd, timed[ki][1]); ki += 1; mark = len(buf); last_sent = time.time()
        timings.append({"key": ki - 1, "kind": "timed", "text": timed[ki - 1][1].decode("latin1"), "sent_at_ms": round((last_sent - start) * 1000)})
    if ki >= len(timed) and ci < len(cond):
        pat, delay, text, fresh = cond[ci]
        if seen_at is None:
            window = buf[mark:] if fresh else buf[-200000:]
            if pat.search(ANSI.sub(b"", window).decode("utf8", "replace")):
                seen_at = time.time()
                # latency from the previous key to this pattern appearing on screen
                timings.append({"key": len(timed) + ci, "kind": "match", "pattern": pat.pattern, "wait_ms": round((seen_at - last_sent) * 1000), "at_ms": round((seen_at - start) * 1000)})
        elif time.time() - seen_at >= delay:
            snapshot(f"before conditional key {ci}: {text!r}")
            os.write(fd, text); ci += 1; seen_at = None; mark = len(buf); last_sent = time.time()
            timings.append({"key": len(timed) + ci - 1, "kind": "cond", "text": text.decode("latin1"), "sent_at_ms": round((last_sent - start) * 1000)})
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
        if stream is not None:
            try: stream.feed(d)
            except Exception: pass
    if ki >= len(timed) and ci >= len(cond) and a.exit_when_done:
        break
if a.exit_when_done:
    # keep draining for a second so output produced after the last key lands in the capture
    end = time.time() + 1.0
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r: continue
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
        if stream is not None:
            try: stream.feed(d)
            except Exception: pass
try: os.kill(pid, signal.SIGTERM)
except Exception: pass
snapshot("final")
open(a.out, "wb").write(buf)
import json
open(a.out + ".timing.json", "w").write(json.dumps(timings, indent=1))
if screens:
    with open(a.out + ".screens.txt", "w") as f:
        for label, text in screens:
            f.write(f"\n===== {label} =====\n{text}\n")
# strip ANSI for a readable dump
import re
txt = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([A-Z]", b"", buf).decode("utf8", "replace")
open(a.out + ".txt", "w").write(txt)
print(f"captured {len(buf)} bytes -> {a.out} / {a.out}.txt")
