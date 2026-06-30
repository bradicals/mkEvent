const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('./event-model.js');
const engine = require('./creation-engine.js');
const originalApiProxyCall = model.apiProxyCall;
const originalValidateEventSlugAvailability = model.validateEventSlugAvailability;
const originalBrowserFallbackCreateEvent = model.browserFallbackCreateEvent;
const originalBrowserFallbackApplyPostItemConfig = model.browserFallbackApplyPostItemConfig;
const originalBrowserFallbackApplyPostCreateActivity = model.browserFallbackApplyPostCreateActivity;
const originalHttpCreateEvent = model.httpCreateEvent;

// ── helpers ────────────────────────────────────────────────────────────

function mockApiProxyCall(responses) {
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

test.beforeEach(() => {
  model.validateEventSlugAvailability = async (_apiConfig, slug) => ({
    ok: true,
    slug,
    isValid: true,
    reason: '',
    source: 'remote',
  });
  engine.setHostedEventRouteStatus({
    environment: {
      id: 'dev2',
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      organizationId: '2716',
    },
  }, null);
  engine.setHostedEventRouteStatus({
    environment: {
      id: 'stage',
      apiBaseUrl: 'https://cbo.bid/api/v4',
      organizationId: '2159',
    },
  }, null);
});

test.afterEach(() => {
  model.apiProxyCall = originalApiProxyCall;
  model.validateEventSlugAvailability = originalValidateEventSlugAvailability;
  model.browserFallbackCreateEvent = originalBrowserFallbackCreateEvent;
  model.browserFallbackApplyPostItemConfig = originalBrowserFallbackApplyPostItemConfig;
  model.browserFallbackApplyPostCreateActivity = originalBrowserFallbackApplyPostCreateActivity;
  model.httpCreateEvent = originalHttpCreateEvent;
  engine.setHostedEventRouteStatus({
    environment: {
      id: 'dev2',
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      organizationId: '2716',
    },
  }, null);
  engine.setHostedEventRouteStatus({
    environment: {
      id: 'stage',
      apiBaseUrl: 'https://cbo.bid/api/v4',
      organizationId: '2159',
    },
  }, null);
});

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

test('createEvent blocks early when keyword validation says slug is taken', async () => {
  model.validateEventSlugAvailability = async () => ({
    ok: true,
    slug: 'qa-fallback',
    isValid: false,
    reason: 'Keyword is already in use.',
    source: 'remote',
  });

  let apiCalled = false;
  model.apiProxyCall = () => {
    apiCalled = true;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'evt-should-not-create' }) });
  };

  const config = {
    api: { env: 'dev2', organizationId: '2716', orgToken: 'tok', proxyUrl: 'http://localhost:9999/proxy' },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Fallback', slug: 'qafallback', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);
  const { logs, callbacks } = capturingProgress();

  await assert.rejects(
    () => engine.createEvent(config, recipe, callbacks),
    /Keyword is already in use/
  );

  assert.equal(apiCalled, false);
  assert.ok(logs.some((l) => l.msg.includes('Validating keyword "qafallback"')));
  assert.ok(logs.some((l) => l.msg.includes('Keyword unavailable: Keyword is already in use.')));
});

test('EventAdapter.create builds correct org-scoped payload and calls API', async () => {
  let capturedPayload;
  model.apiProxyCall = (_a, targetUrl, _method, _headers, body) => {
    capturedPayload = body;
    assert.equal(targetUrl, 'https://cbodev2.com/api/v4/organizations/2716/events');
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'evt-abc', slug: 'my-event' }) });
  };

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
      endDate: '2026-06-02',
      onCallDate: '2026-06-02',
      timezone: 'America/New_York',
      contactFirstName: 'QA',
      contactLastName: 'Automation',
      contactEmail: 'qa@example.test',
      contactPhone: '(555) 123-4567',
    },
  };

  const result = await adapter.create(recipe);

  assert.equal(result.id, 'evt-abc');
  assert.deepEqual(capturedPayload, {
    slug: 'my-event',
    auction_start: '2026-06-01',
    event_closing: '2026-06-02',
    on_call: '2026-06-02',
    timezone: 'America/New_York',
    event_name: 'My Event',
    first_name: 'QA',
    last_name: 'Automation',
    email: 'qa@example.test',
    phone: '5551234567',
  });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating event "My Event"…');
  assert.equal(logs[1].kind, 'ok');
  assert.ok(logs[1].msg.includes('evt-abc'));
});

