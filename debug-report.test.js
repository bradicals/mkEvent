const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDebugReport } = require('./debug-report.js');

function baseArgs(overrides = {}) {
  return {
    appVersion: '1.0.0',
    generatedAt: '2026-06-01T12:00:00.000Z',
    recipe: {
      environment: { id: 'cbo', baseUrl: 'https://cbo.bid' },
      event: { name: 'Twilight Gala', slug: 'twilightgala' },
      bidders: { count: 10 },
      items: { count: 5 },
    },
    result: {
      eventId: '4242',
      adminUrl: 'https://cbo.bid/events/twilightgala',
      publicUrl: 'https://cbo.bid/app/public/bidapp/twilightgala',
      verification: null,
    },
    error: '',
    lines: [
      { ts: '12:00:01', kind: 'info', tag: 'event', msg: 'Creating event' },
      { ts: '12:00:02', kind: 'ok', tag: 'event', msg: 'Event created' },
    ],
    proxyLog: { returned: 2, lines: ['{"event":"proxy_start"}', '{"event":"proxy_response"}'] },
    ...overrides,
  };
}

test('includes header fields and every transcript line', () => {
  const report = buildDebugReport(baseArgs());
  assert.match(report, /App version: 1\.0\.0/);
  assert.match(report, /Environment: cbo/);
  assert.match(report, /Event: Twilight Gala/);
  assert.match(report, /keyword twilightgala/);
  assert.match(report, /Status: success/);
  assert.match(report, /12:00:01 \[info\/event\] Creating event/);
  assert.match(report, /12:00:02 \[ok\/event\] Event created/);
});

test('includes proxy log lines', () => {
  const report = buildDebugReport(baseArgs());
  assert.match(report, /=== Proxy log/);
  assert.match(report, /"event":"proxy_start"/);
  assert.match(report, /"event":"proxy_response"/);
});

test('failure status includes the error line', () => {
  const report = buildDebugReport(baseArgs({
    error: 'keyword already in use',
    result: null,
  }));
  assert.match(report, /Status: failed/);
  assert.match(report, /Error: keyword already in use/);
});

test('marks proxy log UNAVAILABLE but still includes transcript', () => {
  const report = buildDebugReport(baseArgs({ proxyLog: null }));
  assert.match(report, /=== Proxy log: UNAVAILABLE/);
  assert.match(report, /12:00:01 \[info\/event\] Creating event/);
});

test('never leaks config secrets (function ignores config entirely)', () => {
  const report = buildDebugReport(baseArgs());
  assert.doesNotMatch(report, /orgToken|adminPassword|Authorization/i);
});

test('reports verification failure reason', () => {
  const report = buildDebugReport(baseArgs({
    result: { eventId: '1', adminUrl: 'a', publicUrl: 'b', verification: { error: 'count mismatch' } },
  }));
  assert.match(report, /Verification: FAILED — count mismatch/);
});
