#!/usr/bin/env python3
"""로컬 정적 서버 — python -m http.server 가 샌드박스에서 os.getcwd() 로 막혀서 직접 띄운다."""
import functools
import http.server
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 + keep-alive. 서비스 워커는 별도 연결로 스크립트를 받아가므로
    # 단일 스레드 서버로는 등록이 실패한다 (아래 ThreadingHTTPServer 와 한 쌍).
    protocol_version = "HTTP/1.1"

    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{".html": "text/html; charset=utf-8",
           ".js": "text/javascript; charset=utf-8",
           ".webmanifest": "application/manifest+json"}
    )

    def end_headers(self):
        # 편집 중 캐시 때문에 옛 파일이 뜨는 걸 막는다.
        # 단 서비스 워커 스크립트에는 no-store 를 붙이지 않는다 — 일부 브라우저가
        # 그 조합에서 등록 자체를 거부한다.
        if not self.path.rstrip("/").endswith("sw.js"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


handler = functools.partial(Handler, directory=ROOT)
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
server.allow_reuse_address = True
print("serving %s at http://127.0.0.1:%d" % (ROOT, PORT), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.shutdown()
