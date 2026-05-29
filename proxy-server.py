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
import datetime
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urljoin, urlparse

DEFAULT_PORT = 9999
DEFAULT_HOST = "127.0.0.1"
BROWSER_FALLBACK_SCRIPT = os.path.join(os.path.dirname(__file__), "browser-fallback.cjs")
DEBUG_LOG_PATH = os.path.join(os.path.dirname(__file__), "logs", "mkEvent-proxy.log")

# Trusted ClickBid QA environments — must match event-model.js ENVIRONMENTS.
TRUSTED_CLICKBID_HOSTS = frozenset({
    "cbo.bid",
    "cbotriage.bid",
    "cbodev.bid",
    "cbodev2.com",
    "cbodev3.com",
    "cbodev4.com",
})

REDACTED = "[REDACTED]"
SENSITIVE_KEYS = {"authorization", "orgtoken", "token", "adminpassword", "password"}


def _ensure_log_dir():
    os.makedirs(os.path.dirname(DEBUG_LOG_PATH), exist_ok=True)


def _redact_value(key, value):
    if key.lower() in SENSITIVE_KEYS:
        return REDACTED
    return value


def _sanitize_for_log(value):
    if isinstance(value, dict):
        return {str(k): _redact_value(str(k), _sanitize_for_log(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_for_log(v) for v in value]
    return value


def _trim_text(value, limit=2000):
    text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"… [truncated {len(text) - limit} chars]"


def _log_debug(event, **fields):
    record = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": event,
        **{key: _sanitize_for_log(value) for key, value in fields.items()},
    }
    _ensure_log_dir()
    with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _is_host_allowed(url_str, allowlist):
    """Return (True, hostname) if the URL's host is in the allowlist, else (False, hostname)."""
    try:
        parsed = urlparse(url_str)
        host = parsed.hostname or ""
        return bool(host) and host in allowlist, host
    except Exception:
        return False, ""


def _forward_request(url, method, headers, req_body, allowlist, max_redirects=5):
    """Forward one browser request upstream, following 307/308 redirects with method/body preserved."""
    data_bytes = None
    if req_body is not None:
        data_bytes = req_body.encode("utf-8") if isinstance(req_body, str) else json.dumps(req_body).encode("utf-8")

    current_url = url
    for _ in range(max_redirects + 1):
        allowed, hostname = _is_host_allowed(current_url, allowlist)
        if not allowed:
            raise PermissionError(
                f"Host '{hostname or '(unknown)'}' is not an allowed ClickBid target. "
                f"Allowed hosts: {', '.join(sorted(allowlist))}"
            )

        req = urllib.request.Request(current_url, data=data_bytes, method=method)
        for key, value in headers.items():
            req.add_header(key, value)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                resp_body = resp.read().decode("utf-8", errors="replace")
                return status, resp_headers, resp_body
        except urllib.error.HTTPError as err:
            status = err.code
            resp_headers = dict(err.headers) if err.headers else {}
            resp_body = err.read().decode("utf-8", errors="replace")

            if status in (307, 308):
                location = resp_headers.get("Location") or resp_headers.get("location")
                if location:
                    current_url = urljoin(current_url, location)
                    continue

            return status, resp_headers, resp_body

    raise RuntimeError(f"Too many redirects while forwarding {method} {url}")


def _run_browser_fallback(payload):
    if not os.path.exists(BROWSER_FALLBACK_SCRIPT):
        raise FileNotFoundError(f"Browser fallback script not found: {BROWSER_FALLBACK_SCRIPT}")

    def _browser_fallback_timeout_seconds(data):
        action = str(data.get("action") or "")
        if action == "post-create-activity":
            activity = data.get("postCreateActivity") or {}
            ticket_purchases = activity.get("ticketPurchases") or {}
            auction_activity = activity.get("auctionActivity") or {}
            donation_activity = activity.get("donationActivity") or {}

            ticket_purchase_count = max(0, int(ticket_purchases.get("purchaseCount") or 0)) if ticket_purchases.get("enabled", True) else 0
            bid_count = max(0, int(auction_activity.get("bidCount") or 0)) if auction_activity.get("enabled") else 0
            max_bid_count = max(0, int(auction_activity.get("maxBidCount") or 0)) if auction_activity.get("enabled") else 0
            direct_donation_count = max(0, int(donation_activity.get("donationCount") or 0)) if donation_activity.get("enabled") else 0

            timeout = (
                180
                + (ticket_purchase_count * 35)
                + ((bid_count + max_bid_count) * 6)
                + (direct_donation_count * 6)
            )
            return max(300, min(1200, timeout))

        if action == "post-item-config":
            return 300

        return 300

    timeout_seconds = _browser_fallback_timeout_seconds(payload)

    _log_debug(
        "browser_fallback_launch",
        script=BROWSER_FALLBACK_SCRIPT,
        timeout_seconds=timeout_seconds,
        payload={
            "baseUrl": payload.get("baseUrl"),
            "organizationId": payload.get("organizationId"),
            "browser": payload.get("browser"),
            "adminEmail": payload.get("adminEmail"),
            "adminPassword": payload.get("adminPassword"),
            "event": payload.get("event"),
            "auctionSettings": payload.get("auctionSettings"),
        },
    )

    proc = subprocess.run(
        ["node", BROWSER_FALLBACK_SCRIPT],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )

    _log_debug(
        "browser_fallback_exit",
        returncode=proc.returncode,
        stdout=_trim_text(proc.stdout or ""),
        stderr=_trim_text(proc.stderr or ""),
    )

    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "browser fallback failed").strip())

    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as err:
        raise RuntimeError(f"Browser fallback returned invalid JSON: {err}") from err


