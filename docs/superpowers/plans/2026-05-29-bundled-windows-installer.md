# Bundled Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship mkEvent as a single zero-prerequisite Windows installer (no Python, no manual Playwright install) and prove a fresh install launches cleanly via a scripted Windows Sandbox smoke test.

**Architecture:** Replace the Python CORS proxy with an in-process Node HTTP proxy hosted by the Electron main process (same `127.0.0.1:9999` contract the renderer already uses), bundle Playwright's Chromium as an unpacked resource, package with electron-builder (NSIS), and validate with a Windows Sandbox `.wsb` harness that installs silently and runs the app in a headless `--smoke-check` mode (proxy health + Chromium launch).

**Tech Stack:** Electron 31, electron-builder (NSIS), Node `node:test` + `node:http`, Playwright (Chromium), Windows Sandbox + PowerShell.

---

## Background: verified current behavior (read before starting)

- The renderer calls the proxy via `apiProxyCall` (`event-model.js:1554-1581`): `POST <proxyUrl>` with JSON `{ url, method, headers, body? }`, and expects a JSON reply shaped `{ status, headers, body }`. The proxy URL is fixed to `http://localhost:9999/proxy` (read-only field, `sections.jsx:1332`).
- The Python proxy (`proxy-server.py`) implements: `POST /proxy` (host-allowlisted forward, follows only `307/308` re-checking the allowlist each hop, returns `{status, headers, body}`); `POST /fallback/create-event|post-item-config|post-create-activity` (validates required fields + host, runs the browser fallback, returns its JSON); `OPTIONS` (CORS 204). Error envelope for `/proxy` is `{status, headers:{}, body: JSON.stringify({error, message})}` with the HTTP status set to the error code; for `/fallback/*` it is `{ok:false, error, message}`. Sensitive keys (`authorization, orgtoken, token, adminpassword, password`) are redacted in logs.
- The Python proxy launches the fallback as `subprocess(['node', browser-fallback.cjs])`, writing the payload JSON to **stdin** and reading the result JSON from **stdout** (`proxy-server.py:179-201`). `browser-fallback.cjs:2866-2873` `main()` reads stdin JSON, dispatches on `payload.action`, writes result JSON to stdout, exits non-zero on error. The fallback timeout is computed in `proxy-server.py:136-160`.
- Electron currently spawns Python: `src/main/proxy-manager.cjs:58-85` (`startProxy`/`stopProxy`/`getProxyState`). `src/main/index.cjs` boots, calls `startProxy`, shows a warning dialog if it fails, then `createWindow()` which `loadURL`s `MKEVENT_RENDERER_URL` (dev) or `file://.../dist/index.html` (packaged). Vite `base: './'` (`vite.config.mjs`) so the built renderer uses relative asset paths — safe to load from `file://`/asar.
- `browser-fallback.cjs:42-62` resolves Playwright via `MKEVENT_PLAYWRIGHT_MODULE` env or `require('playwright')`, and launches `chromium` headless. Playwright finds its browser binary via the `PLAYWRIGHT_BROWSERS_PATH` env (standard Playwright behavior).
- Test runner: `package.json` `"test": "node --test"`; existing tests are `*.test.js` using CommonJS (`type: commonjs`).

**Decision:** keep `proxy-server.py` on disk as a legacy artifact for the old browser-only flow, but the Electron app will no longer use or require it. Nothing in this plan executes Python.

---

## File Structure

- **Create** `src/main/proxy-server.cjs` — in-process Node HTTP proxy; pure (no Electron import) so it is unit-testable. Exposes `createProxyServer`, `startProxyServer`, `forwardRequest`, `isHostAllowed`, `redactSensitive`, constants.
- **Create** `src/main/proxy-server.test.cjs` — `node:test` unit tests for the proxy module.
- **Create** `src/main/smoke-check.cjs` — `runSmokeCheck()`: probes `GET /health` and launches+closes bundled Chromium; writes a JSON result file.
- **Modify** `src/main/proxy-manager.cjs` — start the in-process Node proxy and provide the browser-fallback runner (Electron `process.execPath` + `ELECTRON_RUN_AS_NODE`); drop the Python spawn. Keep the `startProxy`/`stopProxy`/`getProxyState` interface.
- **Modify** `src/main/index.cjs` — add `--smoke-check` headless mode; set `PLAYWRIGHT_BROWSERS_PATH` when packaged; update the failure dialog text.
- **Modify** `package.json` — add `electron-builder` devDep, the `build` config (NSIS, signing-ready), and `dist:win` script.
- **Create** `sandbox/mkEvent-smoke.wsb` — Windows Sandbox config (mapped installer + results folders, logon command).
- **Create** `sandbox/run-smoke.ps1` — installs silently, runs `--smoke-check`, writes `PASS`/`FAIL`.
- **Modify** `README.md` — Windows end-user install steps, drop Python from end-user requirements, SmartScreen "Run anyway" note.

