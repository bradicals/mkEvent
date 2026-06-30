# HTTP Admin Create + Post-Item-Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Playwright browser spawn for event creation (bare events) and for the entire post-item-config phase with in-process HTTP calls through an admin session cookie jar, keeping the existing browser path as a fallback.

**Architecture:** A new in-process module `src/main/admin-http.cjs` logs into ClickBid admin over plain HTTP (`GET /admin/login.php` → scrape csrf → `POST /admin/index.php` → `POST /admin/organization.php`), holding cookies in a per-call jar, then drives the same admin AJAX endpoints the browser path already calls. The proxy server exposes two new in-process POST routes that dispatch to this module instead of forking `browser-fallback.cjs`. `creation-engine.js` tries the HTTP path first and falls back to the existing browser adapters on any error. The session cookie never leaves the main process, so it is never logged or exposed to the renderer.

**Tech Stack:** Node (Electron main process), global `fetch` (undici), `node:test` + `node:assert`, no new dependencies.

## Global Constraints

- **No new runtime dependencies.** Use global `fetch` and `URLSearchParams` only (proven in the spike).
- **Host allowlist enforced.** Every HTTP request resolves its hostname and rejects it unless it is in the proxy's allowlist (mirror `isHostAllowed` in `src/main/proxy-server.cjs`). Never follow a redirect to a non-allowlisted host.
- **Session cookie stays server-side.** The admin session cookie (`PHPSESSID`) must never be returned to the renderer, written to a result body, or logged. Only the in-process path may hold it.
- **HTTP path is primary, browser path is fallback.** Any error in the HTTP path must fall through to the existing `BrowserFallbackAdapter` / `BrowserPostItemConfigAdapter` — never fail the run outright when the browser path could still work.
- **Tests are `node --test`** (the project's `npm test`). No frameworks, no network — inject a fake `fetch`.
- **`fetch` is injectable.** Every exported function takes `{ fetchImpl = fetch }` so tests drive it with a fake. Production passes nothing.

---

## File Structure

- **Create `src/main/admin-http.cjs`** — in-process HTTP admin module. Responsibilities: cookie jar, login + org-select, `httpCreateEvent`, `httpApplyPostItemConfig`. Pure logic + injected `fetch`; no Playwright, no Electron APIs.
- **Create `src/main/admin-http.test.js`** — unit tests driving the module with a scripted fake `fetch`.
- **Modify `src/main/proxy-server.cjs`** — add two in-process POST routes (`/fallback/create-event-http`, `/fallback/post-item-config-http`) that validate the same fields/allowlist and call the new module. Add an injectable `runHttpAdmin` option (default = real module) so tests can stub it.
- **Modify `src/main/proxy-server.test.cjs`** — cover the two new routes (success + allowlist rejection).
- **Modify `browser-fallback.cjs`** — export the pure plan-builder helpers (`buildTicketPageItemAttachmentPlans`, `buildTicketPagePlans`) so the HTTP module reuses them instead of re-implementing (DRY).
- **Modify `event-model.js`** — add `httpCreateEvent(proxyUrl, payload)` and `httpApplyPostItemConfig(proxyUrl, payload)` fetch wrappers (mirror the existing `browserFallback*` wrappers).
- **Modify `creation-engine.js`** — try the HTTP path first in the create branch (bare-event case) and in the post-item-config branch; fall back to the browser adapters on error.
- **Modify `creation-engine.test.js`** — cover HTTP-first success and HTTP-error → browser-fallback for both phases.

**Architecture caveat (read before Task 6):** The browser `createEventViaAdmin` bundles create + auction settings + ticket-page settings in one session. The HTTP create only creates the event. So HTTP create is used **only when the recipe has no auction settings and no ticket-page settings** (`!auctionSettings?.enabled && !ticketPages?.enabled`) — the case where the browser create would otherwise *only* be creating. When either is enabled, the browser create runs as today (no regression). The post-item-config phase has no such caveat: it is 100% explicit AJAX, so HTTP always tries first.

---

## Task 1: Admin HTTP session + login

**Files:**
- Create: `src/main/admin-http.cjs`
- Test: `src/main/admin-http.test.js`

**Interfaces:**
- Produces:
  - `function createJar()` → `{ absorb(resp), header() }` — `absorb` reads `Set-Cookie` from a fetch `Response`; `header()` returns the `Cookie` request-header string.
  - `function assertAllowed(urlStr, allowlist)` → throws `Error('Host ... not allowed')` if `allowlist` is a non-empty `Set` and the URL's hostname is not in it; no-op if `allowlist` is null/undefined.
  - `function scrapeLoginForm(html)` → `{ action, inputs, userField, passField }` (hidden inputs incl. `csrf`; defaults `username`/`password`).
  - `function scrapeOrgForm(html)` → `{ action, hidden, selectName, options, hasSearch }`.
  - `async function adminLogin({ fetchImpl, baseUrl, adminEmail, adminPassword, organizationId, allowlist })` → `{ jar, request }` where `request(method, url, { form, headers })` applies cookies, follows redirects (carrying cookies, allowlist-checked, max 6), and returns `{ url, status, headers, body }`. Throws `Error('Admin login failed: ...')` on bounce-to-login; throws `Error('Organization selection failed: ...')` if still on select-organization after the org POST.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/main/admin-http.test.js`
Expected: FAIL — `Cannot find module './admin-http.cjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/main/admin-http.cjs
'use strict';

function createJar() {
  const jar = new Map();
  return {
    absorb(resp) {
      const list = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : [resp.headers.get('set-cookie')].filter(Boolean);
      for (const sc of list) {
        const [pair] = String(sc).split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

function assertAllowed(urlStr, allowlist) {
  if (!allowlist || typeof allowlist.has !== 'function' || allowlist.size === 0) return;
  let host = '';
  try { host = new URL(urlStr).hostname || ''; } catch (_) { host = ''; }
  if (!host || !allowlist.has(host)) throw new Error(`Host '${host || '(unknown)'}' is not an allowed ClickBid target.`);
}

function scrapeLoginForm(html) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const form = forms.find((f) => /type=["']password["']/i.test(f)) || forms[0] || '';
  const inputs = {};
  let userField = 'username', passField = 'password';
  for (const tag of form.match(/<input[^>]*>/gi) || []) {
    const name = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    if (!name) continue;
    const type = (tag.match(/type=["']([^"']+)["']/i) || [])[1] || 'text';
    const value = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || '';
    if (/password/i.test(type)) { passField = name; continue; }
    if (/^(text|email)$/i.test(type) && /user|email|login/i.test(name)) { userField = name; continue; }
    if (/hidden/i.test(type)) inputs[name] = value;
  }
  return { action: (form.match(/action=["']([^"']*)["']/i) || [])[1] || '/admin/index.php', inputs, userField, passField };
}

function scrapeOrgForm(html) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const form = forms.find((f) => /organization-id|Go To Organization|search-organization/i.test(f)) || '';
  const hidden = {};
  for (const tag of form.match(/<input[^>]*>/gi) || []) {
    const name = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    const type = (tag.match(/type=["']([^"']+)["']/i) || [])[1] || 'text';
    if (name && /hidden/i.test(type)) hidden[name] = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || '';
  }
  const selectM = form.match(/<select[^>]*name=["']([^"']+)["'][\s\S]*?<\/select>/i);
  return {
    action: (form.match(/action=["']([^"']*)["']/i) || [])[1] || '/admin/organization.php',
    hidden,
    selectName: selectM ? selectM[1] : null,
    options: selectM ? [...selectM[0].matchAll(/value=["']([^"']*)["']/gi)].map((m) => m[1]).filter(Boolean) : [],
    hasSearch: /id=["']search-organization["']/i.test(form),
  };
}

async function adminLogin({ fetchImpl = fetch, baseUrl, adminEmail, adminPassword, organizationId, allowlist }) {
  const base = String(baseUrl).replace(/\/$/, '');
  const jar = createJar();

  const raw = async (url, { method = 'GET', form, headers = {} } = {}) => {
    assertAllowed(url, allowlist);
    const resp = await fetchImpl(url, {
      method,
      headers: {
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
        Cookie: jar.header(),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual',
    });
    jar.absorb(resp);
    return resp;
  };

  // request() = raw + follow redirects (carrying cookies, allowlist-checked)
  const request = async (method, url, opts = {}) => {
    let resp = await raw(url, { method, ...opts });
    let cur = url, status = resp.status;
    for (let hop = 0; hop < 6; hop++) {
      const loc = resp.headers.get('location');
      if (!loc || status < 300 || status >= 400) break;
      cur = new URL(loc, cur).href;
      resp = await raw(cur, { method: 'GET' });
      status = resp.status;
    }
    return { url: cur, status, headers: resp.headers, body: await resp.text().catch(() => '') };
  };

  // 1. GET login page (csrf + session cookie)
  const loginUrl = `${base}/admin/login.php`;
  const getResp = await raw(loginUrl);
  const form = scrapeLoginForm(await getResp.text());

  // 2. POST credentials, follow to landing
  const action = new URL(form.action, loginUrl).href;
  const afterLogin = await request('POST', action, {
    form: { ...form.inputs, [form.userField]: adminEmail, [form.passField]: adminPassword },
  });
  if (/\/admin\/login\.php/i.test(afterLogin.url) || /type=["']password["']/i.test(afterLogin.body)) {
    throw new Error(`Admin login failed: landed on ${afterLogin.url}`);
  }

  // 3. Org selection if required
  if (/select-organization/i.test(afterLogin.url)) {
    const of = scrapeOrgForm(afterLogin.body);
    const orgAction = new URL(of.action, afterLogin.url).href;
    const field = of.selectName || 'organization-id';
    const afterOrg = await request('POST', orgAction, { form: { ...of.hidden, [field]: String(organizationId) } });
    if (/select-organization/i.test(afterOrg.url)) {
      throw new Error(`Organization selection failed for org ${organizationId} (still on select-organization)`);
    }
  }

  return { jar, request, base };
}

module.exports = { createJar, assertAllowed, scrapeLoginForm, scrapeOrgForm, adminLogin };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/main/admin-http.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/admin-http.cjs src/main/admin-http.test.js
git commit -m "feat(admin-http): HTTP admin login + org-select session"
```

---

## Task 2: HTTP create-event

**Files:**
- Modify: `src/main/admin-http.cjs`
- Test: `src/main/admin-http.test.js`

**Interfaces:**
- Consumes: `adminLogin` (Task 1).
- Produces: `async function httpCreateEvent(payload, { fetchImpl = fetch, allowlist } = {})` → `{ ok: true, eventId, eventSlug, eventName, adminUrl }`. `payload` = `{ baseUrl, organizationId, adminEmail, adminPassword, event: { slug, name, startDate, endDate, onCallDate, timezone, contactFirstName, contactLastName, contactEmail, contactPhone } }`. Throws on login failure or a create response that is not `success:true`.

- [ ] **Step 1: Write the failing test**

```javascript
// append to src/main/admin-http.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/main/admin-http.test.js`
Expected: FAIL — `httpCreateEvent is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// in src/main/admin-http.cjs — add before module.exports
function toDateOnly(value) {
  if (!value) return '';
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
function digitsOnly(value) { return String(value || '').replace(/\D/g, ''); }

function parseEventResult(body) {
  let json = body;
  if (typeof body === 'string') { try { json = JSON.parse(body); } catch (_) { json = { success: false, message: body }; } }
  const id = json.id ?? json.data?.id ?? (typeof json.html === 'string' ? (json.html.match(/data-id=["'](\d+)["']/) || [])[1] : null);
  return { json, id: id ? String(id) : null };
}

async function httpCreateEvent(payload, { fetchImpl = fetch, allowlist } = {}) {
  const base = String(payload.baseUrl).replace(/\/$/, '');
  const session = await adminLogin({
    fetchImpl, baseUrl: base, adminEmail: payload.adminEmail, adminPassword: payload.adminPassword,
    organizationId: payload.organizationId, allowlist,
  });
  const e = payload.event;
  const form = {
    action: 'create-event', reuseKeyword: '', keyword: e.slug, eventName: e.name,
    eventStartDate: toDateOnly(e.startDate), eventClosingDate: toDateOnly(e.endDate),
    eventOnCallDate: toDateOnly(e.onCallDate || e.endDate || e.startDate),
    timeZone: e.timezone || 'America/Chicago', openAuctionEarly: 'true',
    firstName: e.contactFirstName, lastName: e.contactLastName, email: e.contactEmail, phone: digitsOnly(e.contactPhone),
    copyFromEvent: '0',
  };
  const resp = await session.request('POST', `${base}/ajax/admin/organization/events.php`, {
    form, headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const { json, id } = parseEventResult(resp.body);
  if (resp.status >= 400 || json.success === false) {
    const msg = json.message || `HTTP ${resp.status}`;
    if (/keyword/i.test(msg) && /already/i.test(msg)) throw new Error(`Event keyword "${e.slug}" is already in use on ClickBid. ${msg}`);
    throw new Error(`HTTP event creation failed: ${msg}`);
  }
  if (!id) throw new Error(`HTTP event creation succeeded but no event ID found. Body: ${String(resp.body).slice(0, 300)}`);
  const eventSlug = json.slug ?? json.data?.slug ?? e.slug;
  return { ok: true, eventId: id, eventSlug, eventName: e.name, adminUrl: `${base}/events/${eventSlug}` };
}

// add httpCreateEvent, toDateOnly, digitsOnly, parseEventResult to module.exports
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/main/admin-http.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/main/admin-http.cjs src/main/admin-http.test.js
git commit -m "feat(admin-http): create event over HTTP (parse data-id from response)"
```

---

## Task 3: HTTP post-item-config

**Files:**
- Modify: `browser-fallback.cjs` (export pure helpers)
- Modify: `src/main/admin-http.cjs`
- Test: `src/main/admin-http.test.js`

**Interfaces:**
- Consumes: `adminLogin` (Task 1); `buildTicketPageItemAttachmentPlans` from `browser-fallback.cjs`.
- Produces: `async function httpApplyPostItemConfig(payload, { fetchImpl = fetch, allowlist } = {})` → `{ ok: true, eventId, postItemConfig: { applied, skipped, warnings } }`. `payload` = `{ baseUrl, organizationId, adminEmail, adminPassword, eventId, quantityItems, donationItems, ticketPages }` (same shape `BrowserPostItemConfigAdapter.apply` sends).

**Mechanics (mirror of `applyPostItemConfig`, browser-fallback.cjs:2699-2773):**
1. login (org in session).
2. `POST /admin/event.php` with `event-id=<eventId>` → set the event active in session (HTTP twin of `switchToEvent`).
3. `GET /butler/event-utilities.php` → scrape `<meta name="csrf-token" content="...">` (HTTP twin of `fetchCsrfTokenFromButler`).
4. Per quantity item tier: `POST /ajax/admin/manage-items.php` (`action=set_item_quantity`, `id=new`, `quantity`, `price`, `item_id`) with header `X-CSRF-TOKEN`.
5. Per ticket-page plan with resolved items: `GET /admin/ticket_form.php?form_name=<name>` → scrape `<input id="ticket-form-id" value="...">` → `POST /ajax/admin/ticket-form.php` (`action=sync-items`, `formId`, repeated `itemIds[]`).

- [ ] **Step 1: Export the pure helper from browser-fallback.cjs**

In `browser-fallback.cjs`, add `buildTicketPageItemAttachmentPlans` and `buildTicketPagePlans` to `module.exports` (the object near line 3014). They are already defined and pure (no `page` use).

- [ ] **Step 2: Write the failing test**

```javascript
// append to src/main/admin-http.test.js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test src/main/admin-http.test.js`
Expected: FAIL — `httpApplyPostItemConfig is not a function`.

- [ ] **Step 4: Write minimal implementation**

```javascript
// in src/main/admin-http.cjs
const { buildTicketPageItemAttachmentPlans } = require('../../browser-fallback.cjs');

function scrapeCsrfMeta(html) {
  return (html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']csrf-token["']/i) || [])[1] || '';
}
function scrapeTicketFormId(html) {
  return (html.match(/id=["']ticket-form-id["'][^>]*value=["']([^"']*)["']/i)
    || html.match(/value=["']([^"']*)["'][^>]*id=["']ticket-form-id["']/i) || [])[1] || '';
}

async function httpApplyPostItemConfig(payload, { fetchImpl = fetch, allowlist } = {}) {
  const base = String(payload.baseUrl).replace(/\/$/, '');
  const session = await adminLogin({
    fetchImpl, baseUrl: base, adminEmail: payload.adminEmail, adminPassword: payload.adminPassword,
    organizationId: payload.organizationId, allowlist,
  });
  // switchToEvent equivalent
  await session.request('POST', `${base}/admin/event.php`, { form: { 'event-id': String(payload.eventId) } });
  // csrf from butler
  const butler = await session.request('GET', `${base}/butler/event-utilities.php`);
  const csrf = scrapeCsrfMeta(butler.body);

  const applied = [], skipped = [], warnings = [];
  const postForm = (url, form, headers) => session.request('POST', url, {
    form, headers: { 'X-Requested-With': 'XMLHttpRequest', ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}), ...(headers || {}) },
  });

  const quantityItems = Array.isArray(payload.quantityItems) ? payload.quantityItems : [];
  for (const item of quantityItems) {
    for (const tier of (Array.isArray(item.quantity_tiers) ? item.quantity_tiers : [])) {
      const quantity = Math.max(1, Number(tier?.quantity) || 0);
      const price = Math.max(0, Number(tier?.price) || 0);
      if (!quantity) { skipped.push({ section: 'quantityItemTier', itemId: String(item.id), reason: 'missing quantity' }); continue; }
      const r = await postForm(`${base}/ajax/admin/manage-items.php`, { action: 'set_item_quantity', id: 'new', quantity: String(quantity), price: String(price), item_id: String(item.id) });
      let ok = r.status < 400;
      try { ok = ok && JSON.parse(r.body)?.success !== false; } catch (_) { /* non-JSON 200 treated by status */ }
      if (!ok) { warnings.push({ section: 'quantityItemTier', itemId: String(item.id), message: `tier save failed (HTTP ${r.status})` }); continue; }
      applied.push({ section: 'quantityItemTier', itemId: String(item.id), itemName: item.item_name || 'Quantity item', quantity, price });
    }
  }

  const plans = buildTicketPageItemAttachmentPlans(payload.ticketPages, quantityItems, Array.isArray(payload.donationItems) ? payload.donationItems : []);
  for (const plan of plans) {
    if (plan.resolvedItems.length === 0) continue;
    const form = await session.request('GET', `${base}/admin/ticket_form.php?form_name=${encodeURIComponent(plan.formName)}`);
    const formId = scrapeTicketFormId(form.body);
    const body = new URLSearchParams();
    body.append('action', 'sync-items'); body.append('formId', String(formId));
    for (const it of plan.resolvedItems) body.append('itemIds[]', String(it.id));
    const r = await postForm(`${base}/ajax/admin/ticket-form.php`, body);
    let ok = r.status < 400;
    try { ok = ok && JSON.parse(r.body)?.success !== false; } catch (_) {}
    if (!ok) warnings.push({ section: 'ticketPageItems', formName: plan.formName, message: `sync-items failed (HTTP ${r.status})` });
    else applied.push({ section: 'ticketPageItems', formName: plan.formName, itemCount: plan.resolvedItems.length });
  }

  return { ok: true, eventId: String(payload.eventId), postItemConfig: { applied, skipped, warnings } };
}

// NOTE: postForm accepts a URLSearchParams directly for the ticket-form case;
// extend the session.request `form` handling to pass through a URLSearchParams as-is:
//   body: form instanceof URLSearchParams ? form.toString() : (form ? new URLSearchParams(form).toString() : undefined)
// Update the `raw()` body line in adminLogin accordingly.

// add httpApplyPostItemConfig to module.exports
```

Also update the `raw()` body line in `adminLogin` (Task 1) to accept a pre-built `URLSearchParams`:

```javascript
body: form ? (form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString()) : undefined,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/main/admin-http.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full suite (helper export didn't break browser-fallback)**

Run: `npm test`
Expected: PASS (existing `browser-fallback.test.js` still green).

- [ ] **Step 7: Commit**

```bash
git add browser-fallback.cjs src/main/admin-http.cjs src/main/admin-http.test.js
git commit -m "feat(admin-http): post-item-config (quantity tiers + ticket-page item sync) over HTTP"
```

---

## Task 4: Proxy routes for the HTTP admin paths

**Files:**
- Modify: `src/main/proxy-server.cjs`
- Modify: `src/main/proxy-manager.cjs` (pass `runHttpAdmin` into the server)
- Test: `src/main/proxy-server.test.cjs`

**Interfaces:**
- Consumes: `httpCreateEvent`, `httpApplyPostItemConfig` (Tasks 2-3).
- Produces: POST `/fallback/create-event-http` and `/fallback/post-item-config-http`. Same field-validation + allowlist + `fallback_request` logging (redacted) as the spawn routes. Dispatches to an injectable `runHttpAdmin(action, payload, allowlist)` (default wraps the real module). Result JSON returned via `sendJson`; the session cookie is never in the result, so nothing sensitive is logged.

- [ ] **Step 1: Write the failing test**

```javascript
// in src/main/proxy-server.test.cjs — add a test using a stub runHttpAdmin
// (follow the file's existing pattern for starting the server with options)
test('POST /fallback/create-event-http dispatches to runHttpAdmin', async () => {
  const server = createProxyServer({
    allowlist: new Set(['cbotriage.bid']),
    runHttpAdmin: async (action, payload) => ({ ok: true, action, eventId: '4591', eventSlug: payload.event.slug }),
    logger: () => {},
  });
  // ...start, POST JSON {baseUrl, organizationId, adminEmail, adminPassword, event:{slug:'x'}}, assert 200 + eventId 4591
});

test('POST /fallback/create-event-http rejects non-allowlisted host', async () => {
  // baseUrl https://evil.example → expect 403
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/main/proxy-server.test.cjs`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement the routes**

In `src/main/proxy-server.cjs`:

```javascript
// add to FALLBACK_REQUIRED
'create-event-http': ['baseUrl', 'organizationId', 'adminEmail', 'adminPassword', 'event'],
'post-item-config-http': ['baseUrl', 'organizationId', 'adminEmail', 'adminPassword', 'eventId'],
```

```javascript
// in createProxyServer signature: destructure runHttpAdmin from options
const { /* existing */ runHttpAdmin } = options;
```

In the `if (isFallback)` block, branch HTTP actions to `runHttpAdmin` instead of `runBrowserFallback`:

```javascript
const isHttp = action.endsWith('-http');
if (isHttp) {
  if (typeof runHttpAdmin !== 'function') { sendFallbackError(res, 501, 'HTTP admin runner is not configured', 'http_admin_unavailable'); return; }
  try {
    const result = await runHttpAdmin(action, body, allowlist);
    sendJson(res, 200, result);
  } catch (err) {
    sendFallbackError(res, 502, (err && err.message) || 'http admin failed', 'http_admin_error');
  }
  return;
}
// else existing runBrowserFallback path
```

In `src/main/proxy-manager.cjs`, wire a default `runHttpAdmin`:

```javascript
const adminHttp = require('./admin-http.cjs');
function makeRunHttpAdmin() {
  return async function runHttpAdmin(action, payload, allowlist) {
    if (action === 'create-event-http') return adminHttp.httpCreateEvent(payload, { allowlist });
    if (action === 'post-item-config-http') return adminHttp.httpApplyPostItemConfig(payload, { allowlist });
    throw new Error(`Unknown HTTP admin action: ${action}`);
  };
}
// pass runHttpAdmin: makeRunHttpAdmin() into startProxyServer({ ... })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/main/proxy-server.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/proxy-server.cjs src/main/proxy-manager.cjs src/main/proxy-server.test.cjs
git commit -m "feat(proxy): in-process /fallback/*-http routes for HTTP admin"
```

---

## Task 5: event-model.js wrappers

**Files:**
- Modify: `event-model.js`
- Test: `event-model.test.js`

**Interfaces:**
- Consumes: proxy routes (Task 4).
- Produces: `httpCreateEvent(proxyUrl, payload)` and `httpApplyPostItemConfig(proxyUrl, payload)` — mirror `browserFallbackCreateEvent` (event-model.js:1704) exactly, posting to `/fallback/create-event-http` and `/fallback/post-item-config-http`. Add both to the returned module object.

- [ ] **Step 1: Write the failing test**

```javascript
// event-model.test.js — mirror the existing browserFallbackCreateEvent test (line 1161)
test('httpCreateEvent posts to the http create endpoint', async () => {
  // stub global fetch to assert URL ends with /fallback/create-event-http and returns { ok:true, eventId:'4591' }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test event-model.test.js`
Expected: FAIL — `model.httpCreateEvent is not a function`.

- [ ] **Step 3: Implement the wrappers**

```javascript
// event-model.js — beside browserFallbackCreateEvent (copy its body, change the path)
async function httpCreateEvent(proxyUrl, payload) {
  const response = await fetch(proxyToolUrl(proxyUrl, '/fallback/create-event-http'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
  });
  let data;
  try { data = await response.json(); } catch (_) { const t = await response.text().catch(() => ''); throw new Error(t || `HTTP create failed with HTTP ${response.status}`); }
  if (response.ok && data?.ok) return data;
  throw new Error(data?.message || data?.error || `HTTP create failed with HTTP ${response.status}`);
}
async function httpApplyPostItemConfig(proxyUrl, payload) {
  const response = await fetch(proxyToolUrl(proxyUrl, '/fallback/post-item-config-http'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
  });
  let data;
  try { data = await response.json(); } catch (_) { const t = await response.text().catch(() => ''); throw new Error(t || `HTTP post-item config failed with HTTP ${response.status}`); }
  if (response.ok && data?.ok) return data;
  throw new Error(data?.message || data?.error || `HTTP post-item config failed with HTTP ${response.status}`);
}
// add httpCreateEvent, httpApplyPostItemConfig to the returned object (near line 1782)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test event-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add event-model.js event-model.test.js
git commit -m "feat(model): httpCreateEvent + httpApplyPostItemConfig proxy wrappers"
```

---

## Task 6: Wire HTTP-first into the orchestrator

**Files:**
- Modify: `creation-engine.js`
- Test: `creation-engine.test.js`

**Interfaces:**
- Consumes: `MODEL.httpCreateEvent`, `MODEL.httpApplyPostItemConfig` (Task 5); existing `BrowserFallbackAdapter`, `BrowserPostItemConfigAdapter`.
- Produces: HTTP-first behavior with browser fallback in both phases.

**Behavior:**
- **Create** (where the engine currently calls `new BrowserFallbackAdapter(client, progress).create(config, recipe, err)`): if `!recipe.auctionSettings?.enabled && !recipe.ticketPages?.enabled` and admin creds are present, try `MODEL.httpCreateEvent` first; on success return its result shaped like the browser result (`{ created, id, adminUrl, publicUrl }`); on throw, log and continue to the browser adapter. When auction/ticket settings are enabled, skip straight to the browser adapter (unchanged).
- **Post-item-config** (line 680, where it calls `BrowserPostItemConfigAdapter`): try `MODEL.httpApplyPostItemConfig` first; on throw, log and fall back to the browser adapter.

- [ ] **Step 1: Write the failing test**

```javascript
// creation-engine.test.js — stub MODEL.httpCreateEvent to return { ok:true, eventId:'4591', eventSlug:'x', adminUrl:'...' }
// for a recipe with no auctionSettings/ticketPages, assert the browser fallback is NOT called and eventId is 4591.
// Second test: make MODEL.httpCreateEvent throw, assert it falls back to browserFallbackCreateEvent.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test creation-engine.test.js`
Expected: FAIL (HTTP path not wired).

- [ ] **Step 3: Implement a helper + wire both phases**

```javascript
// creation-engine.js — add a small adapter that mirrors the browser create result shape
async function tryHttpCreate(config, recipe, progress) {
  if (recipe.auctionSettings?.enabled || recipe.ticketPages?.enabled) return null; // browser bundles those
  if (!config.api.adminEmail || !config.api.adminPassword) return null;
  progress.info('event', 'Trying HTTP admin create (no browser)…');
  const r = await MODEL.httpCreateEvent(config.api.proxyUrl, {
    baseUrl: recipe.environment.baseUrl, organizationId: recipe.environment.organizationId,
    adminEmail: config.api.adminEmail, adminPassword: config.api.adminPassword,
    event: { slug: recipe.event.slug, name: recipe.event.name, startDate: recipe.event.startDate, endDate: recipe.event.endDate, onCallDate: recipe.event.onCallDate || recipe.event.endDate || recipe.event.startDate, timezone: recipe.event.timezone, contactFirstName: recipe.event.contactFirstName, contactLastName: recipe.event.contactLastName, contactEmail: recipe.event.contactEmail, contactPhone: digitsOnly(recipe.event.contactPhone) },
  });
  progress.ok('event', `HTTP admin created event.id=${r.eventId}, keyword=${recipe.event.slug}`);
  return { created: r, id: r.eventId, adminUrl: r.adminUrl, publicUrl: MODEL.buildPublicEventUrl(recipe.environment.baseUrl, recipe.event.slug) };
}
```

Wrap each browser-create call site (there are three `new BrowserFallbackAdapter(...).create(...)` in `createEvent`'s create branch). Factor them through one path:

```javascript
// replace the create-branch body that produces `eventCreation` with:
eventCreation = null;
try { eventCreation = await tryHttpCreate(config, recipe, progress); }
catch (httpErr) { progress.info('event', `HTTP admin create failed (${httpErr.message}); using browser fallback…`); }
if (!eventCreation) {
  // existing branch logic (shouldPreferBrowserFallback / hostedRouteKnownUnavailable / API-first) unchanged,
  // each ending in `new BrowserFallbackAdapter(client, progress).create(...)`.
}
```

For post-item-config (line ~680):

```javascript
} else {
  progress.run('ticket-pages', 'Applying ticket-page item attachments and quantity tiers…');
  try {
    await MODEL.httpApplyPostItemConfig(config.api.proxyUrl, {
      baseUrl: recipe.environment.baseUrl, organizationId: recipe.environment.organizationId,
      adminEmail: config.api.adminEmail, adminPassword: config.api.adminPassword,
      eventId, quantityItems: createdQuantityItems, donationItems: createdDonationItems, ticketPages: recipe.ticketPages,
    });
  } catch (httpErr) {
    progress.info('ticket-pages', `HTTP post-item config failed (${httpErr.message}); using browser fallback…`);
    await new BrowserPostItemConfigAdapter(progress).apply(config, recipe, eventId, createdQuantityItems, createdDonationItems);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test creation-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add creation-engine.js creation-engine.test.js
git commit -m "feat(engine): HTTP-first create + post-item-config with browser fallback"
```

---

## Task 7: Manual end-to-end verification

**Files:** none (runtime check).

- [ ] **Step 1: Bare event (HTTP create path).** In the app, create an event on cbotriage.bid (org 2518) with auction settings and ticket pages OFF, admin creds set. Confirm the log shows "HTTP admin created event.id=…" and **no** browser fallback launches. Delete the test event after.

- [ ] **Step 2: Ticket-page items (HTTP post-item-config).** Create an event with quantity items attached to a ticket page. Confirm the log shows the HTTP post-item config running (no `applyPostItemConfig` browser spawn), and the items appear attached in ClickBid admin.

- [ ] **Step 3: Fallback intact.** Temporarily set a wrong admin password; confirm the create still completes via the browser fallback path (HTTP fails → browser runs), proving the safety net.

- [ ] **Step 4: Full recipe unaffected.** Create an event WITH auction settings enabled; confirm it still uses the browser create (bundled settings) and succeeds — no regression.

---

## Self-Review Notes

- **Spec coverage:** Create-over-HTTP → Tasks 2,6. Explicit-AJAX post-event bits (quantity tiers + ticket-page item sync) → Tasks 3,6. Session/login foundation → Task 1. Wiring + fallback → Tasks 4,5,6. Manual proof → Task 7.
- **Out of scope (documented):** auction settings, ticket-page rename/title, mobile-checkin reset, and post-create activity remain on Playwright (opaque DOM/UI-driven; reverse-engineering them is fragile). Server-side cookie hand-off into the Playwright phases is a possible follow-up, not in this plan.
- **Security:** session cookie lives only in `admin-http.cjs` in the main process; never returned in a result body, never logged (`fallback_request` logging stays redacted; the in-process routes don't go through the unredacted `browser_fallback_exit` stdout log at all).
- **Type consistency:** result shapes returned by `httpCreateEvent` (`{ ok, eventId, eventSlug, eventName, adminUrl }`) and `httpApplyPostItemConfig` (`{ ok, eventId, postItemConfig:{applied,skipped,warnings} }`) match what Tasks 5-6 consume.
