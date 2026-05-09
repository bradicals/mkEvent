const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('./event-model.js');
const engine = require('./creation-engine.js');

// ── helpers ────────────────────────────────────────────────────────────

function mockApiProxyCall(responses) {
  // responses: Map or object of URL pattern → { status, body }
  const map = responses instanceof Map ? responses : new Map(Object.entries(responses));
  model.apiProxyCall = (proxyUrl, targetUrl, method, _headers, _body) => {
    const key = `${method} ${targetUrl}`;
    if (map.has(key)) {
      const entry = map.get(key);
      return Promise.resolve({
        status: entry.status,
        headers: {},
        body: typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body),
      });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };
}

function noopProgress() {
  return { onLog() {}, onProgress() {} };
}

function capturingProgress() {
  const logs = [];
  const progressPcts = [];
  return {
    logs,
    progressPcts,
    callbacks: {
      onLog: (entry) => logs.push(entry),
      onProgress: (pct) => progressPcts.push(pct),
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────

test('ClickBidApiClient constructs URLs and auth headers', async () => {
  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev2.com/api/v4',
    orgToken: 'test-token',
    proxyUrl: 'http://localhost:9999/proxy',
  });

  assert.equal(client.apiBaseUrl, 'https://cbodev2.com/api/v4');
  assert.equal(client.orgToken, 'test-token');
  assert.equal(client.proxyUrl, 'http://localhost:9999/proxy');
});

test('ClickBidApiClient strips trailing slash from apiBaseUrl', () => {
  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev4.com/api/v4/',
    orgToken: 't',
  });
  assert.equal(client.apiBaseUrl, 'https://cbodev4.com/api/v4');
});

test('ProgressReporter fires onLog for all severity levels', () => {
  const captured = [];
  const reporter = new engine.ProgressReporter({ onLog: (e) => captured.push(e) });

  reporter.info('init', 'hello');
  reporter.run('event', 'creating');
  reporter.ok('event', 'done');
  reporter.error('event', 'oops');

  assert.equal(captured.length, 4);
  assert.deepEqual(captured[0], { kind: 'info', tag: 'init', msg: 'hello' });
  assert.deepEqual(captured[1], { kind: 'run', tag: 'event', msg: 'creating' });
  assert.deepEqual(captured[2], { kind: 'ok', tag: 'event', msg: 'done' });
  assert.deepEqual(captured[3], { kind: 'error', tag: 'event', msg: 'oops' });
});

test('ProgressReporter fires onProgress', () => {
  const pcts = [];
  const reporter = new engine.ProgressReporter({ onProgress: (p) => pcts.push(p) });

  reporter.progress(10);
  reporter.progress(50);
  reporter.progress(100);

  assert.deepEqual(pcts, [10, 50, 100]);
});

test('EventAdapter.create builds correct payload and calls API', async () => {
  mockApiProxyCall({
    'POST https://cbodev2.com/api/v4/organizations/2716/events': {
      status: 201,
      body: { id: 'evt-abc', name: 'My Event', slug: 'my-event' },
    },
  });

  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev2.com/api/v4',
    orgToken: 'token',
  });
  const { callbacks, logs } = capturingProgress();
  const adapter = new engine.EventAdapter(client, new engine.ProgressReporter(callbacks));

  const recipe = {
    environment: { organizationId: '2716', apiBaseUrl: 'https://cbodev2.com/api/v4' },
    event: {
      name: 'My Event',
      slug: 'my-event',
      startDate: '2026-06-01',
      startTime: '09:00',
      endDate: '2026-06-02',
      endTime: '17:00',
      timezone: 'America/New_York',
    },
  };

  const result = await adapter.create(recipe);

  assert.equal(result.id, 'evt-abc');
  assert.deepEqual(result.created, { id: 'evt-abc', name: 'My Event', slug: 'my-event' });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating event "My Event"…');
  assert.equal(logs[1].kind, 'ok');
  assert.ok(logs[1].msg.includes('evt-abc'));
});

test('EventAdapter.create omits dates when not provided', async () => {
  let capturedPayload;
  model.apiProxyCall = (_a, _b, _c, _d, body) => {
    capturedPayload = body;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'evt-1' }) });
  };

  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev3.com/api/v4',
    orgToken: 't',
  });
  const adapter = new engine.EventAdapter(client, new engine.ProgressReporter(noopProgress()));

  await adapter.create({
    environment: { organizationId: '123' },
    event: { name: 'Minimal', slug: 'minimal' },
  });

  assert.equal(capturedPayload.name, 'Minimal');
  assert.equal(capturedPayload.slug, 'minimal');
  assert.equal('start_date' in capturedPayload, false);
  assert.equal('end_date' in capturedPayload, false);
  assert.equal('timezone' in capturedPayload, false);
});

