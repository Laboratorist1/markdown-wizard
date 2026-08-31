#!/usr/bin/env python3
"""Generate the Markdown Wizard icons.

Pillow is not a dependency of this repo, so the PNGs are rasterised by hand
(4x supersampling) and encoded with zlib.

    python3 tools/make_icons.py                            # extension icons
    python3 tools/make_icons.py --out icons \
        --sizes 180,192,512                                # web app icons
    python3 tools/make_icons.py --out icons --sizes 512 \
        --maskable                                         # Android maskable

A maskable icon is drawn full-bleed with the mark shrunk into the safe zone,
because Android crops the corners to whatever shape the launcher uses.
"""

import argparse
import math
import os
import struct
import zlib

ACCENT = (9, 105, 218)
WHITE = (255, 255, 255)
SIZES = (16, 32, 48, 128)
SAMPLES = 4


def rounded_rect(x, y, radius):
    """Signed test for the unit-square badge with rounded corners."""
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return math.hypot(x - cx, y - cy) <= radius


def segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


# The mark: an "M" drawn as four strokes, with a download-style arrow beside it.
STROKES = [
    ((0.20, 0.70), (0.20, 0.32)),
    ((0.20, 0.32), (0.35, 0.53)),
    ((0.35, 0.53), (0.50, 0.32)),
    ((0.50, 0.32), (0.50, 0.70)),
]
STROKE_WIDTH = 0.062
ARROW_X = 0.71
ARROW_TOP = 0.30
ARROW_STEM_BOTTOM = 0.52
ARROW_HALF = 0.115


def in_mark(x, y):
    for (ax, ay), (bx, by) in STROKES:
        if segment_distance(x, y, ax, ay, bx, by) <= STROKE_WIDTH:
            return True
    # Arrow stem.
    if abs(x - ARROW_X) <= STROKE_WIDTH and ARROW_TOP <= y <= ARROW_STEM_BOTTOM:
        return True
    # Arrow head: a triangle narrowing towards the tip.
    if ARROW_STEM_BOTTOM <= y <= 0.72:
        span = ARROW_HALF * (0.72 - y) / (0.72 - ARROW_STEM_BOTTOM)
        if abs(x - ARROW_X) <= span:
            return True
    return False


def render(size, maskable=False):
    # Maskable icons fill the square; the mark shrinks into the safe zone.
    radius = 0.5 if maskable else 0.22
    scale = 0.72 if maskable else 1.0
    rows = []
    step = 1.0 / (size * SAMPLES)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            badge = 0
            mark = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px * SAMPLES + sx + 0.5) * step
                    y = (py * SAMPLES + sy + 0.5) * step
                    if maskable or rounded_rect(x, y, radius):
                        badge += 1
                        mx = 0.5 + (x - 0.5) / scale
                        my = 0.5 + (y - 0.5) / scale
                        if in_mark(mx, my):
                            mark += 1
            total = SAMPLES * SAMPLES
            alpha = badge / total
            if alpha == 0:
                row.extend((0, 0, 0, 0))
                continue
            weight = mark / badge
            color = tuple(
                round(ACCENT[i] * (1 - weight) + WHITE[i] * weight) for i in range(3)
            )
            row.extend((color[0], color[1], color[2], round(alpha * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",
                        default=os.path.join(os.path.dirname(here), "extension", "icons"),
                        help="directory to write the PNGs into")
    parser.add_argument("--sizes", default=",".join(str(size) for size in SIZES),
                        help="comma-separated pixel sizes")
    parser.add_argument("--maskable", action="store_true",
                        help="draw full-bleed icons named maskable<size>.png")
    args = parser.parse_args()

    out_dir = os.path.abspath(os.path.join(os.getcwd(), args.out))
    os.makedirs(out_dir, exist_ok=True)
    prefix = "maskable" if args.maskable else "icon"
    for size in [int(value) for value in args.sizes.split(",")]:
        path = os.path.join(out_dir, "%s%d.png" % (prefix, size))
        write_png(path, size, render(size, args.maskable))
        print("wrote", path)


if __name__ == "__main__":
    main()
