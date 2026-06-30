// src/main/admin-http.cjs
'use strict';

const { buildTicketPageItemAttachmentPlans } = require('../../browser-fallback.cjs');

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
      body: form ? (form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString()) : undefined,
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

  await session.request('POST', `${base}/admin/event.php`, { form: { 'event-id': String(payload.eventId) } });

  const butler = await session.request('GET', `${base}/butler/event-utilities.php`);
  const csrf = scrapeCsrfMeta(butler.body);

  const applied = [], skipped = [], warnings = [];
  const postForm = (url, form) => session.request('POST', url, {
    form, headers: { 'X-Requested-With': 'XMLHttpRequest', ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}) },
  });

  const quantityItems = Array.isArray(payload.quantityItems) ? payload.quantityItems : [];
  for (const item of quantityItems) {
    for (const tier of (Array.isArray(item.quantity_tiers) ? item.quantity_tiers : [])) {
      const quantity = Number(tier?.quantity) || 0;
      const price = Math.max(0, Number(tier?.price) || 0);
      if (!quantity) { skipped.push({ section: 'quantityItemTier', itemId: String(item.id), reason: 'missing quantity' }); continue; }
      const r = await postForm(`${base}/ajax/admin/manage-items.php`, { action: 'set_item_quantity', id: 'new', quantity: String(quantity), price: String(price), item_id: String(item.id) });
      let ok = r.status < 400;
      try { ok = ok && JSON.parse(r.body)?.success !== false; } catch (_) {}
      if (!ok) { warnings.push({ section: 'quantityItemTier', itemId: String(item.id), message: `tier save failed (HTTP ${r.status})` }); continue; }
      applied.push({ section: 'quantityItemTier', itemId: String(item.id), itemName: item.item_name || 'Quantity item', quantity, price });
    }
  }

  const donationItems = Array.isArray(payload.donationItems) ? payload.donationItems : [];
  const plans = buildTicketPageItemAttachmentPlans(payload.ticketPages, quantityItems, donationItems);
  for (const plan of plans) {
    if (plan.resolvedItems.length === 0) continue;
    const form = await session.request('GET', `${base}/admin/ticket_form.php?form_name=${encodeURIComponent(plan.formName)}`);
    const formId = scrapeTicketFormId(form.body);
    const body = new URLSearchParams();
    body.append('action', 'sync-items');
    body.append('formId', String(formId));
    for (const it of plan.resolvedItems) body.append('itemIds[]', String(it.id));
    const r = await postForm(`${base}/ajax/admin/ticket-form.php`, body);
    let ok = r.status < 400;
    try { ok = ok && JSON.parse(r.body)?.success !== false; } catch (_) {}
    if (!ok) warnings.push({ section: 'ticketPageItems', formName: plan.formName, message: `sync-items failed (HTTP ${r.status})` });
    else applied.push({ section: 'ticketPageItems', formName: plan.formName, itemCount: plan.resolvedItems.length });
  }

  return { ok: true, eventId: String(payload.eventId), postItemConfig: { applied, skipped, warnings } };
}

module.exports = { createJar, assertAllowed, scrapeLoginForm, scrapeOrgForm, adminLogin, httpCreateEvent, httpApplyPostItemConfig, scrapeCsrfMeta, scrapeTicketFormId, toDateOnly, digitsOnly, parseEventResult };