test('BidderAdapter.createBulk sends bulk bidder payload to /bidders/bulk', async () => {
  let capturedBody;
  let capturedUrl;
  model.apiProxyCall = (_a, targetUrl, _method, _d, body) => {
    capturedUrl = targetUrl;
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
  await adapter.createBulk('evt-1', bidders);

  assert.equal(capturedUrl, 'https://cbodev2.com/api/v4/events/evt-1/bidders/bulk');
  assert.equal(capturedBody.bidders.length, 3);
  assert.equal(capturedBody.bidders[0].bidder_number, 100);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating 3 bulk bidders…');
  assert.equal(logs[1].kind, 'ok');
});

test('BidderAdapter.createOne sends single bidder payload to /bidders', async () => {
  let capturedBody;
  let capturedUrl;
  model.apiProxyCall = (_a, targetUrl, _method, _d, body) => {
    capturedUrl = targetUrl;
    capturedBody = body;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'b1' }) });
  };

  const client = new engine.ClickBidApiClient({ apiBaseUrl: 'https://cbodev2.com/api/v4', orgToken: 't' });
  const adapter = new engine.BidderAdapter(client, new engine.ProgressReporter(noopProgress()));
  await adapter.createOne('evt-1', { bidder_number: 777, first_name: 'Exact', last_name: 'Bidder' }, 0, 1);

  assert.equal(capturedUrl, 'https://cbodev2.com/api/v4/events/evt-1/bidders');
  assert.deepEqual(capturedBody, { bidder_number: 777, first_name: 'Exact', last_name: 'Bidder' });
});

test('BidderAdapter.createOne retries on bidder number collision', async () => {
  let callCount = 0;
  const { callbacks, logs } = capturingProgress();
  model.apiProxyCall = (_a, _url, _method, _d, body) => {
    callCount++;
    const num = JSON.parse(typeof body === 'string' ? body : JSON.stringify(body)).bidder_number;
    if (num === 300) {
      return Promise.resolve({ status: 422, headers: {}, body: JSON.stringify({ message: 'The bidder number has already been taken.', errors: { bidder_number: ['The bidder number has already been taken.'] } }) });
    }
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'b1', bidder_number: num }) });
  };

  const client = new engine.ClickBidApiClient({ apiBaseUrl: 'https://cbodev2.com/api/v4', orgToken: 't' });
  const adapter = new engine.BidderAdapter(client, new engine.ProgressReporter(callbacks));
  await adapter.createOne('evt-1', { bidder_number: 300, first_name: 'Retry', last_name: 'Bidder' }, 0, 1);

  assert.equal(callCount, 2, 'should have called API twice (original + one retry)');
  assert.ok(logs.some((l) => l.msg.includes('Bidder number 300 taken') && l.msg.includes('trying 301')), 'should log the retry');
  assert.ok(logs.some((l) => l.kind === 'warn' && l.msg.includes('300 → 301')), 'should warn about adjusted number');
});

test('ItemAdapter.createBulk sends bulk item payload to /items/bulk', async () => {
  let capturedBody;
  let capturedUrl;
  model.apiProxyCall = (_a, targetUrl, _method, _d, body) => {
    capturedUrl = targetUrl;
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
  await adapter.createBulk('evt-1', items);

  assert.equal(capturedUrl, 'https://cbodev2.com/api/v4/events/evt-1/items/bulk');
  assert.equal(capturedBody.items.length, 4);
  assert.equal(capturedBody.items[0].item_type_id, 10);
  assert.equal(capturedBody.items[2].item_type_id, 20);
  assert.equal(logs[0].kind, 'run');
  assert.equal(logs[0].msg, 'Creating 4 bulk items…');
  assert.equal(logs[1].kind, 'ok');
});

test('ItemAdapter.createOne sends single item payload to /items', async () => {
  let capturedBody;
  let capturedUrl;
  model.apiProxyCall = (_a, targetUrl, _method, _d, body) => {
    capturedUrl = targetUrl;
    capturedBody = body;
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'i1' }) });
  };

  const client = new engine.ClickBidApiClient({ apiBaseUrl: 'https://cbodev2.com/api/v4', orgToken: 't' });
  const adapter = new engine.ItemAdapter(client, new engine.ProgressReporter(noopProgress()));
  await adapter.createOne('evt-1', { item_number: 901, item_name: 'Exact Item', item_type_id: 10 }, 0, 1);

  assert.equal(capturedUrl, 'https://cbodev2.com/api/v4/events/evt-1/items');
  assert.deepEqual(capturedBody, { item_number: 901, item_name: 'Exact Item', item_type_id: 10 });
});

