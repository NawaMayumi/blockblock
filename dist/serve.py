#!/usr/bin/env python3
"""Same as `python3 -m http.server`, but disables caching entirely.

The plain http.server sends no Cache-Control header at all, so mobile
Safari (and some carrier/network proxies) can silently keep serving an old
cached copy of app.js/styles.css across visits to the same tunnel URL —
even after the files on disk have changed — with no visible error. That's
exactly the kind of thing that looks like "my fix isn't doing anything" on
a real device while a fresh headless browser (which doesn't carry that
cache) sees the latest version correctly. This script exists purely to
rule that out during development.
"""
import http.server
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(HandlerClass=NoCacheHandler, port=port)
