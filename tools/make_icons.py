"""Generate Android launcher icons for Treasure Quest.

Pure Python (stdlib only): renders a small pixel-art emblem at 512x512 and
downsamples it into the Android mipmap density buckets.

Usage:
    python tools/make_icons.py
"""

import os
import struct
import zlib

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES_DIR = os.path.join(PROJECT_ROOT, "android", "app", "src", "main", "res")
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")

BASE = 512
SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def write_png(path, width, height, rows):
    """rows: list of bytes objects, each row is width*4 RGBA bytes."""
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def rounded_rect_alpha(x, y, w, h, r):
    """Anti-aliased rounded rect coverage at continuous coords."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    dist = (dx * dx + dy * dy) ** 0.5
    if dist <= r - 1:
        return 1.0
    if dist >= r + 1:
        return 0.0
    return 1.0 - (dist - (r - 1)) / 2.0


def point_in_poly(x, y, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi:
            inside = not inside
        j = i
    return inside


def dist_to_segment(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx * abx + aby * aby
    t = 0.0 if denom == 0 else clamp01((apx * abx + apy * aby) / denom)
    dx, dy = px - (ax + abx * t), py - (ay + aby * t)
    return (dx * dx + dy * dy) ** 0.5


def polygon_edge_dist(x, y, pts):
    d = 1e9
    for i in range(len(pts)):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % len(pts)]
        d = min(d, dist_to_segment(x, y, ax, ay, bx, by))
    return d


def render_base():
    w = h = BASE
    rows = []
    gem = [(256, 78), (372, 236), (256, 430), (140, 236)]
    gem_inner = [(256, 118), (332, 244), (256, 386), (180, 244)]
    sparkle_cx, sparkle_cy = 372, 150

    for y in range(h):
        row = bytearray()
        for x in range(w):
            # background rounded square
            a = rounded_rect_alpha(x + 0.5, y + 0.5, w, h, 96)
            if a <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            t = y / h
            r = int(lerp(20, 34, t))
            g = int(lerp(28, 44, t))
            b = int(lerp(48, 74, t))
            # radial glow top-left
            glow = clamp01(1.0 - (((x - 150) ** 2 + (y - 120) ** 2) ** 0.5) / 420.0) * 0.18
            r = int(lerp(r, 90, glow))
            g = int(lerp(g, 110, glow))
            b = int(lerp(b, 160, glow))
            # vignette
            vx, vy = (x - w / 2) / (w / 2), (y - h / 2) / (h / 2)
            vig = clamp01(1.0 - (vx * vx + vy * vy) * 0.55)
            r, g, b = int(r * vig), int(g * vig), int(b * vig)

            # gem gold base + facets
            if point_in_poly(x + 0.5, y + 0.5, gem):
                edge = polygon_edge_dist(x + 0.5, y + 0.5, gem)
                if edge < 5:
                    r, g, b = 120, 78, 18
                elif point_in_poly(x + 0.5, y + 0.5, gem_inner):
                    if x > 256:
                        r, g, b = 214, 158, 47
                    else:
                        r, g, b = 255, 212, 92
                    if y > 300:
                        r, g, b = int(r * 0.9), int(g * 0.9), int(b * 0.9)
                else:
                    r, g, b = 245, 197, 66
                # top-left highlight
                if point_in_poly(x + 0.5, y + 0.5, [(256, 78), (300, 150), (256, 200), (212, 150)]):
                    r, g, b = 255, 236, 150
                # sparkle cross
            dx, dy = abs(x - sparkle_cx), abs(y - sparkle_cy)
            if (dx < 3 and dy < 26) or (dy < 3 and dx < 26):
                r, g, b = 255, 255, 255

            row += bytes((r, g, b, int(255 * a)))
        rows.append(bytes(row))
    return rows


def downsample(rows, src, dst):
    scale = src / dst
    out = []
    for ty in range(dst):
        row = bytearray()
        y0 = int(ty * scale)
        y1 = max(y0 + 1, int((ty + 1) * scale))
        for tx in range(dst):
            x0 = int(tx * scale)
            x1 = max(x0 + 1, int((tx + 1) * scale))
            rs = gs = bs = as_ = n = 0
            for sy in range(y0, min(y1, src)):
                srcrow = rows[sy]
                for sx in range(x0, min(x1, src)):
                    i = sx * 4
                    r, g, b, a = srcrow[i], srcrow[i + 1], srcrow[i + 2], srcrow[i + 3]
                    rs += r * a
                    gs += g * a
                    bs += b * a
                    as_ += a
                    n += 1
            if as_ == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((rs // as_, gs // as_, bs // as_, as_ // max(n, 1)))
        out.append(bytes(row))
    return out


def main():
    os.makedirs(DIST_DIR, exist_ok=True)
    base_rows = render_base()
    write_png(os.path.join(DIST_DIR, "icon-512.png"), BASE, BASE, base_rows)
    print("wrote dist/icon-512.png")
    for folder, size in SIZES.items():
        out_dir = os.path.join(RES_DIR, folder)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "ic_launcher.png")
        write_png(path, size, size, downsample(base_rows, BASE, size))
        print("wrote", os.path.relpath(path, PROJECT_ROOT))
    print("icons done")


if __name__ == "__main__":
    main()