test('ItemAdapter.createOne retries on item number collision', async () => {
  let callCount = 0;
  const { callbacks, logs } = capturingProgress();
  model.apiProxyCall = (_a, _url, _method, _d, body) => {
    callCount++;
    const num = JSON.parse(typeof body === 'string' ? body : JSON.stringify(body)).item_number;
    if (num === 100) {
      return Promise.resolve({ status: 422, headers: {}, body: JSON.stringify({ message: 'The item number has already been taken.', errors: { item_number: ['The item number has already been taken.'] } }) });
    }
    return Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ id: 'i1', item_number: num }) });
  };

  const client = new engine.ClickBidApiClient({ apiBaseUrl: 'https://cbodev2.com/api/v4', orgToken: 't' });
  const adapter = new engine.ItemAdapter(client, new engine.ProgressReporter(callbacks));
  await adapter.createOne('evt-1', { item_number: 100, item_name: 'Retry Item', item_type_id: 10 }, 0, 1);

  assert.equal(callCount, 2, 'should have called API twice (original + one retry)');
  assert.ok(logs.some((l) => l.msg.includes('Item number 100 taken') && l.msg.includes('trying 101')), 'should log the retry');
  assert.ok(logs.some((l) => l.kind === 'warn' && l.msg.includes('100 → 101')), 'should warn about adjusted number');
});

test('createEvent orchestrator runs mixed bulk + exact pipeline', async () => {
  const originalBrowserFallback = model.browserFallbackCreateEvent;
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-full' } }],
    // Bulk create returns the created records (real API shape: { data: [...] }).
    ['POST https://cbodev2.com/api/v4/events/evt-full/bidders/bulk', { status: 201, body: { data: [{ id: 1, bidder_number: 1 }, { id: 2, bidder_number: 2 }] } }],
    ['POST https://cbodev2.com/api/v4/events/evt-full/bidders', { status: 201, body: { id: 'b-exact' } }],
    ['POST https://cbodev2.com/api/v4/events/evt-full/items/bulk', { status: 201, body: { data: [{ id: 1, item_number: 1, item_type_id: 10 }] } }],
    ['POST https://cbodev2.com/api/v4/events/evt-full/items', { status: 201, body: { id: 'i-exact' } }],
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
    basics: {
      ...model.DEFAULT_CONFIG.basics,
      name: 'QA',
      slug: 'qa',
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      onCallDate: '2026-06-02',
    },
    bidders: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 2, startNum: 1 },
      exact: { records: [{ bidder_number: 50, first_name: 'Exact', last_name: 'Bidder', email: 'exact@example.test' }] },
    },
    items: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 1, liveCount: 0, donationCount: 0, startNum: 1 },
      exact: { records: [{ item_number: 99, item_name: 'Exact Item', type: 'silent', status_id: 1, starting_bid: 50, bid_increment: 5, fair_market_value: 100, reserve_amount: 0 }] },
    },
  };
  const recipe = model.buildRecipe(config);

  const { callbacks, logs, progressPcts } = capturingProgress();
  const result = await engine.createEvent(config, recipe, callbacks);

  assert.equal(result.eventId, 'evt-full');
  assert.ok(result.adminUrl.includes('/events/'));
  assert.ok(result.publicUrl.includes('.cbodev2.com'));

  const messages = logs.map((l) => l.msg);
  assert.ok(messages.includes('Creating 2 bulk bidders…'));
  assert.ok(messages.some((msg) => msg.includes('Creating exact bidder')));
  assert.ok(messages.includes('Creating 1 bulk items…'));
  assert.ok(messages.some((msg) => msg.includes('Creating exact item')));
  assert.ok(progressPcts.length >= 4);
  assert.equal(progressPcts[progressPcts.length - 1], 100);
});

