'use strict';

const http = require('node:http');
const fs = require('node:fs');

const DEFAULT_PORT = 9999;
const DEFAULT_HOST = '127.0.0.1';

// Must match event-model.js ENVIRONMENTS / proxy-server.py TRUSTED_CLICKBID_HOSTS.
const TRUSTED_CLICKBID_HOSTS = new Set([
  'cbo.bid',
  'cbotriage.bid',
  'cbodev.bid',
  'cbodev2.com',
  'cbodev3.com',
  'cbodev4.com',
]);

const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set(['authorization', 'orgtoken', 'token', 'adminpassword', 'password']);

// Required fields per fallback route (mirrors proxy-server.py).
const FALLBACK_REQUIRED = {
  'create-event': ['baseUrl', 'organizationId', 'browser', 'adminEmail', 'adminPassword', 'event'],
  'post-item-config': ['baseUrl', 'organizationId', 'browser', 'adminEmail', 'adminPassword', 'eventId'],
  'post-create-activity': ['baseUrl', 'organizationId', 'browser', 'adminEmail', 'adminPassword', 'eventId', 'eventSlug'],
  'create-event-http': ['baseUrl', 'organizationId', 'adminEmail', 'adminPassword', 'event'],
  'post-item-config-http': ['baseUrl', 'organizationId', 'adminEmail', 'adminPassword', 'eventId'],
};

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(String(k).toLowerCase()) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}

function isHostAllowed(urlStr, allowlist) {
  try {
    const host = new URL(urlStr).hostname || '';
    return { allowed: Boolean(host) && allowlist.has(host), host };
  } catch (_) {
    return { allowed: false, host: '' };
  }
}

