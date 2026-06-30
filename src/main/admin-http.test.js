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