> Sandbox files live under `sandbox/` (not `test/`) so the `node --test` runner never tries to execute `.ps1`/`.wsb`.

---

## Task 1: In-process Node proxy module (TDD)

**Files:**
- Create: `src/main/proxy-server.cjs`
- Test: `src/main/proxy-server.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `src/main/proxy-server.test.cjs`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  startProxyServer,
  redactSensitive,
  isHostAllowed,
  TRUSTED_CLICKBID_HOSTS,
} = require('./proxy-server.cjs');

// Start the proxy on an ephemeral port; allow 127.0.0.1 so tests can use a mock upstream.
async function withProxy(opts, run) {
  const server = await startProxyServer({ port: 0, allowlist: ['127.0.0.1'], ...opts });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A throwaway upstream that echoes a known payload.
async function withUpstream(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('default allowlist contains the six ClickBid hosts', () => {
  assert.deepStrictEqual(
    [...TRUSTED_CLICKBID_HOSTS].sort(),
    ['cbo.bid', 'cbodev.bid', 'cbodev2.com', 'cbodev3.com', 'cbodev4.com', 'cbotriage.bid'],
  );
});

test('redactSensitive masks sensitive keys, including nested', () => {
  const out = redactSensitive({
    Authorization: 'Bearer x',
    nested: { adminPassword: 'p', keep: 'v' },
    list: [{ token: 't' }],
  });
  assert.strictEqual(out.Authorization, '[REDACTED]');
  assert.strictEqual(out.nested.adminPassword, '[REDACTED]');
  assert.strictEqual(out.nested.keep, 'v');
  assert.strictEqual(out.list[0].token, '[REDACTED]');
});

test('isHostAllowed allows trusted host, denies others and garbage', () => {
  assert.strictEqual(isHostAllowed('https://cbo.bid/api/v4/x', TRUSTED_CLICKBID_HOSTS).allowed, true);
  assert.strictEqual(isHostAllowed('https://evil.example.com/x', TRUSTED_CLICKBID_HOSTS).allowed, false);
  assert.strictEqual(isHostAllowed('not-a-url', TRUSTED_CLICKBID_HOSTS).allowed, false);
});

test('GET /health returns ok', async () => {
  await withProxy({}, async (base) => {
    const res = await fetch(`${base}/health`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
  });
});

test('POST /proxy forwards to an allowed upstream and returns {status,headers,body}', async () => {
  await withUpstream((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Echo': 'yes' });
    res.end(JSON.stringify({ seen: req.method }));
  }, async (upstreamBase) => {
    await withProxy({}, async (proxyBase) => {
      const res = await fetch(`${proxyBase}/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${upstreamBase}/api`, method: 'POST', headers: {}, body: { a: 1 } }),
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.status, 201);
      assert.strictEqual(json.headers['x-echo'], 'yes');
      assert.deepStrictEqual(JSON.parse(json.body), { seen: 'POST' });
    });
  });
});

test('POST /proxy rejects a disallowed host with a 403 envelope', async () => {
  await withProxy({}, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example.com/x', method: 'GET' }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.status, 403);
    assert.ok(JSON.parse(json.body).message.includes('not an allowed'));
  });
});

test('POST /proxy returns 400 when url is missing', async () => {
  await withProxy({}, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET' }),
    });
    assert.strictEqual(res.status, 400);
  });
});

test('POST /fallback/create-event validates required fields', async () => {
  await withProxy({ runBrowserFallback: async () => ({ ok: true }) }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/create-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://cbo.bid' }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.ok, false);
    assert.ok(json.message.includes('Missing browser fallback fields'));
  });
});

test('POST /fallback/create-event invokes the injected runner and returns its result', async () => {
  let received = null;
  const runner = async (payload) => { received = payload; return { ok: true, eventId: '42' }; };
  await withProxy({ runBrowserFallback: runner }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/create-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://cbo.bid', organizationId: '1', browser: 'chromium',
        adminEmail: 'a@b.c', adminPassword: 'pw', event: { name: 'x' },
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.eventId, '42');
    assert.strictEqual(received.action, 'create-event');
  });
});

test('unknown path returns 404', async () => {
  await withProxy({}, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/nope`, { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/main/proxy-server.test.cjs`
Expected: FAIL — `Cannot find module './proxy-server.cjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/proxy-server.cjs`:

```js
'use strict';

const http = require('node:http');

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

function sendFallbackError(res, status, message, errorCode) {
  sendJson(res, status, { ok: false, error: errorCode || `http_${status}`, message: String(message) });
}

function createProxyServer(options = {}) {
  const allowlist = new Set([...TRUSTED_CLICKBID_HOSTS, ...(options.allowlist || [])]);
  const runBrowserFallback = options.runBrowserFallback;
  const log = options.logger || (() => {});

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { sendJson(res, 204, { ok: true }); return; }
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, service: 'mkEvent-proxy' });
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

module.exports = {
  createProxyServer,
  startProxyServer,
  forwardRequest,
  isHostAllowed,
  redactSensitive,
  TRUSTED_CLICKBID_HOSTS,
  DEFAULT_HOST,
  DEFAULT_PORT,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/main/proxy-server.test.cjs`
Expected: PASS — all 10 tests pass.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — existing suites plus the new proxy tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/proxy-server.cjs src/main/proxy-server.test.cjs
git commit -m "feat(proxy): in-process Node proxy module with tests"
```

---

## Task 2: Wire the Node proxy into Electron; drop Python; add --smoke-check

**Files:**
- Modify: `src/main/proxy-manager.cjs` (full rewrite)
- Create: `src/main/smoke-check.cjs`
- Modify: `src/main/index.cjs`

- [ ] **Step 1: Rewrite `proxy-manager.cjs` to host the Node proxy and run the fallback via Electron-as-Node**

Replace the entire contents of `src/main/proxy-manager.cjs` with:

```js
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { startProxyServer } = require('./proxy-server.cjs');

let server = null;
let proxyState = { started: false, command: 'node-inproc', pid: null, reason: '' };

// Mirror of proxy-server.py _browser_fallback_timeout_seconds, in milliseconds.
function browserFallbackTimeoutMs(payload) {
  const action = String(payload.action || '');
  if (action === 'post-create-activity') {
    const a = payload.postCreateActivity || {};
    const tp = a.ticketPurchases || {};
    const au = a.auctionActivity || {};
    const dn = a.donationActivity || {};
    const tpc = (tp.enabled !== false) ? Math.max(0, Number(tp.purchaseCount) || 0) : 0;
    const bc = au.enabled ? Math.max(0, Number(au.bidCount) || 0) : 0;
    const mbc = au.enabled ? Math.max(0, Number(au.maxBidCount) || 0) : 0;
    const ddc = dn.enabled ? Math.max(0, Number(dn.donationCount) || 0) : 0;
    const t = 180 + (tpc * 35) + ((bc + mbc) * 6) + (ddc * 6);
    return Math.max(300, Math.min(1200, t)) * 1000;
  }
  return 300 * 1000;
}

function resourceRoot() {
  // Packaged: resources/. Dev: project root (two levels up from src/main).
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}

function browserFallbackScriptPath() {
  // browser-fallback.cjs is asarUnpack'd, so resolve it under app.asar.unpacked when packaged.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'browser-fallback.cjs');
  }
  return path.join(__dirname, '..', '..', 'browser-fallback.cjs');
}