test('createEvent uses browser fallback when hosted event-create route is unavailable', async () => {
  const originalBrowserFallback = model.browserFallbackCreateEvent;
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 404, body: { message: 'Unrecognized endpoint of organizations/2716/events' } }],
    ['GET https://cbodev2.com/api/v4/events/evt-fallback/bidders?per_page=500', { status: 200, body: { data: [{ id: 'default' }] } }],
    ['GET https://cbodev2.com/api/v4/events/evt-fallback/items?per_page=500', { status: 200, body: { data: [{ id: 'default-1' }, { id: 'default-2' }, { id: 'default-3' }, { id: 'default-4' }, { id: 'default-5' }, { id: 'default-6' }, { id: 'default-7' }] } }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method) => {
    const key = `${method} ${targetUrl}`;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };
  let capturedFallbackPayload;
  // Mock returns eventId directly (mirrors the new AJAX fallback behavior)
  model.browserFallbackCreateEvent = async (_proxyUrl, payload) => {
    capturedFallbackPayload = payload;
    return {
    ok: true,
    eventId: 'evt-fallback',
    eventSlug: payload.event.slug,
    eventName: payload.event.name,
    adminUrl: `https://cbodev2.com/events/${payload.event.slug}`,
    publicUrl: `https://${payload.event.slug}.cbodev2.com`,
    };
  };

  try {
    const config = {
      api: {
        env: 'dev2',
        organizationId: '2716',
        orgToken: 'tok',
        proxyUrl: 'http://localhost:9999/proxy',
        browser: 'chromium',
        adminEmail: 'admin@example.test',
        adminPassword: 'password123',
      },
      basics: { ...model.DEFAULT_CONFIG.basics, name: 'Fallback', slug: 'qafallback', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
      bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
      items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
    };
    const recipe = model.buildRecipe(config);
    const { logs, callbacks } = capturingProgress();
    const result = await engine.createEvent(config, recipe, callbacks);

    assert.equal(result.eventId, 'evt-fallback');
    assert.equal(result.adminUrl, 'https://cbodev2.com/events/qafallback');
    assert.equal(capturedFallbackPayload.auctionSettings.useExistingMerchantAccount, true);
    assert.equal(capturedFallbackPayload.auctionSettings.requireCreditCard, true);
    assert.equal(capturedFallbackPayload.auctionSettings.startingBidderNumber, '100');
    assert.ok(logs.some((l) => l.msg.includes('known hosted-route gap')));
    assert.ok(logs.some((l) => l.msg.includes('Hosted API rejected org-scoped event creation for org 2716')));
    assert.ok(logs.some((l) => l.msg.includes('Browser fallback preflight OK: proxy=http://localhost:9999/proxy, browser=chromium, target=https://cbodev2.com')));
    assert.ok(logs.some((l) => l.msg.includes('switching to chromium admin UI fallback')));
  } finally {
    model.browserFallbackCreateEvent = originalBrowserFallback;
  }
});

test('createEvent skips the hosted API probe after the route is marked unavailable', async () => {
  const originalBrowserFallback = model.browserFallbackCreateEvent;
  let apiPostCount = 0;
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 404, body: { message: 'Unrecognized endpoint of organizations/2716/events' } }],
    ['GET https://cbodev2.com/api/v4/events/evt-fallback-2/bidders?per_page=500', { status: 200, body: { data: [{ id: 'default' }] } }],
    ['GET https://cbodev2.com/api/v4/events/evt-fallback-2/items?per_page=500', { status: 200, body: { data: [{ id: 'default-1' }, { id: 'default-2' }, { id: 'default-3' }, { id: 'default-4' }, { id: 'default-5' }, { id: 'default-6' }, { id: 'default-7' }] } }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method) => {
    const key = `${method} ${targetUrl}`;
    if (key === 'POST https://cbodev2.com/api/v4/organizations/2716/events') apiPostCount += 1;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };
  model.browserFallbackCreateEvent = async (_proxyUrl, payload) => ({
    ok: true,
    eventId: 'evt-fallback-2',
    eventSlug: payload.event.slug,
    eventName: payload.event.name,
    adminUrl: `https://cbodev2.com/events/${payload.event.slug}`,
    publicUrl: `https://${payload.event.slug}.cbodev2.com`,
  });

  try {
    const config = {
      api: {
        env: 'dev2',
        organizationId: '2716',
        orgToken: 'tok',
        proxyUrl: 'http://localhost:9999/proxy',
        browser: 'chromium',
        adminEmail: 'admin@example.test',
        adminPassword: 'password123',
      },
      basics: { ...model.DEFAULT_CONFIG.basics, name: 'Fallback Cached', slug: 'qafallbackcached', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
      bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
      items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
    };
    const recipe = model.buildRecipe(config);

    await engine.createEvent(config, recipe, capturingProgress().callbacks);
    assert.equal(apiPostCount, 1);
    assert.equal(engine.getHostedEventRouteStatus(recipe), 'unavailable');

    const second = capturingProgress();
    await engine.createEvent(config, recipe, second.callbacks);

    assert.equal(apiPostCount, 1);
    assert.ok(second.logs.some((l) => l.msg.includes('previously marked unavailable')));
    assert.equal(second.logs.some((l) => l.msg.includes('API-first event creation hit a known hosted-route gap')), false);
  } finally {
    model.browserFallbackCreateEvent = originalBrowserFallback;
  }
});