class ProxyHandler(BaseHTTPRequestHandler):
    allowed_hosts = TRUSTED_CLICKBID_HOSTS

    def do_OPTIONS(self):
        """CORS preflight."""
        self._send_json(204, {"ok": True})

    def do_POST(self):
        if self.path == "/fallback/create-event":
            self._handle_browser_fallback_create_event()
            return
        if self.path == "/fallback/post-item-config":
            self._handle_browser_fallback_post_item_config()
            return
        if self.path == "/fallback/post-create-activity":
            self._handle_browser_fallback_post_create_activity()
            return

        if self.path != "/proxy":
            self._send_json_error(404, "Only /proxy, /fallback/create-event, /fallback/post-item-config, and /fallback/post-create-activity are supported")
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

        _log_debug(
            "proxy_request",
            path=self.path,
            method=method,
            url=url,
            headers=headers,
            has_body=req_body is not None,
        )

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
            status, resp_headers, resp_body = _forward_request(
                url,
                method,
                headers,
                req_body,
                self.allowed_hosts,
            )

        except PermissionError as err:
            self._send_json_error(403, str(err))
            return

        except urllib.error.URLError as err:
            self._send_json_error(502, f"Unreachable: {err.reason}", error_code="proxy_unreachable")
            return

        except Exception as err:
            self._send_json_error(502, str(err), error_code="proxy_error")
            return

        self._send_json(200, {
            "status": status,
            "headers": resp_headers,
            "body": resp_body,
        })
        _log_debug(
            "proxy_response",
            path=self.path,
            method=method,
            url=url,
            upstream_status=status,
            response_body=_trim_text(resp_body),
        )

    def _handle_browser_fallback_create_event(self):
        self._handle_browser_fallback("create-event", ["baseUrl", "organizationId", "browser", "adminEmail", "adminPassword", "event"])

    def _handle_browser_fallback_post_item_config(self):
        self._handle_browser_fallback("post-item-config", ["baseUrl", "organizationId", "browser", "adminEmail", "adminPassword", "eventId"])

    def _handle_browser_fallback_post_create_activity(self):
        self._handle_browser_fallback("post-create-activity", ["baseUrl", "organizationId", "browser", "adminEmail", "adminPassword", "eventId", "eventSlug"])

    def _handle_browser_fallback(self, action_name, required):
        content_length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_length) if content_length else b"{}"

        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_fallback_error(400, "Invalid JSON body")
            return

        _log_debug(
            "fallback_request",
            path=self.path,
            payload={
                "action": action_name,
                "baseUrl": payload.get("baseUrl"),
                "organizationId": payload.get("organizationId"),
                "browser": payload.get("browser"),
                "adminEmail": payload.get("adminEmail"),
                "adminPassword": payload.get("adminPassword"),
                "event": payload.get("event"),
                "eventId": payload.get("eventId"),
                "auctionSettings": payload.get("auctionSettings"),
                "quantityItems": payload.get("quantityItems"),
                "ticketPages": payload.get("ticketPages"),
            },
        )

        missing = [key for key in required if not payload.get(key)]
        if missing:
            self._send_fallback_error(400, f"Missing browser fallback fields: {', '.join(missing)}")
            return

        allowed, hostname = _is_host_allowed(payload.get("baseUrl", ""), self.allowed_hosts)
        if not allowed:
            self._send_fallback_error(
                403,
                f"Host '{hostname or '(unknown)'}' is not an allowed ClickBid target. "
                f"Allowed hosts: {', '.join(sorted(self.allowed_hosts))}",
            )
            return

        try:
            result = _run_browser_fallback({**payload, "action": action_name})
        except subprocess.TimeoutExpired:
            self._send_fallback_error(504, "Browser fallback timed out", error_code="browser_fallback_timeout")
            return
        except Exception as err:
            self._send_fallback_error(502, str(err), error_code="browser_fallback_error")
            return

        self._send_json(200, result)
        _log_debug("fallback_response", path=self.path, result=result)

    # ── helpers ──────────────────────────────────────────────────────────

    def _send_json(self, http_status, data):
        self.send_response(http_status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def _send_json_error(self, http_status, message, error_code=None):
        error_body = {"error": error_code or f"http_{http_status}", "message": str(message)}
        self._send_json(http_status, {
            "status": http_status,
            "headers": {},
            "body": json.dumps(error_body),
        })
        self.log_message("ERROR %d — %s", http_status, message)

    def _send_fallback_error(self, http_status, message, error_code=None):
        """Direct error shape for /fallback/* routes — no upstream envelope."""
        self._send_json(http_status, {
            "ok": False,
            "error": error_code or f"http_{http_status}",
            "message": str(message),
        })
        self.log_message("ERROR %d — %s", http_status, message)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        message = format % args if args else format
        print(f"[proxy] {message}", file=sys.stderr)
        _log_debug("proxy_log", message=message)


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
    _log_debug("proxy_start", host=args.host, port=args.port, allowed_hosts=sorted(allowed), log_path=DEBUG_LOG_PATH)

    # ThreadingHTTPServer handles each request in its own thread, so a slow
    # upstream call (e.g. an intermittently slow ClickBid list endpoint) cannot
    # block other concurrent proxy requests behind it.
    server = ThreadingHTTPServer((args.host, args.port), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", file=sys.stderr)
        _log_debug("proxy_stop", reason="KeyboardInterrupt")
        server.server_close()


if __name__ == "__main__":
    main()
