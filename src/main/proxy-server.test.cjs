'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {
  startProxyServer,
  closeServer,
  redactSensitive,
  isHostAllowed,
  tailLines,
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

test('tailLines returns last n non-blank-trailing lines; missing file -> []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkevent-tail-'));
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, 'a\nb\nc\nd\ne\n');
  assert.deepStrictEqual(tailLines(file, 2), ['d', 'e']);
  assert.deepStrictEqual(tailLines(file, 10), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(tailLines(file, 0), []);
  assert.deepStrictEqual(tailLines(path.join(dir, 'nope.jsonl'), 5), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /health returns ok', async () => {
  await withProxy({}, async (base) => {
    const res = await fetch(`${base}/health`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
  });
});

test('GET /debug/logs tails the injected log file (redacted at write time)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkevent-debuglogs-'));
  const file = path.join(dir, 'mkEvent-proxy.log');
  fs.writeFileSync(file, '{"event":"proxy_start"}\n{"event":"proxy_response"}\n');
  await withProxy({ logPath: file }, async (base) => {
    const res = await fetch(`${base}/debug/logs?lines=500`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.logPath, file);
    assert.strictEqual(json.returned, 2);
    assert.ok(json.lines[0].includes('proxy_start'));
    assert.ok(json.lines[1].includes('proxy_response'));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /debug/logs without a configured log file returns 200 and empty lines', async () => {
  await withProxy({}, async (base) => {
    const res = await fetch(`${base}/debug/logs`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.returned, 0);
    assert.deepStrictEqual(json.lines, []);
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

test('closeServer resolves promptly even with an idle keep-alive connection held open', async () => {
  // Regression for the "mkEvent cannot be closed" auto-update bug: the renderer
  // (Chromium) keeps HTTP keep-alive sockets to the in-process proxy. A plain
  // server.close() waits for those sockets to idle out (~keepAliveTimeout),
  // keeping the main process alive long enough that the NSIS updater reports the
  // app can't be closed. closeServer must force those sockets shut and resolve
  // immediately so the process can exit.
  const server = await startProxyServer({ port: 0, allowlist: ['127.0.0.1'] });
  const { port } = server.address();

  // Make a request over a keep-alive agent so a socket stays open afterwards.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });

  const start = Date.now();
  await closeServer(server);
  const elapsed = Date.now() - start;
  agent.destroy();

  assert.ok(elapsed < 1500, `closeServer took ${elapsed}ms; expected a prompt shutdown`);
});

test('closeServer is a no-op on a null/undefined server', async () => {
  await closeServer(null);
  await closeServer(undefined);
});

test('unknown path returns 404', async () => {
  await withProxy({}, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/nope`, { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 404);
  });
});

test('POST /fallback/create-event-http dispatches to runHttpAdmin and returns result', async () => {
  const stub = async (action, payload) => ({ ok: true, action, eventId: '4591', eventSlug: payload.event.slug });
  await withProxy({ runHttpAdmin: stub }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/create-event-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1', organizationId: '2518',
        adminEmail: 'a', adminPassword: 'p', event: { slug: 'x' },
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.eventId, '4591');
    assert.strictEqual(json.action, 'create-event-http');
    assert.strictEqual(json.eventSlug, 'x');
  });
});

test('POST /fallback/create-event-http rejects non-allowlisted host with 403', async () => {
  const stub = async () => ({ ok: true });
  await withProxy({ runHttpAdmin: stub }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/create-event-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://evil.example', organizationId: '2518',
        adminEmail: 'a', adminPassword: 'p', event: { slug: 'x' },
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.ok, false);
    assert.ok(json.message.includes('not an allowed'));
  });
});

test('POST /fallback/create-event-http returns 400 when required field is missing', async () => {
  const stub = async () => ({ ok: true });
  await withProxy({ runHttpAdmin: stub }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/create-event-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1', organizationId: '2518',
        adminEmail: 'a', adminPassword: 'p',
        // event field omitted
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.ok, false);
    assert.ok(json.message.includes('Missing'));
  });
});

test('POST /fallback/post-item-config-http dispatches to runHttpAdmin and returns result', async () => {
  const stub = async (action, payload) => ({ ok: true, action, eventId: payload.eventId, postItemConfig: { applied: [], skipped: [], warnings: [] } });
  await withProxy({ runHttpAdmin: stub }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/post-item-config-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1', organizationId: '2518',
        adminEmail: 'a', adminPassword: 'p', eventId: '4591',
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.action, 'post-item-config-http');
    assert.strictEqual(json.eventId, '4591');
  });
});

test('POST /fallback/post-item-config-http returns 400 when required field is missing', async () => {
  const stub = async () => ({ ok: true });
  await withProxy({ runHttpAdmin: stub }, async (proxyBase) => {
    const res = await fetch(`${proxyBase}/fallback/post-item-config-http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1', organizationId: '2518',
        adminEmail: 'a', adminPassword: 'p',
        // eventId field omitted
      }),
    });
    const json = await res.json();
    assert.strictEqual(res.status, 400);
    assert.ok(json.message.includes('Missing'));
  });
});
