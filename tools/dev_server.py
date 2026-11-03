"""Local dev static server for the H5 game.

Usage:
    python tools/dev_server.py [--port 5173] [--bind 127.0.0.1]

Then open http://127.0.0.1:5173/
The local API runs separately:  python server/server.py   (http://127.0.0.1:3001)
The shell resolves ?api= query parameter, e.g.:
    http://127.0.0.1:5173/?api=http://127.0.0.1:3001
"""

import argparse
import functools
import http.server
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(PROJECT_ROOT, "web")


class DevHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write("[dev] " + (fmt % args) + "\n")
        sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--dir", default=WEB_DIR)
    args = ap.parse_args()
    if not os.path.exists(os.path.join(args.dir, "index.html")):
        print("ERROR: web/index.html not found under", args.dir, file=sys.stderr)
        return 1
    handler = functools.partial(DevHandler, directory=args.dir)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print("=" * 56)
        print("  Treasure Quest local dev server")
        print("  game : http://%s:%d/" % (args.bind, args.port))
        print("  api  : http://127.0.0.1:3001/  (run: python server/server.py)")
        print("  tip  : add ?api=http://127.0.0.1:3001 to use local API")
        print("=" * 56)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