// Run browser-fallback.cjs as a Node script using the Electron binary (ELECTRON_RUN_AS_NODE).
function runBrowserFallback(payload) {
  return new Promise((resolve, reject) => {
    const scriptPath = browserFallbackScriptPath();
    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`Browser fallback script not found: ${scriptPath}`));
      return;
    }

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (app.isPackaged) {
      env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
    }

    const child = spawn(process.execPath, [scriptPath], {
      cwd: resourceRoot(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      const err = new Error('Browser fallback timed out');
      err.code = 'timeout';
      finish(reject, err);
    }, browserFallbackTimeoutMs(payload));

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0) { finish(reject, new Error((stderr || stdout || 'browser fallback failed').trim())); return; }
      try { finish(resolve, JSON.parse(stdout || '{}')); }
      catch (err) { finish(reject, new Error(`Browser fallback returned invalid JSON: ${err.message}`)); }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function makeFileLogger() {
  let logPath;
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'mkEvent-proxy.log');
  } catch (_) {
    logPath = null;
  }
  return (event, fields) => {
    if (!logPath) return;
    const record = JSON.stringify({ ts: new Date().toISOString(), event, ...(fields || {}) });
    try { fs.appendFileSync(logPath, record + '\n'); } catch (_) {}
  };
}

async function startProxy() {
  if (server) return proxyState;
  try {
    server = await startProxyServer({
      host: '127.0.0.1',
      port: 9999,
      runBrowserFallback,
      logger: makeFileLogger(),
    });
    proxyState = { started: true, command: 'node-inproc', pid: process.pid, reason: '' };
  } catch (err) {
    server = null;
    proxyState = { started: false, command: 'node-inproc', pid: null, reason: err.message };
  }
  return proxyState;
}

