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
