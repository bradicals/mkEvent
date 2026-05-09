#!/usr/bin/env python3
"""mkEvent local API proxy — forwards browser requests to ClickBid API, bypassing CORS.

Usage:
    python3 proxy-server.py [--port PORT] [--host HOST] [--allowlist HOST ...]

The proxy accepts POST /proxy with JSON body:
    {"url": "https://cbodev2.com/api/v4/...", "method": "GET", "headers": {"Authorization": "Bearer ...", ...}}
Returns the upstream response: status, headers, body.

Only URLs whose hostname matches a trusted ClickBid host are forwarded.
All other targets are rejected.
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

DEFAULT_PORT = 9999
DEFAULT_HOST = "127.0.0.1"

# Trusted ClickBid QA environments — must match event-model.js ENVIRONMENTS.
TRUSTED_CLICKBID_HOSTS = frozenset({
    "cbo.bid",
    "cbotriage.bid",
    "cbodev.bid",
    "cbodev2.com",
    "cbodev3.com",
    "cbodev4.com",
})


def _is_host_allowed(url_str, allowlist):
    """Return (True, hostname) if the URL's host is in the allowlist, else (False, hostname)."""
    try:
        parsed = urlparse(url_str)
        host = parsed.hostname or ""
        return bool(host) and host in allowlist, host
    except Exception:
        return False, ""


class ProxyHandler(BaseHTTPRequestHandler):
    allowed_hosts = TRUSTED_CLICKBID_HOSTS

    def do_OPTIONS(self):
        """CORS preflight."""
        self._send_json(204, {"ok": True})

    def do_POST(self):
        if self.path != "/proxy":
            self._send_json_error(404, "Only /proxy is supported")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_length) if content_length else b"{}"

        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json_error(400, "Invalid JSON body")
            return

        url = body.get("url", "")
        method = body.get("method", "GET").upper()
        headers = body.get("headers", {}) or {}
        req_body = body.get("body", None)

        if not url:
            self._send_json_error(400, "Missing 'url' in request body")
            return

        allowed, hostname = _is_host_allowed(url, self.allowed_hosts)
        if not allowed:
            self._send_json_error(
                403,
                f"Host '{hostname or '(unknown)'}' is not an allowed ClickBid target. "
                f"Allowed hosts: {', '.join(sorted(self.allowed_hosts))}",
            )
            return

        try:
            data_bytes = None
            if req_body is not None:
                data_bytes = req_body.encode("utf-8") if isinstance(req_body, str) else json.dumps(req_body).encode("utf-8")

            req = urllib.request.Request(url, data=data_bytes, method=method)
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
            self._send_json_error(0, f"Unreachable: {err.reason}", error_code="proxy_unreachable")
            return

        except Exception as err:
            self._send_json_error(0, str(err), error_code="proxy_error")
            return

        self._send_json(200, {
            "status": status,
            "headers": resp_headers,
            "body": resp_body,
        })

    # ── helpers ──────────────────────────────────────────────────────────

    def _send_json(self, http_status, data):
        self.send_response(http_status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _send_json_error(self, http_status, message, error_code=None):
        error_body = {"error": error_code or f"http_{http_status}", "message": str(message)}
        self.send_response(http_status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(error_body).encode("utf-8"))
        self.log_message("ERROR %d — %s", http_status, message)

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
    parser.add_argument("--allowlist", nargs="*", default=[],
                        help="Additional allowed hosts beyond the built-in ClickBid QA set")
    args = parser.parse_args()

    allowed = set(TRUSTED_CLICKBID_HOSTS)
    allowed.update(args.allowlist)
    ProxyHandler.allowed_hosts = frozenset(allowed)

    print(f"mkEvent proxy listening on http://{args.host}:{args.port}/proxy", file=sys.stderr)
    print(f"Allowed hosts: {', '.join(sorted(allowed))}", file=sys.stderr)

    server = HTTPServer((args.host, args.port), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
        server.server_close()


if __name__ == "__main__":
    main()