// Return the last n non-trailing-blank lines of a UTF-8 file. Missing file or
// n <= 0 yields []. Mirrors proxy-server.py tail_lines (the proxy log stays
// small per session, so reading the whole file is fine).
function tailLines(filePath, n) {
  if (!filePath || n <= 0) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

function allowlistText(allowlist) {
  return [...allowlist].sort().join(', ');
}

// Forward one request upstream, re-checking the allowlist on every 307/308 hop (mirrors proxy-server.py).
async function forwardRequest(url, method, headers, reqBody, allowlist, maxRedirects = 5) {
  let currentUrl = url;
  const body = reqBody == null
    ? undefined
    : (typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody));

  for (let i = 0; i <= maxRedirects; i += 1) {
    const pre = isHostAllowed(currentUrl, allowlist);
    if (!pre.allowed) {
      const err = new Error(`Host '${pre.host || '(unknown)'}' is not an allowed ClickBid target. Allowed hosts: ${allowlistText(allowlist)}`);
      err.code = 'host_not_allowed';
      throw err;
    }

    const resp = await fetch(currentUrl, {
      method,
      headers,
      body: (method === 'GET' || method === 'HEAD') ? undefined : body,
      redirect: 'manual',
    });

    if (resp.status === 307 || resp.status === 308) {
      const location = resp.headers.get('location');
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }

    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    const respBody = await resp.text();
    return { status: resp.status, headers: respHeaders, body: respBody };
  }
  throw new Error(`Too many redirects while forwarding ${method} ${url}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendProxyError(res, status, message, errorCode) {
  sendJson(res, status, {
    status,
    headers: {},
    body: JSON.stringify({ error: errorCode || `http_${status}`, message: String(message) }),
  });
}

function sendFallbackError(res, status, message, errorCode, extra) {
  sendJson(res, status, { ok: false, error: errorCode || `http_${status}`, message: String(message), ...(extra || {}) });
}

function createProxyServer(options = {}) {
  const allowlist = new Set([...TRUSTED_CLICKBID_HOSTS, ...(options.allowlist || [])]);
  const runBrowserFallback = options.runBrowserFallback;
  const runHttpAdmin = options.runHttpAdmin;
  const logPath = options.logPath || null;
  const log = options.logger || (() => {});

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { sendJson(res, 204, { ok: true }); return; }
      if (req.method === 'GET') {
        const getPath = (req.url || '').split('?')[0];
        if (getPath === '/health') {
          sendJson(res, 200, { ok: true, service: 'mkEvent-proxy' });
          return;
        }
        if (getPath === '/debug/logs') {
          // Tail the proxy log so the renderer's "Copy debug report" works in the
          // packaged app (replaces proxy-server.py's GET /debug/logs).
          let requested = 500;
          try {
            const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('lines');
            if (q != null) requested = parseInt(q, 10);
          } catch (_) { /* keep default */ }
          if (!Number.isFinite(requested)) requested = 500;
          const count = Math.max(0, Math.min(requested, 5000));
          const lines = tailLines(logPath, count);
          sendJson(res, 200, { logPath, returned: lines.length, lines });
          return;
        }
        sendProxyError(res, 404, 'Only GET /health and /debug/logs are supported');
        return;
      }
      if (req.method !== 'POST') { sendProxyError(res, 404, 'Only /proxy and /fallback/* are supported'); return; }

      const action = req.url && req.url.startsWith('/fallback/') ? req.url.slice('/fallback/'.length) : null;
      const isFallback = Boolean(action && FALLBACK_REQUIRED[action]);

      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (_) {
        if (isFallback) sendFallbackError(res, 400, 'Invalid JSON body');
        else sendProxyError(res, 400, 'Invalid JSON body');
        return;
      }

      if (isFallback) {
        log('fallback_request', { action, ...redactSensitive(body) });
        const missing = FALLBACK_REQUIRED[action].filter((k) => !body[k]);
        if (missing.length) { sendFallbackError(res, 400, `Missing browser fallback fields: ${missing.join(', ')}`); return; }
        const host = isHostAllowed(body.baseUrl || '', allowlist);
        if (!host.allowed) { sendFallbackError(res, 403, `Host '${host.host || '(unknown)'}' is not an allowed ClickBid target. Allowed hosts: ${allowlistText(allowlist)}`); return; }
        if (action.endsWith('-http')) {
          if (typeof runHttpAdmin !== 'function') { sendFallbackError(res, 501, 'HTTP admin runner is not configured', 'http_admin_unavailable'); return; }
          try {
            const result = await runHttpAdmin(action, body, allowlist);
            sendJson(res, 200, result);
          } catch (err) {
            // eventLikelyCreated must survive serialization: it's the renderer's
            // signal not to retry via browser fallback and create a duplicate.
            const extra = err && err.eventLikelyCreated ? { eventLikelyCreated: true } : undefined;
            sendFallbackError(res, 502, (err && err.message) || 'http admin failed', 'http_admin_error', extra);
          }
          return;
        }
        if (typeof runBrowserFallback !== 'function') { sendFallbackError(res, 501, 'Browser fallback runner is not configured', 'browser_fallback_unavailable'); return; }
        try {
          const result = await runBrowserFallback({ ...body, action });
          sendJson(res, 200, result);
        } catch (err) {
          const timedOut = err && err.code === 'timeout';
          sendFallbackError(res, timedOut ? 504 : 502, (err && err.message) || 'browser fallback failed', timedOut ? 'browser_fallback_timeout' : 'browser_fallback_error');
        }
        return;
      }

      if (req.url !== '/proxy') { sendProxyError(res, 404, 'Only /proxy and /fallback/* are supported'); return; }

      const url = body.url || '';
      const method = String(body.method || 'GET').toUpperCase();
      const headers = body.headers || {};
      const reqBody = body.body == null ? null : body.body;
      log('proxy_request', { method, url, headers: redactSensitive(headers) });

      if (!url) { sendProxyError(res, 400, "Missing 'url' in request body"); return; }
      const pre = isHostAllowed(url, allowlist);
      if (!pre.allowed) { sendProxyError(res, 403, `Host '${pre.host || '(unknown)'}' is not an allowed ClickBid target. Allowed hosts: ${allowlistText(allowlist)}`); return; }

      try {
        const upstream = await forwardRequest(url, method, headers, reqBody, allowlist);
        sendJson(res, 200, upstream);
        log('proxy_response', { method, url, upstream_status: upstream.status });
      } catch (err) {
        if (err && err.code === 'host_not_allowed') sendProxyError(res, 403, err.message);
        else sendProxyError(res, 502, (err && err.message) || 'proxy error', 'proxy_error');
      }
    } catch (err) {
      try { sendProxyError(res, 500, (err && err.message) || 'internal error', 'proxy_internal'); } catch (_) {}
    }
  });
}

function startProxyServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port == null ? DEFAULT_PORT : options.port;
  const server = createProxyServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// Shut the proxy server down promptly.
//
// The renderer (Chromium) holds HTTP keep-alive sockets to this server, and a
// plain server.close() will NOT drop idle keep-alive connections — it waits for
// them to close on their own (up to keepAliveTimeout). During an auto-update
// that delay keeps the main process alive long enough for the NSIS installer to
// report "mkEvent cannot be closed". closeAllConnections() force-drops every
// socket so close() can complete immediately; a timeout is a final safety net so
// shutdown can never hang.
function closeServer(server, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // close() first so the server stops accepting connections, THEN drop the
    // remaining keep-alive/idle sockets — otherwise a new connection could slip
    // in after closeAllConnections() and before close(), and close() would wait
    // on it.
    try { server.close(() => finish()); } catch (_) { finish(); return; }
    try { server.closeAllConnections?.(); } catch (_) { /* older runtimes */ }
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

module.exports = {
  createProxyServer,
  startProxyServer,
  closeServer,
  forwardRequest,
  isHostAllowed,
  redactSensitive,
  tailLines,
  TRUSTED_CLICKBID_HOSTS,
  DEFAULT_HOST,
  DEFAULT_PORT,
};