test('BidderAdapter.createAll sends bulk bidder payload', async () => {
  let capturedBody;
  model.apiProxyCall = (_a, _b, _c, _d, body) => {
    capturedBody = body;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ created: 3 }) });
  };

  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev2.com/api/v4',
    orgToken: 't',
  });
  const { callbacks, logs } = capturingProgress();
  const adapter = new engine.BidderAdapter(client, new engine.ProgressReporter(callbacks));

  const bidders = model.generateBidders({ count: 3, startNum: 100 });
  await adapter.createAll('evt-1', bidders);

  assert.equal(capturedBody.bidders.length, 3);
  assert.equal(capturedBody.bidders[0].bidder_number, 100);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating 3 bidders…');
  assert.equal(logs[1].kind, 'ok');
});

test('ItemAdapter.createAll sends bulk item payload', async () => {
  let capturedBody;
  model.apiProxyCall = (_a, _b, _c, _d, body) => {
    capturedBody = body;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ created: 4 }) });
  };

  const client = new engine.ClickBidApiClient({
    apiBaseUrl: 'https://cbodev2.com/api/v4',
    orgToken: 't',
  });
  const { callbacks, logs } = capturingProgress();
  const adapter = new engine.ItemAdapter(client, new engine.ProgressReporter(callbacks));

  const items = model.generateItems({ silentCount: 2, liveCount: 1, donationCount: 1, startNum: 10 });
  await adapter.createAll('evt-1', items);

  assert.equal(capturedBody.items.length, 4);
  assert.equal(capturedBody.items[0].item_type_id, 10);
  assert.equal(capturedBody.items[2].item_type_id, 20);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating 4 items…');
  assert.equal(logs[1].kind, 'ok');
});

test('createEvent orchestrator runs full pipeline', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-full' } }],
    ['POST https://cbodev2.com/api/v4/events/evt-full/bidders', { status: 201, body: { created: 2 } }],
    ['POST https://cbodev2.com/api/v4/events/evt-full/items', { status: 201, body: { created: 1 } }],
    ['GET https://cbodev2.com/api/v4/events/evt-full?with=bidders,items', {
      status: 200,
      body: { id: 'evt-full', bidders: [{ id: 1 }, { id: 2 }], items: [{ id: 1 }] },
    }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method, _d, _e) => {
    const key = `${method} ${targetUrl}`;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };

  const config = {
    api: {
      env: 'dev2',
      organizationId: '2716',
      orgToken: 'tok',
      proxyUrl: 'http://localhost:9999/proxy',
    },
    basics: { name: 'QA', slug: 'qa' },
    bidders: { count: 2, startNum: 1 },
    items: { silentCount: 1, liveCount: 0, donationCount: 0, startNum: 1 },
  };
  const recipe = model.buildRecipe(config);

  const { callbacks, logs, progressPcts } = capturingProgress();
  const result = await engine.createEvent(config, recipe, callbacks);

  assert.equal(result.eventId, 'evt-full');
  assert.ok(result.adminUrl.includes('/events/'));
  assert.ok(result.publicUrl.includes('cbodev2.com/'));

  const kinds = logs.map((l) => l.kind);
  assert.ok(kinds.includes('info'));
  assert.ok(kinds.includes('run'));
  assert.ok(kinds.includes('ok'));
  assert.ok(progressPcts.length >= 4);
  assert.equal(progressPcts[progressPcts.length - 1], 100);
});

test('createEvent handles empty bidders and items gracefully', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-empty' } }],
    ['GET https://cbodev2.com/api/v4/events/evt-empty?with=bidders,items', {
      status: 200,
      body: { id: 'evt-empty', bidders: [], items: [] },
    }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method, _d, _e) => {
    const key = `${method} ${targetUrl}`;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };

  const config = {
    api: { env: 'dev2', organizationId: '2716', orgToken: 't', proxyUrl: 'http://localhost:9999/proxy' },
    basics: { name: 'Empty', slug: 'empty' },
    bidders: { count: 0, startNum: 1 },
    items: { silentCount: 0, liveCount: 0, donationCount: 0, startNum: 1 },
  };
  const recipe = model.buildRecipe(config);

  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-empty');
  assert.ok(logs.some((l) => l.msg === 'No bidders to create'));
  assert.ok(logs.some((l) => l.msg === 'No items to create'));
});

test('createEvent verification failure is logged but does not throw', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-verr' } }],
    ['GET https://cbodev2.com/api/v4/events/evt-verr?with=bidders,items', { status: 404, body: 'not found' }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method, _d, _e) => {
    const key = `${method} ${targetUrl}`;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };

  const config = {
    api: { env: 'dev2', organizationId: '2716', orgToken: 't', proxyUrl: 'http://localhost:9999/proxy' },
    basics: { name: 'VErr', slug: 'verr' },
    bidders: { count: 0, startNum: 1 },
    items: { silentCount: 0, liveCount: 0, donationCount: 0, startNum: 1 },
  };
  const recipe = model.buildRecipe(config);

  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-verr');
  assert.ok(logs.some((l) => l.kind === 'error' && l.tag === 'verify'));
  assert.ok(result.verification.error);
});
