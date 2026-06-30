// src/main/admin-http.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createJar, scrapeLoginForm, scrapeOrgForm, adminLogin } = require('./admin-http.cjs');

// Minimal fake Response
function res({ status = 200, location, setCookie = [], body = '' } = {}) {
  const headers = new Map();
  if (location) headers.set('location', location);
  return {
    status,
    headers: {
      get: (k) => headers.get(k.toLowerCase()) ?? null,
      getSetCookie: () => setCookie,
    },
    text: async () => body,
  };
}

test('createJar absorbs and serializes cookies', () => {
  const jar = createJar();
  jar.absorb(res({ setCookie: ['PHPSESSID=abc; Path=/', 'AWSALB=z; Secure'] }));
  assert.match(jar.header(), /PHPSESSID=abc/);
  assert.match(jar.header(), /AWSALB=z/);
});

test('scrapeLoginForm finds csrf hidden field and action', () => {
  const html = `<form action="index.php" method="post">
    <input type="hidden" name="csrf" value="TOK">
    <input type="text" name="username"><input type="password" name="password"></form>`;
  const f = scrapeLoginForm(html);
  assert.equal(f.action, 'index.php');
  assert.equal(f.inputs.csrf, 'TOK');
  assert.equal(f.userField, 'username');
  assert.equal(f.passField, 'password');
});

test('adminLogin walks login -> index -> organization and succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.endsWith('/admin/login.php')) {
      return res({ status: 200, setCookie: ['PHPSESSID=s1; Path=/'],
        body: '<form action="index.php"><input type="hidden" name="csrf" value="TOK"><input name="username"><input type="password" name="password"></form>' });
    }
    if (url.endsWith('/admin/index.php')) return res({ status: 302, location: '/admin/select-organization.php' });
    if (url.endsWith('/admin/select-organization.php')) {
      return res({ status: 200, body: '<form action="/admin/organization.php"><input type="hidden" name="organization-id" value=""></form>' });
    }
    if (url.endsWith('/admin/organization.php')) return res({ status: 302, location: '/app/public/organizations/2518/events' });
    if (url.endsWith('/app/public/organizations/2518/events')) return res({ status: 200, body: '<html>events</html>' });
    return res({ status: 404 });
  };
  const session = await adminLogin({
    fetchImpl, baseUrl: 'https://cbotriage.bid', adminEmail: 'a@b.c', adminPassword: 'pw',
    organizationId: '2518', allowlist: new Set(['cbotriage.bid']),
  });
  assert.ok(session.request);
  assert.ok(calls.some((c) => c.url.endsWith('/admin/index.php') && c.method === 'POST'));
  assert.ok(calls.some((c) => c.url.endsWith('/admin/organization.php') && c.method === 'POST'));
});

test('adminLogin throws when login bounces back to login page', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/admin/login.php')) return res({ body: '<form action="index.php"><input name="username"><input type="password" name="password"></form>' });
    if (url.endsWith('/admin/index.php')) return res({ status: 302, location: '/admin/login.php?error=1' });
    return res({ status: 200, body: '<input type="password" name="password">' });
  };
  await assert.rejects(
    adminLogin({ fetchImpl, baseUrl: 'https://cbotriage.bid', adminEmail: 'a', adminPassword: 'x', organizationId: '1', allowlist: new Set(['cbotriage.bid']) }),
    /Admin login failed/,
  );
});

const { httpCreateEvent } = require('./admin-http.cjs');

function loginScript(extra) {
  return async (url, opts = {}) => {
    if (url.endsWith('/admin/login.php')) return res({ setCookie: ['PHPSESSID=s; Path=/'],
      body: '<form action="index.php"><input type="hidden" name="csrf" value="T"><input name="username"><input type="password" name="password"></form>' });
    if (url.endsWith('/admin/index.php')) return res({ status: 302, location: '/admin/welcome.php' });
    if (url.endsWith('/admin/welcome.php')) return res({ status: 200, body: 'welcome' });
    return extra(url, opts);
  };
}

test('httpCreateEvent parses event id from response html data-id', async () => {
  const fetchImpl = loginScript(async (url) => {
    if (url.endsWith('/ajax/admin/organization/events.php')) {
      return res({ status: 200, body: JSON.stringify({ success: true, html: '<div class="event-card" data-id="4591" data-org_id="2518">' }) });
    }
    return res({ status: 404 });
  });
  const out = await httpCreateEvent({
    baseUrl: 'https://cbotriage.bid', organizationId: '2518', adminEmail: 'a', adminPassword: 'p',
    event: { slug: 'qa-x', name: 'QA X', startDate: '2030-01-01', endDate: '2030-01-02', timezone: 'America/Chicago', contactEmail: 'a@b.c', contactPhone: '5551234567' },
  }, { fetchImpl, allowlist: new Set(['cbotriage.bid']) });
  assert.equal(out.eventId, '4591');
  assert.equal(out.eventSlug, 'qa-x');
  assert.equal(out.adminUrl, 'https://cbotriage.bid/events/qa-x');
});

test('httpCreateEvent throws on keyword-in-use', async () => {
  const fetchImpl = loginScript(async (url) => {
    if (url.endsWith('/ajax/admin/organization/events.php')) return res({ status: 200, body: JSON.stringify({ success: false, message: 'keyword already in use' }) });
    return res({ status: 404 });
  });
  await assert.rejects(
    httpCreateEvent({ baseUrl: 'https://cbotriage.bid', organizationId: '2518', adminEmail: 'a', adminPassword: 'p', event: { slug: 'dup' } }, { fetchImpl, allowlist: new Set(['cbotriage.bid']) }),
    /already in use/,
  );
});

const { httpApplyPostItemConfig } = require('./admin-http.cjs');

test('httpApplyPostItemConfig sets event, reads csrf, posts a quantity tier', async () => {
  const posted = [];
  const fetchImpl = loginScript(async (url, opts = {}) => {
    if (url.endsWith('/admin/event.php')) return res({ status: 302, location: '/admin/welcome.php' });
    if (url.endsWith('/butler/event-utilities.php')) return res({ status: 200, body: '<meta name="csrf-token" content="CT">' });
    if (url.endsWith('/ajax/admin/manage-items.php')) { posted.push(opts.body); return res({ status: 200, body: JSON.stringify({ success: true }) }); }
    return res({ status: 404 });
  });
  const out = await httpApplyPostItemConfig({
    baseUrl: 'https://cbotriage.bid', organizationId: '2518', adminEmail: 'a', adminPassword: 'p',
    eventId: '4591', quantityItems: [{ id: '12', item_name: 'Q', quantity_tiers: [{ quantity: 2, price: 50 }] }],
    donationItems: [], ticketPages: { pages: [] },
  }, { fetchImpl, allowlist: new Set(['cbotriage.bid']) });
  assert.equal(out.ok, true);
  assert.equal(out.postItemConfig.applied.length, 1);
  assert.match(posted[0], /item_id=12/);
  assert.match(posted[0], /quantity=2/);
});