async function stopProxy() {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise((resolve) => current.close(() => resolve()));
  proxyState = { started: false, command: 'node-inproc', pid: null, reason: 'stopped' };
}

function getProxyState() {
  return proxyState;
}

module.exports = { getProxyState, startProxy, stopProxy };
```

- [ ] **Step 2: Create `src/main/smoke-check.cjs`**

```js
'use strict';

const http = require('node:http');
const fs = require('node:fs');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

function resolvePlaywright() {
  const explicit = process.env.MKEVENT_PLAYWRIGHT_MODULE;
  for (const candidate of [explicit, 'playwright', '@playwright/test'].filter(Boolean)) {
    try {
      const mod = require(candidate);
      if (mod.chromium) return mod;
      if (mod.playwright && mod.playwright.chromium) return mod.playwright;
    } catch (_) { /* try next */ }
  }
  throw new Error('Playwright module not resolvable for smoke check');
}

// Verifies the bundled engine: proxy answers + bundled Chromium launches and closes.
async function runSmokeCheck({ resultPath } = {}) {
  const checks = [];

  try {
    const r = await getJson('http://127.0.0.1:9999/health');
    checks.push({ name: 'proxy_health', ok: r.status === 200 && r.json && r.json.ok === true });
  } catch (err) {
    checks.push({ name: 'proxy_health', ok: false, error: String((err && err.message) || err) });
  }

  try {
    const { chromium } = resolvePlaywright();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await browser.close();
    checks.push({ name: 'chromium_launch', ok: true });
  } catch (err) {
    checks.push({ name: 'chromium_launch', ok: false, error: String((err && err.message) || err) });
  }

  const ok = checks.every((c) => c.ok);
  const result = { ok, checks, ts: new Date().toISOString() };
  if (resultPath) {
    try { fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); } catch (_) {}
  }
  return result;
}

module.exports = { runSmokeCheck };
```

- [ ] **Step 3: Update `src/main/index.cjs` for packaged browsers path and `--smoke-check`**

Replace the `boot` function and add the smoke helpers. Change `src/main/index.cjs` so the top reads:

```js
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { startProxy, stopProxy, getProxyState } = require('./proxy-manager.cjs');

const isDev = Boolean(process.env.MKEVENT_RENDERER_URL);
const isSmokeCheck = process.argv.includes('--smoke-check');