test('createEvent uses browser fallback immediately in stage', async () => {
  const originalBrowserFallback = model.browserFallbackCreateEvent;
  let apiPostCount = 0;
  const apiStubs = new Map([
    ['GET https://cbo.bid/api/v4/events/evt-stage-fallback/bidders?per_page=500', { status: 200, body: { data: [{ id: 'default' }] } }],
    ['GET https://cbo.bid/api/v4/events/evt-stage-fallback/items?per_page=500', { status: 200, body: { data: [{ id: 'default-1' }, { id: 'default-2' }, { id: 'default-3' }, { id: 'default-4' }, { id: 'default-5' }, { id: 'default-6' }, { id: 'default-7' }] } }],
  ]);

  model.apiProxyCall = (_a, targetUrl, method) => {
    const key = `${method} ${targetUrl}`;
    if (key === 'POST https://cbo.bid/api/v4/organizations/2159/events') apiPostCount += 1;
    if (apiStubs.has(key)) {
      const entry = apiStubs.get(key);
      return Promise.resolve({ status: entry.status, headers: {}, body: JSON.stringify(entry.body) });
    }
    return Promise.resolve({ status: 500, headers: {}, body: JSON.stringify({ message: 'unmocked' }) });
  };
  model.browserFallbackCreateEvent = async (_proxyUrl, payload) => ({
    ok: true,
    eventId: 'evt-stage-fallback',
    eventSlug: payload.event.slug,
    eventName: payload.event.name,
    adminUrl: `https://cbo.bid/events/${payload.event.slug}`,
    publicUrl: `https://${payload.event.slug}.cbo.bid`,
  });

  try {
    const config = {
      api: {
        env: 'stage',
        organizationId: '2159',
        orgToken: 'tok',
        proxyUrl: 'http://localhost:9999/proxy',
        browser: 'chromium',
        adminEmail: 'admin@example.test',
        adminPassword: 'password123',
      },
      basics: { ...model.DEFAULT_CONFIG.basics, name: 'Stage Direct', slug: 'stagedirect', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
      bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
      items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
    };
    const recipe = model.buildRecipe(config);
    const { logs, callbacks } = capturingProgress();
    const result = await engine.createEvent(config, recipe, callbacks);

    assert.equal(result.eventId, 'evt-stage-fallback');
    assert.equal(apiPostCount, 0);
    assert.equal(engine.getHostedEventRouteStatus(recipe), 'unavailable');
    assert.ok(logs.some((l) => l.msg.includes('Stage environment uses browser/admin event creation directly')));
    assert.ok(logs.some((l) => l.msg.includes('Browser fallback preflight OK: proxy=http://localhost:9999/proxy, browser=chromium, target=https://cbo.bid')));
  } finally {
    model.browserFallbackCreateEvent = originalBrowserFallback;
  }
});

test('createEvent surfaces missing admin credentials when browser fallback is needed', async () => {
  model.apiProxyCall = () => Promise.resolve({ status: 404, headers: {}, body: JSON.stringify({ message: 'Unrecognized endpoint of organizations/2716/events' }) });
  const config = {
    api: { env: 'dev2', organizationId: '2716', orgToken: 'tok', proxyUrl: 'http://localhost:9999/proxy', browser: 'chromium', adminEmail: '', adminPassword: '' },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Fallback', slug: 'qa-fallback', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);
  const { logs, callbacks } = capturingProgress();

  await assert.rejects(
    () => engine.createEvent(config, recipe, callbacks),
    /Browser fallback requires admin login email and password/,
  );

  assert.ok(logs.some((l) => l.msg.includes('known hosted-route gap')));
  assert.ok(logs.some((l) => l.msg.includes('Hosted API rejected org-scoped event creation for org 2716')));
  assert.ok(logs.some((l) => l.msg.includes('Browser fallback blocked before launch: missing admin login email and admin password in Settings.')));
  assert.ok(logs.some((l) => l.msg.includes('No browser session was launched.')));
});

test('createEvent applies quantity item tiers and ticket-page attachments after exact item creation', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-qty' } }],
    // Bulk create returns the created quantity item (with item_number) so ticket-page
    // attachment can resolve it without a re-fetch.
    ['POST https://cbodev2.com/api/v4/events/evt-qty/items/bulk', { status: 201, body: { data: [{ id: 'item-qty-bulk-1', item_number: 201, item_type_id: 40 }] } }],
    ['POST https://cbodev2.com/api/v4/events/evt-qty/items', { status: 201, body: { id: 'item-qty-1', item_number: 301, item_type_id: 40 } }],
  ]);
  mockApiProxyCall(apiStubs);

  let capturedFallbackPayload = null;
  model.browserFallbackApplyPostItemConfig = async (_proxyUrl, payload) => {
    capturedFallbackPayload = payload;
    return { ok: true, postItemConfig: { applied: [{ section: 'quantityItemTier' }], skipped: [], warnings: [] } };
  };

  const config = {
    api: {
      env: 'dev2',
      organizationId: '2716',
      orgToken: 't',
      proxyUrl: 'http://localhost:9999/proxy',
      browser: 'chromium',
      adminEmail: 'admin@example.test',
      adminPassword: 'password123',
    },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Quantity', slug: 'quantity', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0, quantityCount: 1, startNum: 201 },
      exact: {
        records: [{
          type: 'quantity',
          item_name: 'Drink Tickets',
          item_number: 301,
          fair_market_value: 0,
          qty: 100,
          quantity_tiers: '1-25, 5-100',
        }],
      },
    },
    ticketPages: {
      enabled: true,
      preset: 'custom',
      pages: [{
        ...model.DEFAULT_CONFIG.ticketPages.pages[0],
        quantityItemBulkIndexes: [0],
        quantityItemExactIndexes: [0],
      }],
    },
  };

  const recipe = model.buildRecipe(config);
  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-qty');
  assert.ok(capturedFallbackPayload);
  assert.equal(capturedFallbackPayload.eventId, 'evt-qty');
  assert.equal(capturedFallbackPayload.quantityItems.length, 2);
  assert.equal(capturedFallbackPayload.quantityItems[0].id, 'item-qty-bulk-1');
  assert.equal(capturedFallbackPayload.quantityItems[1].id, 'item-qty-1');
  assert.deepEqual(capturedFallbackPayload.ticketPages.pages[0].quantityItemBulkIndexes, [0]);
  assert.deepEqual(capturedFallbackPayload.ticketPages.pages[0].quantityItemExactIndexes, [0]);
  assert.ok(logs.some((l) => l.msg.includes('Applying ticket-page item attachments and quantity tiers')));
});

