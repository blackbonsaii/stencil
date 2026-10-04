#!/usr/bin/env python3
"""Minimal driver for the Phomemo TP88 (QUIN) over USB serial.

usage:
  tp88.py status
  tp88.py print IMAGE [--width-bytes 208] [--threshold 128] [--dither] [--invert]
  tp88.py testpage [--width-bytes 208]
"""
import argparse, glob, sys, time
import serial
from PIL import Image, ImageDraw, ImageOps

def find_port():
    ports = glob.glob("/dev/cu.usbmodem*")
    if not ports:
        sys.exit("TP88 not found (no /dev/cu.usbmodem*)")
    return ports[0]

def open_printer(port=None):
    return serial.Serial(port or find_port(), 115200, timeout=1)

def query(s, cmd):
    s.reset_input_buffer()
    s.write(bytes(cmd)); s.flush(); time.sleep(0.3)
    return s.read(64)

def status(s):
    b = query(s, [0x1f, 0x11, 0x08])
    fw = query(s, [0x1f, 0x11, 0x07])
    sn = query(s, [0x1f, 0x11, 0x09])
    if len(b) >= 3: print(f"battery: {b[2]}%")
    if len(fw) >= 5: print(f"firmware: {fw[2]}.{fw[3]}.{fw[4]}")
    if len(sn) > 2: print(f"serial: {sn[2:].decode(errors='replace')}")
    p = query(s, [0x1f, 0x11, 0x11])
    if len(p) >= 3: print("paper:", "loaded" if p[2] & 0x01 else "EMPTY")

def to_bitmap(img, width_bytes, threshold=128, dither=False, invert=False):
    """Scale image to printer width, return 1-bit rows (1 = black dot)."""
    dots = width_bytes * 8
    img = ImageOps.exif_transpose(img).convert("L")
    if img.width != dots:
        img = img.resize((dots, round(img.height * dots / img.width)), Image.LANCZOS)
    if invert:
        img = ImageOps.invert(img)
    # The TP88 lays dots right-to-left as seen from the printed side: flip so output reads correctly.
    img = ImageOps.mirror(img)
    bw = img.convert("1") if dither else img.point(lambda p: 255 if p >= threshold else 0, "1")
    # PIL "1" mode: 0 = black. Printer: bit 1 = black. Invert bits.
    raw = bytes(~b & 0xFF for b in bw.tobytes())
    return raw, bw.height

def print_bitmap(s, raw, height, width_bytes, density=4):
    s.write(b"\x1b\x40")                       # ESC @  init
    s.write(b"\x1d\x28\x4b\x02\x00\x31" + bytes([density]))  # darkness 1-8
    chunk = 255                                # max lines per raster block
    for y in range(0, height, chunk):
        h = min(chunk, height - y)
        s.write(b"\x1d\x76\x30\x00" +
                width_bytes.to_bytes(2, "little") + h.to_bytes(2, "little"))
        s.write(raw[y * width_bytes:(y + h) * width_bytes])
        s.flush()
        time.sleep(0.05)
    s.write(b"\x1b\x64\x02")                   # feed 2 lines
    s.flush()

def testpage(width_bytes):
    w = width_bytes * 8
    img = Image.new("L", (w, 400), 255)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, 399], outline=0, width=3)
    for x in range(0, w, 8):                   # ruler: tick every 8 dots
        L = 60 if x % 80 == 0 else 25
        d.line([x, 0, x, L], fill=0)
        if x % 160 == 0:
            d.text((x + 3, 65), str(x), fill=0)
    d.text((20, 150), f"TP88 test - width {w} dots ({width_bytes} bytes)", fill=0)
    d.line([0, 399, w - 1, 0], fill=0, width=2)
    return img

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "print", "testpage"])
    ap.add_argument("image", nargs="?")
    ap.add_argument("--port")
    ap.add_argument("--width-bytes", type=int, default=208)
    ap.add_argument("--threshold", type=int, default=128)
    ap.add_argument("--dither", action="store_true")
    ap.add_argument("--invert", action="store_true")
    ap.add_argument("--density", type=int, default=4, help="darkness 1-8")
    a = ap.parse_args()
    s = open_printer(a.port)
    if a.cmd == "status":
        status(s); return
    img = testpage(a.width_bytes) if a.cmd == "testpage" else Image.open(a.image)
    raw, h = to_bitmap(img, a.width_bytes, a.threshold, a.dither, a.invert)
    print(f"printing {a.width_bytes*8}x{h} dots")
    print_bitmap(s, raw, h, a.width_bytes, a.density)
    time.sleep(1)
    print("sent; paper now:", "loaded" if query(s, [0x1f, 0x11, 0x11])[2:3] == b"\x89" else "empty/unknown")

if __name__ == "__main__":
    main()