function smokeResultPath() {
  const arg = process.argv.find((a) => a.startsWith('--smoke-result='));
  return arg ? arg.slice('--smoke-result='.length) : null;
}
```

Then replace the existing `boot` function with:

```js
async function boot() {
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
  }

  const proxy = await startProxy();

  if (isSmokeCheck) {
    const { runSmokeCheck } = require('./smoke-check.cjs');
    const result = await runSmokeCheck({ resultPath: smokeResultPath() });
    await stopProxy();
    app.exit(result.ok ? 0 : 1);
    return;
  }

  if (!proxy.started) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'mkEvent proxy',
      message: 'mkEvent could not start its local proxy.',
      detail: proxy.reason || 'Please restart the app; if this persists, reinstall mkEvent.',
    }).catch(() => undefined);
  }

  createWindow();
}
```

> Note: `startProxy()` is now called with no argument (the manager resolves paths via `app.isPackaged`). The `createWindow`, `app.whenReady().then(boot)`, and lifecycle handlers below are unchanged.

- [ ] **Step 4: Verify the unit suite still passes (no Electron needed)**

Run: `npm test`
Expected: PASS — `proxy-server.test.cjs` is independent of Electron; nothing here breaks it.

- [ ] **Step 5: Manual dev smoke (on your dev machine, Playwright already installed)**

Run: `npm run electron:dev`
Expected: app window opens; Settings still shows `http://localhost:9999/proxy`; no Python process is started. Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/main/proxy-manager.cjs src/main/smoke-check.cjs src/main/index.cjs
git commit -m "feat(desktop): in-process proxy + electron-as-node fallback + --smoke-check"
```

---

## Task 3: electron-builder packaging (installer #1, no bundled Chromium yet — the RED build)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add electron-builder as a dev dependency**

Run (on the Windows host, from the `C:\` checkout): `npm install --save-dev electron-builder@^24`
Expected: `electron-builder` added to `devDependencies`.

- [ ] **Step 2: Add the build config and `dist:win` script to `package.json`**

Add a `"dist:win"` entry to `scripts`:

```json
"dist:win": "npm run build && electron-builder --win"
```

Add a top-level `"build"` block (sibling of `scripts`):

```json
"build": {
  "appId": "io.cbo.mkevent",
  "productName": "mkEvent",
  "directories": { "output": "release" },
  "files": [
    "dist/**/*",
    "src/main/**/*",
    "src/preload/**/*",
    "browser-fallback.cjs",
    "package.json"
  ],
  "asarUnpack": [
    "browser-fallback.cjs"
  ],
  "win": {
    "target": ["nsis"],
    "signtoolOptions": {}
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

> `win.signtoolOptions` is intentionally empty: the app ships **unsigned** for now. To enable signing later, populate it (e.g. `certificateFile` + `certificatePassword`/env, or `signtoolOptions.sign`) — no other change needed. Do not delete the empty object; it documents the intended hook.

- [ ] **Step 3: Build installer #1**

Run (Windows PowerShell, in the `C:\` checkout): `npm run dist:win`
Expected: a `release\mkEvent Setup <version>.exe` is produced. (`browser-fallback.cjs` is unpacked; Chromium is **not** bundled yet — this is deliberate.)

- [ ] **Step 4: Verify the artifact exists**

Run (PowerShell): `Get-ChildItem release\*.exe`
Expected: one `mkEvent Setup *.exe` listed.

- [ ] **Step 5: Commit (config only — do not commit `release/` or `node_modules/`)**

```bash
git add package.json package-lock.json
git commit -m "build: electron-builder NSIS config + dist:win (unsigned, signing-ready)"
```

> Add `release/` and `ms-playwright/` to `.gitignore` if not already ignored.

---

## Task 4: Windows Sandbox harness — first run is RED (proves Python removal, isolates Chromium gap)

**Files:**
- Create: `sandbox/run-smoke.ps1`
- Create: `sandbox/mkEvent-smoke.wsb`

- [ ] **Step 1: Write the Sandbox logon script**

Create `sandbox/run-smoke.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$installerDir = 'C:\mkEventInstaller'
$resultsDir   = 'C:\mkEventResults'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

function Write-Result($verdict, $detail) {
  "$verdict`n$detail" | Set-Content -Path (Join-Path $resultsDir 'result.txt')
}

try {
  $installer = Get-ChildItem -Path $installerDir -Filter '*.exe' | Select-Object -First 1
  if (-not $installer) { Write-Result 'FAIL' 'No installer .exe found in C:\mkEventInstaller'; exit 1 }

  # Simulate the real download experience so SmartScreen behavior is representative when run manually.
  try { Unblock-File -Path $installer.FullName -ErrorAction SilentlyContinue } catch {}

  # Silent install (NSIS). perMachine=false installs to LOCALAPPDATA\Programs\mkEvent.
  Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
  Start-Sleep -Seconds 5

  $exe = Join-Path $env:LOCALAPPDATA 'Programs\mkEvent\mkEvent.exe'
  if (-not (Test-Path $exe)) { Write-Result 'FAIL' "App not installed at $exe"; exit 1 }

  $resultJson = Join-Path $resultsDir 'smoke-result.json'
  if (Test-Path $resultJson) { Remove-Item $resultJson -Force }

  Start-Process -FilePath $exe -ArgumentList "--smoke-check --smoke-result=$resultJson" -Wait

  if (-not (Test-Path $resultJson)) { Write-Result 'FAIL' 'Smoke check produced no result file (app did not reach smoke mode)'; exit 1 }

  $r = Get-Content $resultJson -Raw | ConvertFrom-Json
  $summary = ($r.checks | ForEach-Object { "$($_.name)=$([bool]$_.ok)" }) -join ' '
  if ($r.ok) { Write-Result 'PASS' $summary; exit 0 } else { Write-Result 'FAIL' $summary; exit 1 }
}
catch {
  Write-Result 'FAIL' $_.Exception.Message
  exit 1
}
```

- [ ] **Step 2: Write the Sandbox config**

Create `sandbox/mkEvent-smoke.wsb` (edit the two `HostFolder` paths to match your `C:\` checkout location):

```xml
<Configuration>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\mkEvent\release</HostFolder>
      <SandboxFolder>C:\mkEventInstaller</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>C:\mkEvent\sandbox\results</HostFolder>
      <SandboxFolder>C:\mkEventResults</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>C:\mkEvent\sandbox</HostFolder>
      <SandboxFolder>C:\mkEventScripts</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -ExecutionPolicy Bypass -NoProfile -File C:\mkEventScripts\run-smoke.ps1</Command>
  </LogonCommand>
</Configuration>
```

- [ ] **Step 3: Create the host results folder**

Run (PowerShell): `New-Item -ItemType Directory -Force -Path C:\mkEvent\sandbox\results`
Expected: folder created (it receives `result.txt` / `smoke-result.json` from the Sandbox).

- [ ] **Step 4: Run the Sandbox smoke test against installer #1 — expect RED**

Double-click `sandbox\mkEvent-smoke.wsb` (or run `explorer.exe C:\mkEvent\sandbox\mkEvent-smoke.wsb`). Windows Sandbox boots fresh, installs, runs the smoke check, and closes/writes results.
Then on the host run: `Get-Content C:\mkEvent\sandbox\results\result.txt`
Expected: **`FAIL`** with summary `proxy_health=True chromium_launch=False`.
This is the intended RED: it proves the **Python dependency is gone** (the proxy started in-process and answered `/health` on a machine with no Python) and isolates the remaining gap to Chromium bundling.

- [ ] **Step 5: Commit**

```bash
git add sandbox/run-smoke.ps1 sandbox/mkEvent-smoke.wsb
git commit -m "test(sandbox): Windows Sandbox smoke harness (proxy health + chromium check)"
```

> Add `sandbox/results/` to `.gitignore`.

---

## Task 5: Bundle Playwright Chromium — turn the Sandbox test GREEN

**Files:**
- Modify: `package.json` (build config)

- [ ] **Step 1: Populate a local `ms-playwright` browser folder to bundle**

Run (Windows PowerShell, in the `C:\` checkout):

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\ms-playwright"
npx playwright install chromium
```

Expected: a `ms-playwright\chromium-*` folder is created under the project.

- [ ] **Step 2: Add Chromium bundling to the `build` config**

In `package.json` `build`, add `extraResources` and unpack Playwright so it resolves at runtime:

```json
"extraResources": [
  { "from": "ms-playwright", "to": "ms-playwright" }
],
"asarUnpack": [
  "browser-fallback.cjs",
  "node_modules/playwright/**",
  "node_modules/playwright-core/**"
]
```

> Replace the existing `asarUnpack` array from Task 3 with this expanded one. `extraResources` places the browser at `resources/ms-playwright`, which is exactly what `index.cjs`/`proxy-manager.cjs` set `PLAYWRIGHT_BROWSERS_PATH` to when `app.isPackaged`.

- [ ] **Step 3: Rebuild installer #2**

Run (PowerShell): `npm run dist:win`
Expected: a new `release\mkEvent Setup <version>.exe` containing the bundled Chromium (installer size noticeably larger).

- [ ] **Step 4: Re-run the Sandbox smoke test — expect GREEN**

Double-click `sandbox\mkEvent-smoke.wsb` again, then on the host:
Run: `Get-Content C:\mkEvent\sandbox\results\result.txt`
Expected: **`PASS`** with summary `proxy_health=True chromium_launch=True`.
This confirms the definition of done: a fresh, prerequisite-free Windows machine installs the app, the in-process proxy answers, and the bundled Chromium launches.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build: bundle Playwright Chromium as extraResources (Sandbox smoke green)"
```

---

## Task 6: Docs + manual SmartScreen verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Manual SmartScreen check (representative of the real first run)**

In a fresh Windows Sandbox (double-click `sandbox\mkEvent-smoke.wsb` but cancel/skip the auto-run, or open a plain Sandbox and copy the installer in), double-click the installer in Explorer. Because it is unsigned, expect the **"Windows protected your PC"** SmartScreen dialog. Confirm the bypass path: **More info → Run anyway**. Record the exact wording for the user-facing note.
Expected: SmartScreen appears; "Run anyway" proceeds to the NSIS installer UI.

- [ ] **Step 2: Update `README.md` for end users**

Add a "Windows install (for QA users)" section near the top and adjust requirements. Insert this block after the intro:

```markdown
## Windows install (for QA users)

mkEvent ships as a single Windows installer — **no Node, Python, or other setup required**.

1. Download `mkEvent Setup <version>.exe`.
2. Double-click it. Because the app is not yet code-signed, Windows may show
   **"Windows protected your PC"**. Click **More info → Run anyway**.
3. Follow the installer, then launch **mkEvent** from the Start menu.
4. Open **Settings** and enter your ClickBid org token (and admin email/password
   if you use the browser fallback). These are stored locally on your machine only.
```

Then change the **Requirements** section so Node/Python are listed only under a "Developing mkEvent" heading, and the end-user requirement is "Windows 10/11" plus a valid ClickBid org token. (End users need nothing else; the installer bundles the runtime and Chromium.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Windows end-user install steps + SmartScreen guidance"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** zero-prereq bundled installer → Tasks 3/5; proxy→Node (Python removed) → Tasks 1/2; Chromium bundled → Task 5; in-process proxy on `127.0.0.1:9999` preserving the renderer contract → Tasks 1/2; signing-ready unsigned config → Task 3; Windows Sandbox smoke test (install + launch + proxy `/health` + Chromium launch/close) → Tasks 2/4/5; build-on-Windows-host + red→green sequencing → Tasks 3-5; SmartScreen coaching → Task 6. Non-goals (e2e event creation, signing, auto-update) are not implemented. All spec requirements map to a task.
- **Placeholder scan:** no TBD/TODO; every code and command step contains complete content.
- **Type/contract consistency:** `startProxyServer(options)`, `createProxyServer(options)`, `runBrowserFallback(payload)`, `runSmokeCheck({resultPath})`, and the `{status,headers,body}` / `{ok,error,message}` envelopes are used identically across module, manager, smoke-check, and tests. `PLAYWRIGHT_BROWSERS_PATH` = `resources/ms-playwright` is set consistently in `index.cjs` and `proxy-manager.cjs` and matches the `extraResources` target. `--smoke-check` / `--smoke-result=` flags are produced by `run-smoke.ps1` and consumed by `index.cjs`.
```

---

## Amendment 2026-06-01: preserve the Copy debug report feature

After this plan was written, the "Copy debug report" feature shipped (see
`docs/superpowers/specs/2026-06-01-copy-debug-report-design.md`). It adds a
`GET /debug/logs?lines=N` route to the **Python** proxy and the renderer's
"Copy debug report" button fetches it via
`EventModel.proxyToolUrl(config.api.proxyUrl, '/debug/logs?lines=500')`.

The in-process Node proxy in Task 1 must therefore also serve `GET /debug/logs`,
or the button regresses to "Proxy log: UNAVAILABLE" once Python is dropped.
Reconciliation folded into execution:

- **Task 1 (`proxy-server.cjs`):** add a module-level `tailLines(filePath, n)`
  helper and a `GET /debug/logs?lines=N` route (default 500, clamped to 5000)
  that returns `{ logPath, returned, lines }` — the same shape the Python proxy
  returns. The log file path is injected via `options.logPath` (the pure module
  stays Electron-free and testable). When no `logPath`/file, return
  `{ logPath: null, returned: 0, lines: [] }` with HTTP 200. Add unit tests for
  `tailLines` and the route. Export `tailLines`.
- **Task 2 (`proxy-manager.cjs`):** `makeFileLogger()` returns
  `{ logger, logPath }`; pass `logPath` into `startProxyServer(...)` so
  `/debug/logs` tails the same file the logger writes. Additionally, after the
  fallback child closes, log `browser_fallback_exit` with `returncode` and
  `stdout`/`stderr` trimmed to 20000 chars — this is the high-value content the
  debug report surfaced for hard bugs, and the Python proxy logged it too.

Everything else in the plan is unchanged.
