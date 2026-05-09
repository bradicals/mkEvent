#!/usr/bin/env python3
"""mkEvent local API proxy — forwards browser requests to ClickBid API, bypassing CORS.

Usage:
    python3 proxy-server.py [--port PORT] [--host HOST]

The proxy accepts POST /proxy with JSON body:
    {"url": "https://cbodev2.com/api/v4/...", "method": "GET", "headers": {"Authorization": "Bearer ...", ...}}
Returns the upstream response: status, headers, body.
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

DEFAULT_PORT = 9999
DEFAULT_HOST = "127.0.0.1"


class ProxyHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """CORS preflight — allow the browser prototype to call the proxy."""
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path != "/proxy":
            self.send_error(404, "Only /proxy is supported")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_length) if content_length else b"{}"

        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON body")
            return

        url = body.get("url", "")
        method = body.get("method", "GET").upper()
        headers = body.get("headers", {}) or {}

        if not url:
            self.send_error(400, "Missing 'url' in request body")
            return

        try:
            req = urllib.request.Request(url, method=method)
            for key, value in headers.items():
                req.add_header(key, value)

            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                resp_body = resp.read().decode("utf-8", errors="replace")

        except urllib.error.HTTPError as err:
            status = err.code
            resp_headers = dict(err.headers) if err.headers else {}
            resp_body = err.read().decode("utf-8", errors="replace")

        except urllib.error.URLError as err:
            status = 0
            resp_headers = {}
            resp_body = json.dumps({"error": "proxy_unreachable", "message": str(err.reason)})

        except Exception as err:
            status = 0
            resp_headers = {}
            resp_body = json.dumps({"error": "proxy_error", "message": str(err)})

        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        payload = json.dumps({
            "status": status,
            "headers": resp_headers,
            "body": resp_body,
        })
        self.wfile.write(payload.encode("utf-8"))

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        print(f"[proxy] {args[0]}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="mkEvent API proxy")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()

    server = HTTPServer((args.host, args.port), ProxyHandler)
    print(f"mkEvent proxy listening on http://{args.host}:{args.port}/proxy", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
        server.server_close()


if __name__ == "__main__":
    main()