test('createEvent handles empty bidders and items gracefully', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-empty' } }],
    ['GET https://cbodev2.com/api/v4/events/evt-empty/bidders?per_page=500', { status: 200, body: { data: [{ id: 'default' }] } }],
    ['GET https://cbodev2.com/api/v4/events/evt-empty/items?per_page=500', { status: 200, body: { data: [{ id: 'default-1' }, { id: 'default-2' }, { id: 'default-3' }, { id: 'default-4' }, { id: 'default-5' }, { id: 'default-6' }, { id: 'default-7' }] } }],
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
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Empty', slug: 'empty', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);

  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-empty');
  assert.ok(logs.some((l) => l.msg === 'No bidders to create'));
  assert.ok(logs.some((l) => l.msg === 'No items to create'));
});

test('createEvent verification failure is logged but does not throw', async () => {
  // Backend returns no created records though the recipe asked for bidders/items:
  // verification fails, but createEvent must still complete and return the event.
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-verr' } }],
    ['POST https://cbodev2.com/api/v4/events/evt-verr/bidders/bulk', { status: 201, body: { data: [] } }],
    ['POST https://cbodev2.com/api/v4/events/evt-verr/items/bulk', { status: 201, body: { data: [] } }],
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
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'VErr', slug: 'verr', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 2, startNum: 1 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 1, liveCount: 0, donationCount: 0, startNum: 1 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);

  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-verr');
  assert.ok(logs.some((l) => l.kind === 'error' && l.tag === 'verify'));
  assert.ok(result.verification.error);
});

