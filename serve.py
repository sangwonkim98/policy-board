#!/usr/bin/env python3
"""로컬 정적 서버 — python -m http.server 가 샌드박스에서 os.getcwd() 로 막혀서 직접 띄운다."""
import functools
import http.server
import os
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8"}
    )

    def end_headers(self):
        # 편집 중 캐시 때문에 옛 파일이 뜨는 걸 막는다
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


socketserver.TCPServer.allow_reuse_address = True
handler = functools.partial(Handler, directory=ROOT)
with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
    print("serving %s at http://127.0.0.1:%d" % (ROOT, PORT), flush=True)
    httpd.serve_forever()