test('EventAdapter.create rejects 2xx responses without an event ID', async () => {
  model.apiProxyCall = () => Promise.resolve({ status: 201, headers: {}, body: JSON.stringify({ ok: true }) });
  const client = new engine.ClickBidApiClient({ apiBaseUrl: 'https://cbodev2.com/api/v4', orgToken: 't' });
  const adapter = new engine.EventAdapter(client, new engine.ProgressReporter(noopProgress()));

  await assert.rejects(
    () => adapter.create({
      environment: { organizationId: '2716' },
      event: {
        name: 'No ID',
        slug: 'no-id',
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        onCallDate: '2026-06-02',
        timezone: 'America/New_York',
        contactFirstName: 'QA',
        contactLastName: 'Automation',
        contactEmail: 'qa@example.test',
        contactPhone: '5550000000',
      },
    }),
    /did not include an event ID/
  );
});

test('createEvent logs verification mismatch when returned counts differ from recipe', async () => {
  const apiStubs = new Map([
    ['POST https://cbodev2.com/api/v4/organizations/2716/events', { status: 201, body: { id: 'evt-mismatch' } }],
    // Backend acknowledges fewer created records than the recipe asked for:
    // recipe wants 2 bulk bidders + 1 bulk item, responses contain 1 and 0.
    ['POST https://cbodev2.com/api/v4/events/evt-mismatch/bidders/bulk', { status: 201, body: { data: [{ id: 1, bidder_number: 1 }] } }],
    ['POST https://cbodev2.com/api/v4/events/evt-mismatch/items/bulk', { status: 201, body: { data: [] } }],
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
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Mismatch', slug: 'mismatch', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 2, startNum: 1 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 1, liveCount: 0, donationCount: 0, startNum: 1 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);

  const { logs } = capturingProgress();
  const result = await engine.createEvent(config, recipe, { onLog: (e) => logs.push(e) });

  assert.equal(result.eventId, 'evt-mismatch');
  assert.match(result.verification.error, /expected 2 seeded bidders, created 1/);
  assert.match(result.verification.error, /expected 1 seeded items, created 0/);
  assert.ok(logs.some((l) => l.kind === 'error' && l.tag === 'verify' && l.msg.includes('Verification mismatch')));
});

test('createEvent uses HTTP admin create when admin creds present and no auction/ticket settings', async () => {
  let browserFallbackCalled = false;
  model.httpCreateEvent = async () => ({ ok: true, eventId: '4591', eventSlug: 'x', adminUrl: 'http://h/events/x' });
  model.browserFallbackCreateEvent = async () => { browserFallbackCalled = true; return {}; };

  const config = {
    api: { env: 'dev2', organizationId: '2716', orgToken: 't', proxyUrl: 'http://localhost:9999/proxy', adminEmail: 'admin@example.test', adminPassword: 'pass' },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'HTTP', slug: 'httpcreate', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    auctionSettings: { enabled: false },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);
  const result = await engine.createEvent(config, recipe, noopProgress());

  assert.equal(result.eventId, '4591');
  assert.equal(browserFallbackCalled, false);
});

test('createEvent falls back to browser adapter when HTTP admin create throws', async () => {
  let browserFallbackCalled = false;
  model.httpCreateEvent = async () => { throw new Error('proxy offline'); };
  model.browserFallbackCreateEvent = async (_proxyUrl, payload) => {
    browserFallbackCalled = true;
    return { ok: true, eventId: 'evt-http-err-fb', eventSlug: payload.event.slug, eventName: payload.event.name, adminUrl: `https://cbo.bid/events/${payload.event.slug}`, publicUrl: `https://${payload.event.slug}.cbo.bid` };
  };

  const config = {
    api: { env: 'stage', organizationId: '2159', orgToken: 't', proxyUrl: 'http://localhost:9999/proxy', browser: 'chromium', adminEmail: 'admin@example.test', adminPassword: 'pass' },
    auctionSettings: { enabled: false },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'HTTP Err', slug: 'httperr', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 0 }, exact: { records: [] } },
    items: { activeTab: 'bulk', bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 0 }, exact: { records: [] } },
  };
  const recipe = model.buildRecipe(config);
  const result = await engine.createEvent(config, recipe, noopProgress());

  assert.equal(result.eventId, 'evt-http-err-fb');
  assert.equal(browserFallbackCalled, true);
});
