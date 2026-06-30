#!/usr/bin/env node

/**
 * Browser-based event creation fallback for mkEvent.
 *
 * When the V4 REST API's POST /organizations/{org}/events route is unavailable
 * ("Unrecognized endpoint"), this script drives a headless Chromium through the
 * admin UI to create the event via the internal AJAX endpoint.
 *
 * Flow (mirrors clickbid-tests/tests/setup/event-setup.spec.ts Phase 0):
 *   1. Login at /admin/login.php
 *   2. Handle "Select Organization" page if it appears (super-user search path)
 *   3. Navigate to /butler/event-utilities.php to grab a CSRF token
 *   4. POST to /ajax/admin/organization/events.php with all event data
 *   5. Parse JSON response → return { ok, eventId, eventSlug, adminUrl, publicUrl }
 */

const { fakerEN_US } = require('@faker-js/faker');
const API_TICKET_PURCHASE_CONCURRENCY = 4;
// Browser/Stripe checkout purchases (credit card, and donation-bearing purchases
// routed there) run in parallel up to this limit. Raised from 2 to 4 to cut
// post-create time; override with MKEVENT_CC_PURCHASE_CONCURRENCY if stage/Stripe
// rate-limits show up (lower it) or the host can handle more (raise it).
const CREDIT_CARD_TICKET_PURCHASE_CONCURRENCY = Math.max(
  1,
  Number(process.env.MKEVENT_CC_PURCHASE_CONCURRENCY) || 4,
);
// How long to wait for the public checkout's "Add" control to render before
// giving up on a browser ticket purchase. ponytail: short, non-retryable — when
// the ticket-page JS doesn't render (e.g. the bidapp asset bundles 403 from the
// CDN, or markup shifts), the button never appears, so a long actionability wait
// would just hang ~30s per attempt. Fail fast with a clear cause instead.
const TICKET_ADD_BUTTON_TIMEOUT_MS = 12000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data || '{}'));
    process.stdin.on('error', reject);
  });
}

function resolvePlaywrightCandidate(candidate) {
  if (!candidate) return null;
  const mod = require(candidate);
  if (mod.chromium || mod.firefox || mod.webkit) return mod;
  if (mod.playwright && (mod.playwright.chromium || mod.playwright.firefox || mod.playwright.webkit)) {
    return mod.playwright;
  }
  return null;
}

function requirePlaywright() {
  const explicit = process.env.MKEVENT_PLAYWRIGHT_MODULE;
  const candidates = [
    explicit,
    'playwright',
    '@playwright/test',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const mod = resolvePlaywrightCandidate(candidate);
      if (mod) return mod;
    } catch (_) {
      // try next
    }
  }

  throw new Error(
    'Playwright is not installed for mkEvent browser fallback. Install playwright in ~/mkEvent (for example: npm install playwright && npx playwright install chromium) or set MKEVENT_PLAYWRIGHT_MODULE to a resolvable module path.'
  );
}

function toDateOnly(dateStr) {
  return String(dateStr || '').trim().split(/[ T]/)[0] || '';
}

/**
 * Handle the "Select Organization" page that appears for multi-org/super users.
 *
 * Mirrors SelectOrganizationPage POM from clickbid-tests:
 *   - Super user path: fill #search-organization, click result li[data-id], click "Go To Organization"
 *   - Non-super path: select#organization-id dropdown
 *
 * Returns true if org selection was performed, false if not needed.
 */
async function maybeSelectOrganization(page, organizationId) {
  // Wait for post-login navigation to settle
  await page.waitForURL(
    /.*\/(select-organization|organizations|events|welcome)/,
    { timeout: 30000 },
  );

  // If we didn't land on select-organization, nothing to do
  if (!page.url().includes('select-organization.php')) {
    return false;
  }

  // Try the super-user search path first (mirrors the POM's isSuperUser=true)
  // The POM just fills + waits — no count() guard that could race with DOM load.
  const searchInput = page.locator('#search-organization');
  try {
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    // Super-user search path
    await searchInput.fill(String(organizationId));
    const resultItem = page
      .locator('.search-results-list-org')
      .locator(`li[data-id="${organizationId}"]`);
    await resultItem.waitFor({ state: 'visible', timeout: 10000 });
    await resultItem.click();
  } catch (_) {
    // Search input not found or no results — fall through to dropdown
    await page.locator('select#organization-id').selectOption({ value: String(organizationId) });
  }

  await page.getByRole('button', { name: 'Go To Organization' }).click();
  await page.waitForLoadState('domcontentloaded');
  return true;
}


async function switchToEvent(page, baseUrl, eventId) {
  process.stderr.write(`[fallback] Switching session to new event ${eventId}...\n`);
  await page.goto(`${baseUrl}/admin/event.php`, { waitUntil: 'domcontentloaded' });
  const navPromise = page.waitForURL(/welcome\.php/, { timeout: 10000, waitUntil: 'domcontentloaded' });
  await page.evaluate((targetEventId) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/admin/event.php';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'event-id';
    input.value = targetEventId;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }, String(eventId));
  await navPromise;
  process.stderr.write(`[fallback] Switched to event, URL: ${page.url()}\n`);
}

async function waitForAjax(page, action, timeout = 15000) {
  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes('/ajax/') && resp.status() < 500,
      { timeout },
    ),
    action(),
  ]);
}

async function setSelectValue(page, selector, value) {
  if (value === undefined || value === null || value === '') {
    return { selector, skipped: true, reason: 'no value requested' };
  }

  const state = await page.evaluate((sel) => {
    const field = document.querySelector(sel);
    if (!field) return { exists: false };
    return {
      exists: true,
      value: field.value,
      disabled: Boolean(field.disabled),
      options: Array.from(field.options || []).map((option) => option.value),
    };
  }, selector);

  if (!state.exists) return { selector, skipped: true, reason: 'field not present' };
  if (state.disabled) return { selector, skipped: true, reason: 'field disabled' };
  const stringValue = String(value);
  if (state.options.length && !state.options.includes(stringValue)) {
    return { selector, skipped: true, reason: `option ${stringValue} not available` };
  }
  if (state.value === stringValue) {
    return { selector, skipped: true, reason: 'already set', value: stringValue };
  }

  await waitForAjax(page, () => page.evaluate(({ sel, val }) => {
    const field = document.querySelector(sel);
    field.value = val;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: stringValue }));

  return { selector, applied: true, value: stringValue };
}

async function setInputValue(page, selector, value) {
  if (value === undefined || value === null || value === '') {
    return { selector, skipped: true, reason: 'no value requested' };
  }

  const state = await page.evaluate((sel) => {
    const field = document.querySelector(sel);
    if (!field) return { exists: false };
    return { exists: true, value: field.value, disabled: Boolean(field.disabled) };
  }, selector);

  if (!state.exists) return { selector, skipped: true, reason: 'field not present' };
  if (state.disabled) return { selector, skipped: true, reason: 'field disabled' };
  const stringValue = String(value);
  if (state.value === stringValue) {
    return { selector, skipped: true, reason: 'already set', value: stringValue };
  }

  await waitForAjax(page, () => page.evaluate(({ sel, val }) => {
    const field = document.querySelector(sel);
    field.value = val;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: stringValue }));

  return { selector, applied: true, value: stringValue };
}

async function stripeOnboardingPost(page, action) {
  return page.evaluate(async (postAction) => {
    const body = new URLSearchParams({ action: postAction });
    const response = await fetch('/ajax/v3/stripe_onboarding.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { success: false, message: text };
    }
    return { status: response.status, body: json };
  }, action);
}

async function assignExistingMerchantAccount(page) {
  process.stderr.write('[fallback] Checking for existing Stripe merchant account...\n');
  const check = await stripeOnboardingPost(page, 'check_existing_account');
  if (check.status >= 400 || !check.body?.success) {
    return {
      selector: '#stripe-registration',
      skipped: true,
      action: 'check_existing_account',
      reason: check.body?.message || `check failed with HTTP ${check.status}`,
    };
  }

  if (!check.body.alreadyExists) {
    return {
      selector: '#stripe-registration',
      skipped: true,
      action: 'check_existing_account',
      reason: 'no existing Stripe account found for this EIN',
      check: { id: check.body.id, ein: check.body.ein, countryId: check.body.countryId },
    };
  }

  process.stderr.write('[fallback] Assigning existing Stripe merchant account via AJAX...\n');
  const assign = await stripeOnboardingPost(page, 'assign_existing_account');
  if (assign.status >= 400 || !assign.body?.success) {
    return {
      selector: '#stripe-registration',
      skipped: true,
      action: 'assign_existing_account',
      reason: assign.body?.message || `assign failed with HTTP ${assign.status}`,
    };
  }

  return {
    selector: '#stripe-registration',
    applied: true,
    action: 'assign_existing_account',
    message: assign.body.message || 'Account has been updated',
  };
}

async function resetMobileCheckin(page) {
  const current = await page.evaluate(() => {
    const field = document.querySelector('#onchange-mobile_checkin_start');
    return field ? field.value : null;
  });
  if (current === null) return { selector: '.checkin_reset_btn', skipped: true, reason: 'mobile check-in field not present' };
  if (current === '') return { selector: '.checkin_reset_btn', skipped: true, reason: 'already blank' };

  await waitForAjax(page, () => page.evaluate(() => {
    const button = document.querySelector('.checkin_reset_btn');
    if (button) button.click();
  }));
  return { selector: '.checkin_reset_btn', applied: true };
}

async function waitForLoginOutcome(page, timeout = 30000) {
  const urlPromise = page.waitForURL(
    /.*\/(select-organization|organizations|events|welcome)/,
    { timeout },
  ).then(() => ({ ok: true, url: page.url() }));

  const errorPromise = page.locator('.alert, .alert-warning, .alert-danger, .error, [role="alert"]')
    .filter({ hasText: /Credentials could not be matched|invalid|incorrect|not matched|failed/i })
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(async () => ({
      ok: false,
      message: (await page.locator('.alert, .alert-warning, .alert-danger, .error, [role="alert"]')
        .filter({ hasText: /Credentials could not be matched|invalid|incorrect|not matched|failed/i })
        .first()
        .innerText()).trim(),
    }));

  const result = await Promise.race([urlPromise, errorPromise]);
  if (!result.ok) {
    throw new Error(`Admin login failed: ${result.message}`);
  }
  return result;
}

async function loginToAdminSession(page, payload) {
  process.stderr.write(`[fallback] Navigating to login: ${payload.baseUrl}/admin/login.php\n`);
  await page.goto(`${payload.baseUrl}/admin/login.php`, { waitUntil: 'domcontentloaded' });
  process.stderr.write(`[fallback] Login page URL: ${page.url()}\n`);
  await page.locator('#username').fill(payload.adminEmail);
  await page.locator('#password').fill(payload.adminPassword);
  await page.locator('#login').click();
  process.stderr.write('[fallback] Login clicked, waiting for post-login navigation...\n');
  await waitForLoginOutcome(page, 30000);
  process.stderr.write(`[fallback] Post-login URL: ${page.url()}\n`);
  await maybeSelectOrganization(page, payload.organizationId);
  process.stderr.write(`[fallback] After org selection, URL: ${page.url()}\n`);
}

async function ensureSessionEventContext(page, payload) {
  const currentUrl = page.url();
  if (!currentUrl.includes('/admin/welcome.php')) {
    process.stderr.write('[fallback] Selecting first event for session context...\n');
    const firstCard = page.locator('div.event-card').first();
    await firstCard.waitFor({ state: 'visible', timeout: 15000 });
    const eventAdminButton = firstCard.getByRole('button', { name: 'Event Admin' });
    await eventAdminButton.click();
    await page.waitForURL(/.*\/(welcome|manage)/, { timeout: 15000 });
    process.stderr.write(`[fallback] Event selected, URL: ${page.url()}\n`);
  } else {
    process.stderr.write('[fallback] Already on welcome page (single-event org), session OK.\n');
  }
}

async function fetchCsrfTokenFromButler(page, payload) {
  process.stderr.write('[fallback] Navigating to butler for CSRF token...\n');
  await page.goto(`${payload.baseUrl}/butler/event-utilities.php`, { waitUntil: 'domcontentloaded' });
  process.stderr.write(`[fallback] Butler page URL: ${page.url()}\n`);

  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta?.getAttribute('content') ?? '';
  });

  process.stderr.write(`[fallback] CSRF token: ${csrfToken ? csrfToken.slice(0, 8) + '...' : '(empty)'}\n`);

  if (!csrfToken) {
    throw new Error('Could not find CSRF token on butler page. The admin session may not have been established correctly.');
  }
  return csrfToken;
}

async function applyAuctionSettings(page, baseUrl, eventId, settings) {
  const requested = settings || {};
  if (requested.enabled === false) {
    return { applied: [], skipped: [{ section: 'auctionSettings', reason: 'disabled' }], warnings: [] };
  }

  const applied = [];
  const skipped = [];
  const warnings = [];
  const record = (result) => {
    if (!result) return;
    if (result.applied) applied.push(result);
    else skipped.push(result);
  };

  await switchToEvent(page, baseUrl, eventId);
  process.stderr.write('[fallback] Navigating to auction settings...\n');
  await page.goto(`${baseUrl}/admin/auction_settings.php?expand=payments`, { waitUntil: 'domcontentloaded' });

  if (requested.useExistingMerchantAccount !== false) {
    try {
      record(await assignExistingMerchantAccount(page));
      await page.goto(`${baseUrl}/admin/auction_settings.php?expand=payments`, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      warnings.push({ setting: 'useExistingMerchantAccount', message: error.message });
    }
  }

  const boolValue = (value) => value ? '1' : '0';
  const settingsMap = [
    ['#onchange-max_bidding', boolValue(requested.maxBidding)],
    ['#onchange-show_register', boolValue(requested.allowBidderRegistration)],
    ['#onchange-enable_ttr', boolValue(requested.enableTextToRegister)],
    ['#onchange-require_address', boolValue(requested.requireAddress)],
    ['#onchange-require_cc', boolValue(requested.requireCreditCard)],
    ['#enable-crypto', boolValue(requested.enableCrypto)],
    ['#enable-link', boolValue(requested.enableLink)],
  ];

  for (const [selector, value] of settingsMap) {
    try {
      record(await setSelectValue(page, selector, value));
    } catch (error) {
      warnings.push({ selector, message: error.message });
    }
  }

  if (requested.resetMobileCheckin !== false) {
    try {
      record(await resetMobileCheckin(page));
    } catch (error) {
      warnings.push({ selector: '.checkin_reset_btn', message: error.message });
    }
  }

  if (requested.startingBidderNumber) {
    try {
      record(await setInputValue(page, '#onchange-start_bidder_number', requested.startingBidderNumber));
    } catch (error) {
      warnings.push({ selector: '#onchange-start_bidder_number', message: error.message });
    }
  }

  process.stderr.write(`[fallback] Auction settings applied=${applied.length}, skipped=${skipped.length}, warnings=${warnings.length}\n`);
  return { applied, skipped, warnings };
}

function buildTicketPagePlans(ticketPages) {
  const pages = Array.isArray(ticketPages?.pages) ? ticketPages.pages : [];
  const seen = new Set();

  return pages.map((page, index) => {
    const requested = String(page?.formName || '').trim();
    let targetFormName = requested;

    if (!targetFormName || seen.has(targetFormName)) {
      let suffix = index + 1;
      targetFormName = index === 0 ? 'tix' : `tix_${suffix}`;
      while (seen.has(targetFormName)) {
        suffix += 1;
        targetFormName = `tix_${suffix}`;
      }
    }

    seen.add(targetFormName);
    return {
      index,
      page,
      initialFormName: null,
      targetFormName,
    };
  });
}

function ticketPagePublicUrl(baseUrl, eventSlug, formName) {
  const slug = String(eventSlug || '').trim();
  if (!slug || !baseUrl) return '';
  try {
    const parsed = new URL(String(baseUrl).replace(/\/$/, ''));
    parsed.hostname = `${slug}.${parsed.hostname}`;
    parsed.pathname = formName && formName !== 'tix' ? `/${String(formName).replace(/^\/+/, '')}` : '/';
    parsed.search = '';
    parsed.hash = '';
    return String(parsed).replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

async function setBlurValue(page, selector, value, responseSubstring) {
  if (value === undefined || value === null) {
    return { selector, skipped: true, reason: 'no value requested' };
  }

  const state = await page.evaluate((sel) => {
    const field = document.querySelector(sel);
    if (!field) return { exists: false };
    return {
      exists: true,
      value: field.value,
      disabled: Boolean(field.disabled),
    };
  }, selector);

  if (!state.exists) return { selector, skipped: true, reason: 'field not present' };
  if (state.disabled) return { selector, skipped: true, reason: 'field disabled' };

  const stringValue = String(value);
  if (state.value === stringValue) {
    return { selector, skipped: true, reason: 'already set', value: stringValue };
  }

  await Promise.all([
    page.waitForResponse(
      (resp) =>
        resp.url().includes('/ajax/') &&
        (!responseSubstring || resp.url().includes(responseSubstring)) &&
        resp.status() < 500,
      { timeout: 15000 },
    ),
    page.evaluate(({ sel, val }) => {
      const field = document.querySelector(sel);
      if (!field) return;
      field.value = val;
      const $ = window.$;
      if ($) $(field).blur();
      else field.blur();
    }, { sel: selector, val: stringValue }),
  ]);

  return { selector, applied: true, value: stringValue };
}

async function createNewTicketPage(page, baseUrl) {
  await page.goto(`${baseUrl}/admin/manage_tickets.php`, { waitUntil: 'domcontentloaded' });

  await Promise.all([
    page.waitForURL(/modify_tickets\.php\?form_name=/, { timeout: 15000, waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Create New Ticket Page' }).click(),
  ]);

  const url = new URL(page.url());
  const formName = url.searchParams.get('form_name');
  if (!formName) {
    throw new Error('Could not determine created ticket form name from redirect URL.');
  }
  return formName;
}

async function renameTicketPage(page, baseUrl, currentFormName, targetFormName) {
  if (!targetFormName || currentFormName === targetFormName) {
    return { formName: currentFormName, skipped: true, reason: 'already named' };
  }

  await page.goto(`${baseUrl}/admin/ticket_form.php?form_name=${encodeURIComponent(currentFormName)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#onblur-form_name', { state: 'visible', timeout: 10000 });
  await page.locator('#onblur-form_name').fill(targetFormName);

  await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes('post_ticket_form.php') && resp.status() === 200,
      { timeout: 15000 },
    ),
    page.locator('#onblur-form_name').blur(),
  ]);

  const confirmOk = page.locator('#confirmOverlay').getByRole('link', { name: 'Ok' });
  if (await confirmOk.count()) {
    await confirmOk.click();
    await page.waitForURL(new RegExp(`form_name=${encodeURIComponent(targetFormName)}`), { timeout: 15000 });
  }

  return { formName: targetFormName, applied: true };
}

async function createTicketRecord(page, selectorMap) {
  const {
    addButtonName,
    formVisibleSelector,
    saveResponseSubstring,
    fields,
    completeButtonName,
  } = selectorMap;

  await page.getByRole('button', { name: addButtonName }).click();
  await page.waitForSelector(formVisibleSelector, { state: 'visible', timeout: 10000 });

  const [saveResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().includes(saveResponseSubstring) && resp.status() === 200,
      { timeout: 15000 },
    ),
    page.evaluate((fieldEntries) => {
      const $ = window.$;
      for (const [selector, value] of fieldEntries) {
        const field = document.querySelector(selector);
        if (field) field.value = value;
      }
      const firstSelector = fieldEntries[0]?.[0];
      const firstField = firstSelector ? document.querySelector(firstSelector) : null;
      if (!firstField) return;
      if ($) $(firstField).blur();
      else firstField.blur();
    }, Object.entries(fields)),
  ]);
  const saveResult = await saveResponse.json().catch(() => null);

  await page.getByRole('button', { name: completeButtonName }).click();
  await page.waitForSelector('#all_tickets_wrapper', { state: 'visible', timeout: 10000 });
  return saveResult;
}

function extractCreatedTicketId(saveResult) {
  if (!saveResult) return null;
  const ticket = Array.isArray(saveResult.ticket) ? saveResult.ticket[0] : saveResult.ticket;
  return ticket?.id ? String(ticket.id) : null;
}

async function postAdminForm(page, url, payload, extraHeaders = {}) {
  return page.evaluate(async ({ targetUrl, body, headers }) => {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        ...(headers || {}),
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { success: false, message: text };
    }
    return { status: response.status, body: json };
  }, { targetUrl: url, body: payload, headers: extraHeaders });
}

async function saveCustomQuestion(page, targetType, targetId, question) {
  const questionText = String(question?.question || '').trim();
  if (!questionText) return null;

  const saveField = async (field, value, questionId = 0) => {
    const result = await postAdminForm(page, '/ajax/admin/custom-questions.php', {
      action: 'save-custom-question',
      targetId: String(targetId),
      targetType,
      questionId: String(questionId),
      field,
      value: String(value),
    });
    if (result.status >= 400 || !result.body?.success) {
      throw new Error(result.body?.message || `Custom question save failed for ${field}`);
    }
    return result.body;
  };

  const created = await saveField('question', questionText, 0);
  const questionId = created.id;
  if (!questionId) {
    throw new Error(`Custom question "${questionText}" did not return an ID.`);
  }

  const normalizedType = question?.type === 'dropdown' ? 'pick_list' : 'text';
  const normalizedShowOn = targetType === 'underwriting-ticket'
    ? 'ticket'
    : (question?.showOn === 'guest' ? 'guest' : 'ticket');
  const normalizedRequired = normalizedShowOn === 'guest' ? '0' : (question?.required ? '1' : '0');
  const normalizedActive = question?.isActive === false ? '0' : '1';

  if (normalizedType !== 'pick_list') await saveField('type', normalizedType, questionId);
  if (normalizedShowOn !== 'ticket') await saveField('show_on', normalizedShowOn, questionId);
  if (normalizedRequired !== '0') await saveField('is_required', normalizedRequired, questionId);
  if (normalizedActive !== '1') await saveField('is_active', normalizedActive, questionId);

  if (normalizedType === 'pick_list') {
    for (const answer of Array.isArray(question?.answers) ? question.answers : []) {
      const answerText = String(answer || '').trim();
      if (!answerText) continue;
      const optionResult = await postAdminForm(page, '/ajax/admin/custom-questions.php', {
        action: 'save-pick-list-option',
        questionId: String(questionId),
        id: '0',
        answer: answerText,
      });
      if (optionResult.status >= 400 || !optionResult.body?.success) {
        throw new Error(optionResult.body?.message || `Pick-list option save failed for "${answerText}"`);
      }
    }
  }

  return { id: questionId, question: questionText, type: normalizedType, showOn: normalizedShowOn };
}

function resolveSelectionSelectable(selection, createdTargets, ticketFormId) {
  const showOnType = selection?.showOnType;
  if (!showOnType || showOnType === 'ticket-form') {
    return { id: String(ticketFormId), type: 'ticket-form', label: 'All', warning: null };
  }

  const showOnIndex = Math.max(0, Number(selection?.showOnIndex) || 0);
  const targetGroup = showOnType === 'individual-ticket'
    ? createdTargets?.individual
    : showOnType === 'sponsor-ticket'
      ? createdTargets?.sponsor
      : null;
  const resolvedTarget = Array.isArray(targetGroup) ? targetGroup[showOnIndex] : null;

  if (!resolvedTarget?.id) {
    return {
      id: String(ticketFormId),
      type: 'ticket-form',
      label: 'All',
      warning: `Selection target "${showOnType}:${showOnIndex}" was not found. Falling back to All.`,
    };
  }

  return {
    id: String(resolvedTarget.id),
    type: showOnType,
    label: `${resolvedTarget.name || 'Selection target'}${showOnType === 'individual-ticket' ? ' (Individual)' : ' (Sponsor)'}`,
    warning: null,
  };
}

async function saveSelection(page, ticketFormId, selection, selectable) {
  const choice = String(selection?.name || '').trim();
  if (!choice) return null;

  const result = await postAdminForm(page, '/ajax/admin/modify-tickets.php', {
    action: 'save-meal-choice',
    id: '0',
    ticket_form_id: String(ticketFormId),
    choice,
    description: String(selection?.description || ''),
    selectable_id: String(selectable.id),
    selectable_type: selectable.type,
  });

  if (result.status >= 400 || !result.body?.success) {
    throw new Error(result.body?.message || `Selection save failed for "${choice}"`);
  }

  return result.body?.selection || null;
}

async function applyTicketPageSettings(page, baseUrl, formName, ticketPage) {
  const settings = ticketPage?.settings || {};
  await page.goto(`${baseUrl}/admin/ticket_form.php?form_name=${encodeURIComponent(formName)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#onblur-form_title', { state: 'visible', timeout: 10000 });

  const applied = [];
  const skipped = [];
  const warnings = [];

  const record = (result) => {
    if (!result) return;
    if (result.applied) applied.push(result);
    else skipped.push(result);
  };

  const settingCalls = [
    () => setBlurValue(page, '#onblur-form_title', ticketPage?.displayName || formName, 'post_ticket_form.php'),
    () => setSelectValue(page, '#onchange-no_link', settings.allowGuestUpdates ? '1' : '0'),
    () => setSelectValue(page, '#onchange-credit_card', settings.creditCard ? '1' : '0'),
    () => setSelectValue(page, '#onchange-send_invoice', settings.sendInvoice ? '1' : '0'),
    () => setSelectValue(page, '#onchange-cash', settings.cash ? '1' : '0'),
    () => setSelectValue(page, '#onchange-check_book', settings.check ? '1' : '0'),
    () => setSelectValue(page, '#onchange-show_qr_code', settings.showQrCode ? '1' : '0'),
  ];

  for (const call of settingCalls) {
    try {
      record(await call());
    } catch (error) {
      warnings.push({ message: error.message });
    }
  }

  return { applied, skipped, warnings };
}

function collectTicketPageWarnings(pageConfig, formName) {
  const warnings = [];
  const pageCustomQuestions = Array.isArray(pageConfig?.pageCustomQuestions) ? pageConfig.pageCustomQuestions : [];

  if (pageCustomQuestions.length > 0) {
    warnings.push({ formName, feature: 'pageCustomQuestions', message: 'Page-level custom questions are not wired yet.' });
  }

  return warnings;
}

const CHECKOUT_PERSON_POOL_SIZE = 2000;
const CHECKOUT_PERSON_POOL = buildCheckoutPersonPool(CHECKOUT_PERSON_POOL_SIZE);
const PUBLIC_TICKET_FORM_CACHE = new Map();

function createCheckoutFaker(seed) {
  const faker = fakerEN_US;
  faker.seed(seed);
  return faker;
}

function buildCheckoutPersonPool(size) {
  const pool = [];
  const usedNames = new Set();
  for (let index = 0; index < size; index += 1) {
    const faker = createCheckoutFaker(10000 + index);
    let firstName = faker.person.firstName();
    let lastName = faker.person.lastName();
    let fullName = `${firstName} ${lastName}`;
    if (usedNames.has(fullName)) {
      const middleInitial = String.fromCharCode(65 + (index % 26));
      firstName = `${firstName} ${middleInitial}.`;
      fullName = `${firstName} ${lastName}`;
    }
    usedNames.add(fullName);

    const address = faker.location.streetAddress();
    pool.push({
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${index}`.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() + '@example.com',
      phone: faker.helpers.replaceSymbols('555#######'),
      address,
      city: faker.location.city(),
      state: faker.location.state(),
      postalCode: faker.location.zipCode('#####'),
    });
  }
  return pool;
}

function buildCheckoutPerson(index) {
  const normalizedIndex = Math.max(0, Number(index) || 0);
  const fromPool = CHECKOUT_PERSON_POOL[normalizedIndex % CHECKOUT_PERSON_POOL.length];
  const cycleIndex = Math.floor(normalizedIndex / CHECKOUT_PERSON_POOL.length);
  if (cycleIndex === 0) {
    return { ...fromPool };
  }

  return {
    ...fromPool,
    firstName: `${fromPool.firstName} ${String.fromCharCode(65 + ((cycleIndex - 1) % 26))}.${cycleIndex > 26 ? cycleIndex : ''}`,
    email: fromPool.email.replace('@', `.${cycleIndex}@`),
  };
}

function publicTicketFormCacheKey(baseUrl, eventSlug, formName) {
  return `${String(baseUrl || '').replace(/\/$/, '')}::${String(eventSlug || '').trim()}::${String(formName || 'tix').trim() || 'tix'}`;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(list.length || 1, Number(concurrency) || 1));
  const results = new Array(list.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= list.length) return;
      results[currentIndex] = await worker(list[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

// Run an async operation with bounded retries. `attempts` is the total number of
// tries (1 initial + retries). Used for flaky browser/Stripe checkout steps where
// a single slow response (modal/navigation timeout) should not fail the whole
// purchase. `shouldRetry(error)` can veto a retry for non-transient failures.
async function withRetry(fn, { attempts = 3, shouldRetry = () => true, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && shouldRetry(error)) {
        if (typeof onRetry === 'function') onRetry(error, attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function elapsedSeconds(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function buildTicketPurchaseSeedData(postCreateActivity, resolvedTarget, purchaseOrdinal = 0) {
  const purchase = postCreateActivity.ticketPurchases;
  const seedBase = (purchaseOrdinal * 37) + (Number(resolvedTarget.targetIndex) * 11);
  const purchaser = buildCheckoutPerson(seedBase);
  const purchaseType = purchaseTypeForTarget(resolvedTarget.targetType);
  const unitCount = Math.max(1, Number(purchase.quantity) || 1);
  const ticketsPerUnit = Math.max(1, Number(resolvedTarget.targetConfig?.ticketsPerPurchase) || 1);
  const expectedGuests = purchaseType === 'underwriting' ? 0 : Math.max(0, ticketsPerUnit * unitCount);
  const guestSeeds = [];
  for (let index = 0; index < expectedGuests; index += 1) {
    guestSeeds.push(index === 0 ? { ...purchaser } : buildCheckoutPerson(seedBase + index));
  }
  return {
    seedBase,
    purchaser,
    purchaseType,
    unitCount,
    ticketsPerUnit,
    expectedGuests,
    guestSeeds,
  };
}

function buildTicketPurchaseRequestData(snapshotTarget, purchaser, guestSeeds, paymentMethodId, unitCount) {
  const purchaseObj = {
    ...cloneJson(snapshotTarget.dataset),
    current: String(snapshotTarget.purchaseType === 'underwriting' ? 1 : unitCount),
    questions: cloneJson(snapshotTarget.questions || []),
  };

  const guests = guestSeeds.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    phone: guest.phone,
    ticketType: snapshotTarget.dataset.type,
    ticketId: snapshotTarget.dataset.id,
    questions: [],
  }));

  const unitPrice = parseFloat(snapshotTarget.dataset.price) || 0;
  const total = Math.round(unitPrice * Number(purchaseObj.current) * 100) / 100;

  return {
    registrant: {
      company: null,
      firstName: purchaser.firstName,
      lastName: purchaser.lastName,
      email: purchaser.email,
      phone: purchaser.phone,
      address: purchaser.address,
      address2: '',
      city: purchaser.city,
      state: purchaser.state,
      postalCode: purchaser.postalCode,
      country: 'US',
    },
    copyGuestIndex: guests.length > 0 ? 0 : -1,
    purchases: [purchaseObj],
    guests,
    adminFeeOptOut: false,
    adminDiscount: 0,
    total,
    paymentMethod: paymentMethodId,
    paymentIntentId: false,
    saveCard: false,
    rsvp: false,
  };
}

async function acceptCookieBannerIfPresent(page) {
  const acceptButton = page.getByRole('button', { name: 'Accept' });
  if (await acceptButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await acceptButton.click().catch(() => undefined);
  }
}

async function gotoPublicTicketPage(page, baseUrl, eventSlug, formName) {
  const formToUse = formName || 'tix';
  const adminModifyUrl = `${baseUrl}/admin/modify_tickets.php?form_name=${encodeURIComponent(formToUse)}`;
  process.stderr.write(`[fallback] Resolving public ticket URL via admin: ${adminModifyUrl}\n`);
  await page.goto(adminModifyUrl, { waitUntil: 'domcontentloaded' });

  const launchLink = page.getByRole('link', { name: /Launch Ticket Page/i }).first();
  await launchLink.waitFor({ state: 'attached', timeout: 10000 });
  const href = await launchLink.getAttribute('href');
  if (!href) {
    throw new Error('Launch Ticket Page link has no href attribute on the admin Modify Tickets page.');
  }
  const resolvedUrl = new URL(href, baseUrl).toString();
  process.stderr.write(`[fallback] Launch Ticket Page resolved to: ${resolvedUrl}\n`);

  await page.goto(resolvedUrl, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  process.stderr.write(`[fallback] Public ticket page landed at: ${page.url()}\n`);
  await acceptCookieBannerIfPresent(page);
  return page.url();
}

async function gotoResolvedPublicTicketPage(page, publicUrl) {
  if (!publicUrl) {
    throw new Error('Cannot open public ticket checkout because no public ticket URL was resolved.');
  }
  await page.goto(publicUrl, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  process.stderr.write(`[fallback] Public ticket checkout landed at: ${page.url()}\n`);
  await acceptCookieBannerIfPresent(page);
}

async function getPublicTicketFormSnapshot(page, baseUrl, eventSlug, formName) {
  const cacheKey = publicTicketFormCacheKey(baseUrl, eventSlug, formName);
  if (PUBLIC_TICKET_FORM_CACHE.has(cacheKey)) {
    return cloneJson(PUBLIC_TICKET_FORM_CACHE.get(cacheKey));
  }

  const publicUrl = await gotoPublicTicketPage(page, baseUrl, eventSlug, formName);
  const snapshot = await page.evaluate(() => {
    const stripePaymentForm = document.querySelector('#stripe-payment-form');
    const extractQuestions = (scope) => {
      if (!scope) return [];
      return Array.from(scope.querySelectorAll('.custom-question, .custom-question-response')).flatMap((question) => {
        const questionId = question.dataset.id;
        if (!questionId) return [];
        let answer = '';
        if (question.tagName === 'SELECT') {
          const option = Array.from(question.options || []).find((entry) => entry.value && entry.value.trim());
          answer = option ? option.value : '';
        } else {
          answer = 'QA Automation';
        }
        return answer ? [{ questionId, answer }] : [];
      });
    };

    const buildTarget = (element, purchaseType) => ({
      purchaseType,
      dataset: { ...element.dataset },
      questions: extractQuestions(element.closest('.ticket-container')),
    });

    return {
      organizationId: stripePaymentForm?.dataset.organizationId || '',
      eventId: stripePaymentForm?.dataset.eventId || '',
      targets: {
        individual: Array.from(document.querySelectorAll('.counter'))
          .filter((counter) => counter.dataset.type === 'individual')
          .map((counter) => buildTarget(counter, 'individual')),
        sponsor: Array.from(document.querySelectorAll('.counter'))
          .filter((counter) => counter.dataset.type === 'sponsor')
          .map((counter) => buildTarget(counter, 'sponsor')),
        underwriting: Array.from(document.querySelectorAll('.underwriting-ticket-checkbox'))
          .map((checkbox) => buildTarget(checkbox, 'underwriting')),
      },
      hasDonationSection: Boolean(document.querySelector(
        'section.donation .ticket-container, section.donation .donation-amount, .page.donation .ticket-container, .page.donation .donation-amount'
      )),
    };
  });

  if (!snapshot.organizationId || !snapshot.eventId) {
    throw new Error(`Could not resolve Stripe ticket form metadata for ${formName || 'tix'}.`);
  }

  snapshot.publicUrl = publicUrl || ticketPagePublicUrl(baseUrl, eventSlug, formName);
  PUBLIC_TICKET_FORM_CACHE.set(cacheKey, snapshot);
  return cloneJson(snapshot);
}

// Map the historic label argument to the stable data-target value used in the
// ticket-page wizard markup (e.g. <input name="ticket-nav" data-target="donation">
// and <button data-target="donation">). The visible label for a step can be
// customized per event (e.g. "Make a donation"), so matching the label text is
// unreliable; data-target never changes.
const TICKET_SECTION_TARGETS = {
  tickets: 'individual',
  individual: 'individual',
  sponsorships: 'sponsor',
  sponsor: 'sponsor',
  'guest details': 'guest-details',
  'guest-details': 'guest-details',
  underwriting: 'underwriting',
  donation: 'donation',
  'quantity items': 'quantity-item',
  'quantity-item': 'quantity-item',
  payment: 'payment',
};

async function navigateTicketPurchaseSection(page, label) {
  const key = String(label).trim().toLowerCase();
  const dataTarget = TICKET_SECTION_TARGETS[key] || null;

  // Primary: navigate by the stable data-target attribute (label-independent).
  if (dataTarget) {
    const navRadio = page.locator(`input[name="ticket-nav"][data-target="${dataTarget}"]`).first();
    if (await navRadio.count()) {
      await navRadio.click();
      return true;
    }
    const continueButton = page.locator(`button[data-target="${dataTarget}"]`).first();
    if (await continueButton.count()) {
      await continueButton.click();
      return true;
    }
  }

  // Fallback: legacy accessible-name match (kept for resilience if markup shifts).
  const exactMatcher = new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const radio = page.getByRole('radio', { name: exactMatcher });
  if (await radio.count()) {
    await radio.first().click();
    return true;
  }
  const button = page.getByRole('button', { name: exactMatcher }).first();
  if (await button.count()) {
    await button.click();
    return true;
  }
  return false;
}

async function setTicketQuantityByIndex(page, index, quantity) {
  const addButton = page.getByRole('button', { name: /^Add 1 / }).nth(index);
  // Confirm the ticket UI actually rendered the "Add" control before clicking it.
  // If it never appears, the public checkout's front-end assets likely failed to
  // load (e.g. CDN 403 on the bidapp JS bundles), so the wizard never initialized
  // and no click sequence can recover it — fail fast and non-retryably with a
  // clear cause instead of hanging ~30s on actionability per attempt.
  try {
    await addButton.waitFor({ state: 'visible', timeout: TICKET_ADD_BUTTON_TIMEOUT_MS });
  } catch (_) {
    const err = new Error(
      'Public ticket checkout did not render an "Add" control — the page\'s front-end '
      + 'assets may be failing to load (e.g. CDN 403 on the bidapp JS bundles). '
      + 'Skipping browser ticket purchase.',
    );
    err.ticketPageUnavailable = true;
    throw err;
  }
  for (let i = 0; i < quantity; i += 1) {
    await addButton.click();
  }
}

async function fillRequiredFields(fields) {
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const tagName = await field.evaluate((node) => node.tagName.toLowerCase());
    if (tagName === 'select') {
      const optionCount = await field.locator('option').count();
      if (optionCount > 1) {
        await field.selectOption({ index: 1 });
      }
    } else {
      await field.fill('Seeded by mkEvent');
    }
  }
}

async function fillRequiredTicketQuestionsByIndex(page, index) {
  const addButton = page.getByRole('button', { name: /^Add 1 / }).nth(index);
  const ticketArticle = addButton.locator('..').locator('..');
  await fillRequiredFields(ticketArticle.locator('.custom-question-response[data-required]'));
}

async function fillVisibleGuestCard(page, person, advanceAfterFill = true) {
  await page.getByRole('textbox', { name: 'First Name' }).first().fill(person.firstName);
  await page.getByRole('textbox', { name: 'Last Name' }).first().fill(person.lastName);
  await page.getByRole('textbox', { name: 'Email Address' }).first().fill(person.email);
  await page.getByRole('textbox', { name: /(Phone|Mobile) Number/ }).first().fill(person.phone);

  const selectionField = page.locator('select[name="selection"]:visible').first();
  if (await selectionField.count()) {
    const optionCount = await selectionField.locator('option').count();
    if (optionCount > 1) {
      await selectionField.selectOption({ index: 1 });
    }
    const notesField = page.locator('.selection-notes:visible').first();
    if (await notesField.count()) {
      await notesField.fill('Seeded by mkEvent');
    }
  }

  await fillRequiredFields(page.locator('.custom-question-response[data-required]:visible'));

  if (advanceAfterFill) {
    const nextButton = page.getByRole('button', { name: 'Next slide' });
    if (await nextButton.count()) {
      await nextButton.click();
    }
  }
}

async function fillPurchaserDetails(page, person) {
  await page.getByRole('textbox', { name: 'First Name *' }).fill(person.firstName);
  await page.getByRole('textbox', { name: 'Last Name *' }).fill(person.lastName);
  await page.getByRole('textbox', { name: 'Email Address *' }).fill(person.email);
  await page.getByRole('textbox', { name: /^(Phone|Mobile) Number \*$/ }).fill(person.phone);

  const addressField = page.getByRole('textbox', { name: 'Street Address *' });
  if (await addressField.count()) await addressField.fill(person.address);
  const cityField = page.getByRole('textbox', { name: 'City *' });
  if (await cityField.count()) await cityField.fill(person.city);
  const stateField = page.getByRole('combobox', { name: 'State *' });
  if (await stateField.count()) await stateField.selectOption({ label: person.state }).catch(() => stateField.selectOption(person.state));
  const postalField = page.getByRole('textbox', { name: 'Postal Code *' });
  if (await postalField.count()) await postalField.fill(person.postalCode);
}

async function selectCreditCard(page) {
  const cardLabel = page.locator('label:has-text("Credit Card"), [class*="radio"]:has-text("Credit Card")').first();
  if (!await cardLabel.count()) {
    throw new Error('Credit card payment option is not available on the public ticket page.');
  }
  await cardLabel.click();
  const radio = page.getByRole('radio', { name: 'Credit Card' });
  if (await radio.count()) {
    await radio.check({ timeout: 2000 }).catch(() => undefined);
  }
  const stripeFrame = page.frameLocator('iframe[name*="__privateStripeFrame"]').first();
  await stripeFrame.getByPlaceholder('1234 1234 1234 1234').waitFor({ state: 'visible', timeout: 15000 });
}

async function fillStripeCard(page, cardNumber = '4242424242424242', expiry = '1230', cvc = '123', zip = '33101') {
  const stripeFrame = page.frameLocator('iframe[name*="__privateStripeFrame"]').first();
  await stripeFrame.getByPlaceholder('1234 1234 1234 1234').fill(cardNumber);
  await stripeFrame.getByPlaceholder('MM / YY').fill(expiry);
  await stripeFrame.getByPlaceholder('CVC').fill(cvc);
  const zipField = stripeFrame.getByPlaceholder('12345');
  if (await zipField.isVisible().catch(() => false)) {
    await zipField.fill(zip);
  }
  await page.locator('button.submit-payment').waitFor({ state: 'visible', timeout: 10000 });
}

async function completeTicketCheckout(page) {
  const submitButton = page.locator('button.submit-payment');
  await submitButton.scrollIntoViewIfNeeded();
  await submitButton.click();
  const confirmationModal = page.locator('#confirmation-modal');
  const modalVisible = await confirmationModal.waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(async () => {
      const checkoutIssue = await page.evaluate(() => {
        const invalidField = document.querySelector('[aria-invalid="true"], .is-invalid, .error, .invalid');
        if (invalidField) {
          const label = invalidField.getAttribute('aria-label')
            || invalidField.getAttribute('name')
            || invalidField.getAttribute('id')
            || invalidField.textContent
            || invalidField.className
            || 'unknown field';
          return `Checkout validation failed near ${String(label).trim()}`;
        }
        const dialog = document.querySelector('#confirmation-modal');
        if (dialog && dialog.hasAttribute('open')) return '';
        return 'Checkout confirmation modal did not open after submit.';
      });
      throw new Error(checkoutIssue || 'Checkout confirmation modal did not open after submit.');
    });
  if (modalVisible) {
    await page.locator('.confirm-checkout').click();
  }
  await page.waitForURL(/confirmation/, { timeout: 30000 });
  await page.getByRole('heading', { name: 'Thank You' }).waitFor({ state: 'visible', timeout: 15000 });
}

function resolvePostCreatePurchaseTarget(postCreateActivity, ticketPages) {
  const pages = Array.isArray(ticketPages?.pages) ? ticketPages.pages : [];
  const purchase = postCreateActivity?.ticketPurchases || {};
  const pageIndex = Math.max(0, Number(purchase.pageIndex) || 0);
  const pageConfig = pages[pageIndex] || pages[0] || null;

  if (!pageConfig) {
    return {
      pageConfig: null,
      formName: 'tix',
      targetType: 'individual-ticket',
      targetIndex: 0,
      targetConfig: null,
      targetLabel: 'Ticket',
      guestsPerUnit: 0,
      warning: 'No ticket pages were configured for post-create activity.',
    };
  }

  const targetMode = purchase.targetMode === 'mixed' ? 'mixed' : 'specific';
  const candidates = [
    ...(Array.isArray(pageConfig.individualTickets) ? pageConfig.individualTickets : []).map((ticket, index) => ({
      targetType: 'individual-ticket',
      targetIndex: index,
      targetConfig: ticket,
      targetLabel: `${ticket.name || `Ticket ${index + 1}`}`,
      guestsPerUnit: Math.max(0, Number(ticket.ticketsPerPurchase) || 0),
    })),
    ...(Array.isArray(pageConfig.sponsors) ? pageConfig.sponsors : []).map((sponsor, index) => ({
      targetType: 'sponsor-ticket',
      targetIndex: index,
      targetConfig: sponsor,
      targetLabel: `${sponsor.title || `Sponsor ${index + 1}`}`,
      guestsPerUnit: Math.max(0, Number(sponsor.ticketsPerPurchase) || 0),
    })),
  ];

  if (targetMode === 'mixed') {
    if (candidates.length === 0) {
      return {
        pageConfig,
        formName: pageConfig.formName || 'tix',
        targetMode,
        targetType: 'individual-ticket',
        targetIndex: 0,
        targetConfig: null,
        targetLabel: 'Ticket',
        guestsPerUnit: 0,
        candidates: [],
        warning: `No purchasable ticket or sponsor options were configured on ${pageConfig.formName || 'tix'}.`,
      };
    }

    return {
      pageConfig,
      formName: pageConfig.formName || 'tix',
      targetMode,
      targetType: candidates[0].targetType,
      targetIndex: candidates[0].targetIndex,
      targetConfig: candidates[0].targetConfig,
      targetLabel: candidates[0].targetLabel,
      guestsPerUnit: candidates[0].guestsPerUnit,
      candidates,
      warning: null,
    };
  }

  const targetType = purchase.targetType === 'sponsor-ticket' ? 'sponsor-ticket' : 'individual-ticket';
  const targetIndex = Math.max(0, Number(purchase.targetIndex) || 0);
  const targetPool = targetType === 'sponsor-ticket' ? pageConfig.sponsors : pageConfig.individualTickets;
  const targetConfig = targetPool[targetIndex] || targetPool[0] || null;

  if (!targetConfig) {
    return {
      pageConfig,
      formName: pageConfig.formName || 'tix',
      targetMode,
      targetType,
      targetIndex,
      targetConfig: null,
      targetLabel: targetType === 'sponsor-ticket' ? 'Sponsor' : 'Ticket',
      guestsPerUnit: 0,
      candidates,
      warning: `No ${targetType === 'sponsor-ticket' ? 'sponsor levels' : 'individual tickets'} were configured on ${pageConfig.formName || 'tix'}.`,
    };
  }

  return {
    pageConfig,
    formName: pageConfig.formName || 'tix',
    targetMode,
    targetType,
    targetIndex,
    targetConfig,
    targetLabel: targetType === 'sponsor-ticket'
      ? (targetConfig.title || 'Sponsor')
      : (targetConfig.name || 'Ticket'),
    guestsPerUnit: Math.max(0, Number(targetConfig.ticketsPerPurchase) || 0),
    candidates,
    warning: null,
  };
}

function resolvePostCreatePurchaseTargetForOrdinal(resolvedTarget, purchaseOrdinal = 0) {
  const candidates = Array.isArray(resolvedTarget?.candidates) ? resolvedTarget.candidates : [];
  if (resolvedTarget?.targetMode !== 'mixed' || candidates.length === 0) {
    return resolvedTarget;
  }
  const candidate = candidates[purchaseOrdinal % candidates.length] || candidates[0];
  return {
    ...resolvedTarget,
    targetType: candidate.targetType,
    targetIndex: candidate.targetIndex,
    targetConfig: candidate.targetConfig,
    targetLabel: candidate.targetType === 'sponsor-ticket'
      ? `${candidate.targetLabel} (Sponsor)`
      : `${candidate.targetLabel} (Individual)`,
    guestsPerUnit: candidate.guestsPerUnit,
  };
}

const PAYMENT_METHOD_IDS = Object.freeze({
  credit_card: 1,
  check: 2,
  cash: 5,
  invoice: 8,
});

const ITEM_TYPE_IDS = Object.freeze({
  silent: 10,
  live: 20,
  donation: 30,
  quantity: 40,
});

function purchaseTypeForTarget(targetType) {
  if (targetType === 'sponsor-ticket') return 'sponsor';
  if (targetType === 'underwriting-ticket') return 'underwriting';
  return 'individual';
}

function buildTicketPurchaseExecutionPlan(ticketPurchases) {
  const paymentMix = ticketPurchases?.paymentMix || {};
  const plan = [];
  ['check', 'cash', 'invoice', 'credit_card'].forEach((method) => {
    const count = Math.max(0, Number(paymentMix[method]) || 0);
    for (let index = 0; index < count; index += 1) {
      plan.push(method);
    }
  });
  if (plan.length === 0) {
    plan.push(ticketPurchases?.paymentMethod || 'check');
  }
  return plan;
}

function resolveTicketPurchasePaymentSupport(pageConfig) {
  const settings = pageConfig?.settings || {};
  return {
    check: settings.check !== false,
    cash: Boolean(settings.cash),
    invoice: settings.sendInvoice !== false,
    credit_card: settings.creditCard !== false,
  };
}

function buildBidderDisplayName(bidder) {
  const first = String(bidder?.first_name || bidder?.firstName || '').trim();
  const last = String(bidder?.last_name || bidder?.lastName || '').trim();
  return [first, last].filter(Boolean).join(' ') || `Bidder ${bidder?.bidder_number || bidder?.id || ''}`.trim();
}

function filterPostCreateAuctionItems(items, activity) {
  const source = Array.isArray(items) ? items : [];
  return source.filter((item) => (
    (activity?.includeSilent !== false && Number(item?.item_type_id) === ITEM_TYPE_IDS.silent)
    || (activity?.includeLive !== false && Number(item?.item_type_id) === ITEM_TYPE_IDS.live)
  ));
}

function filterPostCreateDonationItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => Number(item?.item_type_id) === ITEM_TYPE_IDS.donation);
}

function pickRoundRobin(list, index) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[index % list.length] || null;
}

function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)] || null;
}

function pickRandomSubset(list, count) {
  const source = Array.isArray(list) ? [...list] : [];
  const limit = Math.max(0, Math.min(source.length, Number(count) || 0));
  for (let index = source.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [source[index], source[swapIndex]] = [source[swapIndex], source[index]];
  }
  return source.slice(0, limit);
}

function randomIntInclusive(min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function buildAuctionActivityPools(bidders, items, totalActions) {
  const bidderList = Array.isArray(bidders) ? bidders : [];
  const itemList = Array.isArray(items) ? items : [];
  const actionCount = Math.max(0, Number(totalActions) || 0);
  const activeBidderCount = Math.min(
    bidderList.length,
    Math.max(1, Math.min(12, Math.ceil(actionCount / 2) || 1)),
  );
  const hotItemCount = Math.min(
    itemList.length,
    Math.max(1, Math.min(8, Math.ceil(actionCount / 3) || 1)),
  );
  return {
    activeBidders: pickRandomSubset(bidderList, activeBidderCount),
    hotItems: pickRandomSubset(itemList, hotItemCount),
  };
}

function chooseAuctionItem(hotItems, itemBidCounts) {
  const ranked = (Array.isArray(hotItems) ? hotItems : [])
    .map((item) => ({ item, count: itemBidCounts.get(String(item.id)) || 0 }))
    .sort((left, right) => left.count - right.count);
  if (ranked.length === 0) return null;
  const contenders = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
  return pickRandom(contenders)?.item || ranked[0].item;
}

function chooseBidderForAuctionItem(activeBidders, itemId, itemBidderHistory, lastBidderByItem) {
  const source = Array.isArray(activeBidders) ? activeBidders : [];
  const itemKey = String(itemId);
  const seenForItem = itemBidderHistory.get(itemKey) || new Set();
  const lastBidderId = String(lastBidderByItem.get(itemKey) || '');

  let candidates = source.filter((bidder) => !seenForItem.has(String(bidder.id)));
  if (!candidates.length) {
    candidates = source.filter((bidder) => String(bidder.id) !== lastBidderId);
  }
  if (!candidates.length) {
    candidates = source;
  }
  return pickRandom(candidates);
}

async function authenticateAsBidder(adminPage, browser, bidderId, eventSlug, baseUrl) {
  const tokenResponse = await adminPage.request.post(`${baseUrl}/ajax/admin/manage-bidders.php`, {
    form: {
      action: 'log_in_as_bidder',
      bidderId: String(bidderId),
    },
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!tokenResponse.ok()) {
    throw new Error(`Failed to get login-as-bidder token for bidder ${bidderId}: ${tokenResponse.status()}`);
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData?.success || !tokenData?.token) {
    throw new Error(`Login-as-bidder token request failed for bidder ${bidderId}: ${JSON.stringify(tokenData)}`);
  }

  const bidderContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const bidderPage = await bidderContext.newPage();
  await bidderPage.request.post(`${baseUrl}/app/public/bidapp/${eventSlug}/login-as-bidder`, {
    form: {
      bidder_id: String(bidderId),
      token: tokenData.token,
    },
  });
  try {
    await bidderPage.goto(`${baseUrl}/app/public/bidapp/${eventSlug}/auction`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  } catch (error) {
    process.stderr.write(`[fallback] Bidder ${bidderId} auction page load timed out once; retrying: ${error.message}\n`);
    await bidderPage.goto(`${baseUrl}/app/public/bidapp/${eventSlug}/auction`, {
      waitUntil: 'commit',
      timeout: 45000,
    });
  }
  return { bidderContext, bidderPage };
}

function createBidderSessionCache(authenticate) {
  const sessions = new Map();

  const get = async (bidderId) => {
    const key = String(bidderId);
    if (!sessions.has(key)) {
      const sessionPromise = Promise.resolve()
        .then(() => authenticate(bidderId))
        .catch((error) => {
          sessions.delete(key);
          throw error;
        });
      sessions.set(key, sessionPromise);
    }
    return sessions.get(key);
  };

  const discard = async (bidderId) => {
    const key = String(bidderId);
    const sessionPromise = sessions.get(key);
    sessions.delete(key);
    if (!sessionPromise) return;
    try {
      const session = await sessionPromise;
      await session?.bidderContext?.close?.().catch(() => undefined);
    } catch (_) {
      // Failed session creation already removed the cache entry.
    }
  };

  const closeAll = async () => {
    const sessionPromises = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(sessionPromises.map(async (sessionPromise) => {
      try {
        const session = await sessionPromise;
        await session?.bidderContext?.close?.().catch(() => undefined);
      } catch (_) {
        // Ignore cleanup failures.
      }
    }));
  };

  return { get, discard, closeAll };
}

async function readBidappCsrfToken(page) {
  const token = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta?.getAttribute('content') || '';
  });
  if (token) return token;
  const cookies = await page.context().cookies();
  const xsrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
  return xsrf ? decodeURIComponent(xsrf.value) : '';
}

function bidappHeaders(csrfToken) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (csrfToken) {
    headers['X-CSRF-TOKEN'] = csrfToken;
    headers['X-XSRF-TOKEN'] = csrfToken;
  }
  return headers;
}

async function parseApiResponseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function postJson(page, url, data, extraHeaders = {}) {
  const response = await page.request.post(url, {
    data,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extraHeaders,
    },
  });
  const body = await parseApiResponseBody(response);
  return { response, body };
}

async function findOrganizationEventBySlug(page, baseUrl, organizationId, slug, attempts = 3) {
  const wantedSlug = String(slug || '').trim().toLowerCase();
  if (!wantedSlug) return null;

  const eventsUrl = `${baseUrl}/app/public/organizations/${organizationId}/events?status=all&sort_by=keyword`;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    await page.goto(eventsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    const found = await page.evaluate((targetSlug) => {
      const cards = Array.from(document.querySelectorAll('.event-card'));
      for (const card of cards) {
        const keyword = card.querySelector('.keyword')?.textContent?.trim().toLowerCase();
        if (keyword !== targetSlug) continue;
        const eventData = card.querySelector('.event-data');
        const title = card.querySelector('header span')?.textContent?.trim() || '';
        return {
          id: card.dataset.id || eventData?.dataset.id || '',
          slug: keyword,
          name: title,
        };
      }
      return null;
    }, wantedSlug);
    if (found?.id) return found;
    if (attempt < attempts - 1) {
      await page.waitForTimeout(1000);
    }
  }
  return null;
}

async function readOrganizationEventsSummary(page, baseUrl, organizationId) {
  const eventsUrl = `${baseUrl}/app/public/organizations/${organizationId}/events?status=all&sort_by=keyword`;
  await page.goto(eventsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  return page.evaluate(() => {
    const headingText = document.body?.innerText?.match(/All Events\s*-\s*(\d+)/i)?.[0] || '';
    const visibleCount = Number(document.body?.innerText?.match(/All Events\s*-\s*(\d+)/i)?.[1] || 0);
    const cards = Array.from(document.querySelectorAll('.event-card')).map((card) => ({
      id: card.dataset.id || '',
      keyword: card.querySelector('.keyword')?.textContent?.trim() || '',
      name: card.querySelector('header span')?.textContent?.trim() || '',
    }));
    return {
      headingText,
      visibleCount,
      cardCount: cards.length,
      keywords: cards.map((card) => card.keyword).filter(Boolean).slice(0, 20),
    };
  });
}

async function recoverCreatedEventFromFailedAdminResponse(page, payload, failureMessage) {
  const recovered = await findOrganizationEventBySlug(
    page,
    payload.baseUrl,
    payload.organizationId,
    payload.event?.slug,
  );
  if (!recovered?.id) return null;

  process.stderr.write(
    `[fallback] Event create response failed, but event was found on org events page: ` +
    `event.id=${recovered.id}, keyword=${recovered.slug}. Original failure: ${failureMessage}\n`
  );
  return {
    success: true,
    id: recovered.id,
    slug: recovered.slug,
    recoveredFromFailedResponse: true,
  };
}

async function describeFailedEventCreation(page, payload, failureMessage) {
  try {
    const summary = await readOrganizationEventsSummary(page, payload.baseUrl, payload.organizationId);
    const parts = [
      failureMessage,
      `Org events page summary: ${summary.headingText || `${summary.visibleCount || summary.cardCount} visible event(s)`}.`,
    ];
    if (summary.keywords?.length) {
      parts.push(`Visible keywords: ${summary.keywords.join(', ')}.`);
    }
    return parts.join(' ');
  } catch (error) {
    return `${failureMessage} Unable to read org events page after failure: ${error.message}`;
  }
}

async function clickNewEventNext(page, expectedSection) {
  const nextButton = page.locator('button[name="new-event-next-page"]');
  await nextButton.click();
  if (expectedSection) {
    await page.locator(`.new-event-page[data-section="${expectedSection}"]`).waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function createEventViaAdminWizard(page, payload, originalFailureMessage) {
  const eventsUrl = `${payload.baseUrl}/app/public/organizations/${payload.organizationId}/events`;
  process.stderr.write(`[fallback] Direct AJAX create failed; trying real admin Add Event wizard. Original failure: ${originalFailureMessage}\n`);
  process.stderr.write(`[fallback] Opening org events page for wizard: ${eventsUrl}\n`);
  await page.goto(eventsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);

  const addButton = page.locator('button[name="add-event"]');
  await addButton.waitFor({ state: 'visible', timeout: 15000 });
  await addButton.click();
  await page.locator('.new-event-modal').waitFor({ state: 'visible', timeout: 10000 });

  await page.locator('input[name="new-event-keyword"]').fill(payload.event.slug);
  await page.locator('input[name="new-event-name"]').fill(payload.event.name);
  await page.locator('input[name="new-event-start-date"]').fill(toDateOnly(payload.event.startDate));
  await page.locator('input[name="new-event-closing-date"]').fill(toDateOnly(payload.event.endDate));
  await page.locator('input[name="new-event-on-call-date"]').fill(toDateOnly(payload.event.onCallDate || payload.event.endDate || payload.event.startDate));
  await page.locator('select[name="new-event-time-zone"]').selectOption(payload.event.timezone || 'America/New_York');
  await clickNewEventNext(page, 'contact-info');

  await page.locator('input[name="new-event-first-name"]').fill(payload.event.contactFirstName || 'QA');
  await page.locator('input[name="new-event-last-name"]').fill(payload.event.contactLastName || 'Automation');
  await page.locator('input[name="new-event-phone"]').fill(payload.event.contactPhone || '5550000000');
  await page.locator('input[name="new-event-email"]').fill(payload.event.contactEmail || 'qa-event@example.com');
  await page.locator('input[name="new-event-email"]').blur();
  await page.waitForTimeout(750);
  await clickNewEventNext(page, 'event-options');
  await clickNewEventNext(page, 'confirm');

  const responsePromise = page.waitForResponse((response) => (
    response.url().includes('/ajax/admin/organization/events.php') &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.locator('button[name="save-new-event"]').click();
  const response = await responsePromise;
  const result = await parseApiResponseBody(response);

  if (typeof result === 'string') {
    throw new Error(
      `Admin wizard event creation returned non-JSON response ` +
      `(HTTP ${response.status()}, ${response.url()}): ` +
      `${result.trim() ? result.trim().slice(0, 1000) : '(empty response)'}`
    );
  }

  if (!response.ok() || !result?.success) {
    const uiMessage = await page.locator('#new-event-error-message').innerText({ timeout: 1000 }).catch(() => '');
    throw new Error(
      `Admin wizard event creation failed with HTTP ${response.status()}: ` +
      `${result?.message || uiMessage || JSON.stringify(result)}`
    );
  }

  process.stderr.write(`[fallback] Admin wizard created event.id=${result.id}, keyword=${payload.event.slug}\n`);
  return result;
}

function stripeFormBody(params) {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    body.append(key, String(value));
  });
  return body;
}

async function postStripeForm(url, publishableKey, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${publishableKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: stripeFormBody(params),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text;
  }

  if (!response.ok || body?.error) {
    const message = body?.error?.message || body?.message || text || `Stripe request failed: ${response.status}`;
    throw new Error(message);
  }

  return body;
}

async function fetchStripePublishableKey(page, baseUrl, organizationId) {
  const response = await page.request.get(`${baseUrl}/app/public/api/stripe/v3/organizations/${organizationId}/key`, {
    headers: { Accept: 'application/json' },
  });
  const body = await parseApiResponseBody(response);
  if (!response.ok() || !body?.publicKey) {
    throw new Error(`Stripe public key request failed: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body.publicKey;
}

async function createStripePaymentMethod(publishableKey, purchaser) {
  return postStripeForm('https://api.stripe.com/v1/payment_methods', publishableKey, {
    type: 'card',
    'card[number]': '4242424242424242',
    'card[exp_month]': '12',
    'card[exp_year]': '2035',
    'card[cvc]': '123',
    'billing_details[name]': `${purchaser.firstName} ${purchaser.lastName}`.trim(),
    'billing_details[email]': purchaser.email,
    'billing_details[phone]': purchaser.phone,
    'billing_details[address][line1]': purchaser.address,
    'billing_details[address][city]': purchaser.city,
    'billing_details[address][state]': purchaser.state,
    'billing_details[address][postal_code]': purchaser.postalCode,
    'billing_details[address][country]': 'US',
  });
}

async function confirmStripePaymentIntent(publishableKey, paymentIntentId, clientSecret, paymentMethodId, returnUrl) {
  return postStripeForm(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`, publishableKey, {
    client_secret: clientSecret,
    payment_method: paymentMethodId,
    return_url: returnUrl,
  });
}

async function placeBidappBid(page, baseUrl, eventSlug, itemId, amount, maxAmount = null) {
  const csrfToken = await readBidappCsrfToken(page);
  const response = await page.request.post(`${baseUrl}/app/public/bidapp/${eventSlug}/auction/bids/${itemId}`, {
    data: maxAmount
      ? { type: 'max_bid', amount, max_amount: maxAmount }
      : { type: 'fast_bid', amount },
    headers: bidappHeaders(csrfToken),
  });
  const body = await parseApiResponseBody(response);
  if (!response.ok()) {
    throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
  }
  return body;
}

async function placeBidappDonation(page, baseUrl, eventSlug, itemId, amount, isAnonymous = false) {
  const csrfToken = await readBidappCsrfToken(page);
  const response = await page.request.post(`${baseUrl}/app/public/bidapp/${eventSlug}/donate/${itemId}`, {
    data: {
      one_time_amount: amount,
      recurring_amount: 0,
      is_anonymous: isAnonymous,
      admin_fee_opt_out: false,
      hide_notes: true,
      notes: '',
    },
    headers: bidappHeaders(csrfToken),
  });
  const body = await parseApiResponseBody(response);
  if (!response.ok()) {
    throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
  }
  return body;
}

async function performApiTicketPurchase(page, baseUrl, eventSlug, postCreateActivity, resolvedTarget, paymentMethod = 'check', purchaseOrdinal = 0) {
  const formName = resolvedTarget.formName;
  const { purchaser, purchaseType, unitCount, expectedGuests, guestSeeds } = buildTicketPurchaseSeedData(
    postCreateActivity,
    resolvedTarget,
    purchaseOrdinal,
  );
  const paymentMethodId = PAYMENT_METHOD_IDS[paymentMethod] || PAYMENT_METHOD_IDS.check;
  const snapshot = await getPublicTicketFormSnapshot(page, baseUrl, eventSlug, formName);
  const snapshotTargets = snapshot.targets?.[purchaseType] || [];
  const snapshotTarget = snapshotTargets[resolvedTarget.targetIndex] || snapshotTargets[0] || null;
  if (!snapshotTarget) {
    throw new Error(`No ${purchaseType} ticket element found at index ${resolvedTarget.targetIndex}`);
  }
  const requestData = buildTicketPurchaseRequestData(snapshotTarget, purchaser, guestSeeds, paymentMethodId, unitCount);
  process.stderr.write(`[fallback] API ticket purchase: ${purchaseType} index=${resolvedTarget.targetIndex} qty=${unitCount} payment=${paymentMethod}\n`);
  const validateUrl = `${baseUrl}/app/public/bidapp/${eventSlug}/tickets/${formName}/validate`;
  const storeUrl = `${baseUrl}/app/public/bidapp/${eventSlug}/tickets/${formName}`;
  const validateResult = await postJson(page, validateUrl, requestData);
  if (!validateResult.response.ok()) {
    const bodyStr = typeof validateResult.body === 'string' ? validateResult.body : JSON.stringify(validateResult.body);
    throw new Error(`API ticket purchase failed at validate (HTTP ${validateResult.response.status()}): ${bodyStr.slice(0, 600)}`);
  }
  const storeResult = await postJson(page, storeUrl, requestData);
  if (!storeResult.response.ok()) {
    const bodyStr = typeof storeResult.body === 'string' ? storeResult.body : JSON.stringify(storeResult.body);
    throw new Error(`API ticket purchase failed at store (HTTP ${storeResult.response.status()}): ${bodyStr.slice(0, 600)}`);
  }

  process.stderr.write(`[fallback] API ticket purchase OK: total=$${requestData.total} guests=${requestData.guests.length}\n`);

  return {
    purchaser,
    guestCount: requestData.guests.length ?? expectedGuests,
    donationApplied: false,
    // Donations never route through the API path (they require the credit-card
    // browser checkout), so there is no donation warning to surface here.
    warning: null,
  };
}

async function performDirectStripeTicketPurchase(page, baseUrl, eventSlug, postCreateActivity, resolvedTarget, purchaseOrdinal = 0) {
  const purchase = postCreateActivity.ticketPurchases;
  const formName = resolvedTarget.formName;
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: preparing ${resolvedTarget.targetLabel} on ${formName}\n`);
  const { purchaser, purchaseType, unitCount, expectedGuests, guestSeeds } = buildTicketPurchaseSeedData(
    postCreateActivity,
    resolvedTarget,
    purchaseOrdinal,
  );
  const snapshot = await getPublicTicketFormSnapshot(page, baseUrl, eventSlug, formName);
  const snapshotTargets = snapshot.targets?.[purchaseType] || [];
  const snapshotTarget = snapshotTargets[resolvedTarget.targetIndex] || snapshotTargets[0] || null;
  if (!snapshotTarget) {
    throw new Error(`No ${purchaseType} ticket element found at index ${resolvedTarget.targetIndex}`);
  }

  const requestData = buildTicketPurchaseRequestData(
    snapshotTarget,
    purchaser,
    guestSeeds,
    PAYMENT_METHOD_IDS.credit_card,
    unitCount,
  );
  const validateUrl = `${baseUrl}/app/public/bidapp/${eventSlug}/tickets/${formName}/validate`;
  const storeUrl = `${baseUrl}/app/public/bidapp/${eventSlug}/tickets/${formName}`;
  const validateResult = await postJson(page, validateUrl, requestData);
  if (!validateResult.response.ok()) {
    const bodyStr = typeof validateResult.body === 'string' ? validateResult.body : JSON.stringify(validateResult.body);
    throw new Error(`Direct Stripe ticket purchase failed at validate (HTTP ${validateResult.response.status()}): ${bodyStr.slice(0, 600)}`);
  }
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: validate OK\n`);

  const publishableKey = await fetchStripePublishableKey(page, baseUrl, snapshot.organizationId);
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: Stripe public key OK\n`);
  const intentResult = await postJson(
    page,
    `${baseUrl}/app/public/api/stripe/v3/organizations/${snapshot.organizationId}/events/${snapshot.eventId}/create-payment`,
    {
      amount: requestData.total,
      offSession: false,
      metadata: {
        first_name: purchaser.firstName,
        last_name: purchaser.lastName,
        address: purchaser.address || '',
        city: purchaser.city || '',
        state: purchaser.state || '',
        zip: purchaser.postalCode || '',
        email: purchaser.email,
        phone: purchaser.phone,
      },
      createCustomer: true,
      setupFutureUsage: 'off_session',
      captureMethod: 'manual',
    },
  );
  if (!intentResult.response.ok() || !intentResult.body?.paymentIntentId || !intentResult.body?.clientSecretId) {
    const bodyStr = typeof intentResult.body === 'string' ? intentResult.body : JSON.stringify(intentResult.body);
    throw new Error(`Direct Stripe payment intent failed (HTTP ${intentResult.response.status()}): ${bodyStr.slice(0, 600)}`);
  }
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: payment intent ${intentResult.body.paymentIntentId} created\n`);

  const paymentMethod = await createStripePaymentMethod(publishableKey, purchaser);
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: payment method ${paymentMethod.id} created\n`);
  const confirmedIntent = await confirmStripePaymentIntent(
    publishableKey,
    intentResult.body.paymentIntentId,
    intentResult.body.clientSecretId,
    paymentMethod.id,
    ticketPagePublicUrl(baseUrl, eventSlug, formName),
  );
  const confirmedStatus = String(confirmedIntent?.status || '');
  if (!['requires_capture', 'succeeded', 'processing'].includes(confirmedStatus)) {
    throw new Error(`Direct Stripe confirm returned unexpected status: ${confirmedStatus || 'unknown'}`);
  }
  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: confirm status ${confirmedStatus}\n`);

  const storeResult = await postJson(page, storeUrl, {
    ...requestData,
    paymentIntentId: intentResult.body.paymentIntentId,
  });
  if (!storeResult.response.ok()) {
    const bodyStr = typeof storeResult.body === 'string' ? storeResult.body : JSON.stringify(storeResult.body);
    throw new Error(`Direct Stripe ticket purchase failed at store (HTTP ${storeResult.response.status()}): ${bodyStr.slice(0, 600)}`);
  }

  process.stderr.write(`[fallback] Direct Stripe purchase ${purchaseOrdinal + 1}: store OK total=$${requestData.total} guests=${requestData.guests.length}\n`);

  return {
    purchaser,
    guestCount: requestData.guests.length ?? expectedGuests,
    donationApplied: false,
    warning: null,
    via: 'direct-stripe',
  };
}

async function createTemporaryCheckoutPage(referencePage) {
  const currentContext = referencePage.context();
  const browser = typeof currentContext.browser === 'function'
    ? currentContext.browser()
    : null;

  if (!browser || typeof browser.newContext !== 'function') {
    throw new Error('Unable to create an isolated checkout browser context for credit-card ticket purchase fallback.');
  }

  const checkoutContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const checkoutPage = await checkoutContext.newPage();
  return {
    page: checkoutPage,
    close: async () => checkoutContext.close().catch(() => undefined),
  };
}

async function performSeededTicketPurchase(page, baseUrl, eventSlug, postCreateActivity, resolvedTarget, purchaseOrdinal = 0, addDonation = false) {
  const purchase = postCreateActivity.ticketPurchases;
  const { purchaser, guestSeeds } = buildTicketPurchaseSeedData(postCreateActivity, resolvedTarget, purchaseOrdinal);
  const formName = resolvedTarget.formName;
  let donationWarning = null;
  const snapshot = await getPublicTicketFormSnapshot(page, baseUrl, eventSlug, formName);
  if (addDonation && !snapshot.hasDonationSection) {
    donationWarning = 'Donation was requested, but no donation section was available on the public ticket page. Completed credit-card ticket purchase without donation via direct Stripe.';
  }
  const shouldAttemptDirectStripe = !addDonation || Boolean(donationWarning);

  if (shouldAttemptDirectStripe) {
    try {
      const result = await performDirectStripeTicketPurchase(
        page,
        baseUrl,
        eventSlug,
        postCreateActivity,
        resolvedTarget,
        purchaseOrdinal,
      );
      if (donationWarning) {
        return { ...result, warning: donationWarning };
      }
      return result;
    } catch (error) {
      process.stderr.write(`[fallback] Direct Stripe ticket purchase failed; falling back to browser checkout: ${error.message}\n`);
    }
  }

  const checkoutSession = await createTemporaryCheckoutPage(page);
  const checkoutPage = checkoutSession.page;
  try {
    await gotoResolvedPublicTicketPage(checkoutPage, snapshot.publicUrl || ticketPagePublicUrl(baseUrl, eventSlug, formName));
    await navigateTicketPurchaseSection(checkoutPage, 'Tickets');

    if (resolvedTarget.targetType === 'sponsor-ticket') {
      await navigateTicketPurchaseSection(checkoutPage, 'Sponsorships');
    }

    await setTicketQuantityByIndex(checkoutPage, resolvedTarget.targetIndex, purchase.quantity);
    await fillRequiredTicketQuestionsByIndex(checkoutPage, resolvedTarget.targetIndex);

    const expectedGuests = Math.max(0, resolvedTarget.guestsPerUnit * purchase.quantity);
    if (expectedGuests > 0) {
      await navigateTicketPurchaseSection(checkoutPage, 'Guest Details');
      const guestCards = await checkoutPage.locator('.guest-card').count();
      for (let index = 0; index < guestCards; index += 1) {
        const guest = guestSeeds[index] || buildCheckoutPerson(((purchaseOrdinal * 37) + (Number(resolvedTarget.targetIndex) * 11)) + index);
        await fillVisibleGuestCard(checkoutPage, guest, index < guestCards - 1);
      }
    }

    if (addDonation) {
      const donationSectionVisible = await navigateTicketPurchaseSection(checkoutPage, 'donation');
      const donationInput = checkoutPage.locator('section.donation .donation-amount').first();
      if (donationSectionVisible && await donationInput.count()) {
        await donationInput.fill(String(Number(purchase.donationAmount).toFixed(2)));
        await donationInput.blur();
      } else {
        donationWarning = 'Donation was requested, but no donation section was available on the public ticket page.';
      }
    }

    await navigateTicketPurchaseSection(checkoutPage, 'Payment');
    await fillPurchaserDetails(checkoutPage, purchaser);
    await selectCreditCard(checkoutPage);
    await fillStripeCard(checkoutPage);
    await completeTicketCheckout(checkoutPage);

    return {
      purchaser,
      guestCount: expectedGuests,
      donationApplied: Boolean(addDonation && !donationWarning),
      warning: donationWarning,
      via: 'browser-ui',
    };
  } finally {
    await checkoutSession.close();
  }
}

// Decide whether a purchase must go through the browser/Stripe checkout instead
// of the fast API path. Credit-card purchases always do. A purchase that requests
// a donation also must, because the API ticket-purchase path cannot attach a
// donation (it only warns) — the donation amount is filled in the public checkout UI.
// Donations are seeded only through the credit-card/Stripe browser checkout, so
// routing is purely by payment method: credit_card -> browser, everything else
// -> fast API.
function shouldUseBrowserCheckout(paymentMethod) {
  return paymentMethod === 'credit_card';
}

// Mark which entries of the execution plan also add a donation: the first
// `donationPurchaseCount` credit-card purchases. Non-credit-card purchases never
// donate (their checkout can't). Returns a boolean array parallel to the plan.
function assignDonationFlags(executionPlan, donationPurchaseCount) {
  const plan = Array.isArray(executionPlan) ? executionPlan : [];
  let remaining = Math.max(0, Number(donationPurchaseCount) || 0);
  return plan.map((method) => {
    if (method === 'credit_card' && remaining > 0) {
      remaining -= 1;
      return true;
    }
    return false;
  });
}

function ticketPurchaseConcurrencyForPlan(executionPlan) {
  const methods = Array.isArray(executionPlan) ? executionPlan : [];
  // Any credit-card purchase runs the slower browser/Stripe checkout.
  return methods.some((method) => shouldUseBrowserCheckout(method))
    ? CREDIT_CARD_TICKET_PURCHASE_CONCURRENCY
    : API_TICKET_PURCHASE_CONCURRENCY;
}

async function applyPostCreateActivity(page, baseUrl, eventSlug, postCreateActivity, ticketPages, bidders = [], items = []) {
  const normalized = postCreateActivity || {};
  if (normalized.enabled === false) {
    return { applied: [], skipped: [{ section: 'postCreateActivity', reason: 'disabled' }], warnings: [] };
  }

  const resolvedTarget = resolvePostCreatePurchaseTarget(normalized, ticketPages);
  const applied = [];
  const skipped = [];
  const warnings = [];

  if (normalized.ticketPurchases?.enabled !== false) {
    if (resolvedTarget.warning && !resolvedTarget.targetConfig) {
      skipped.push({ section: 'ticketPurchase', reason: resolvedTarget.warning });
      warnings.push({ section: 'ticketPurchase', message: resolvedTarget.warning });
    } else {
      const paymentSupport = resolveTicketPurchasePaymentSupport(resolvedTarget.pageConfig);
      const executionPlan = buildTicketPurchaseExecutionPlan(normalized.ticketPurchases);
      const supportedExecutionPlan = executionPlan.filter((method) => paymentSupport[method] !== false);
      const skippedMethods = executionPlan.filter((method) => paymentSupport[method] === false);
      if (supportedExecutionPlan.length > 0) {
        await getPublicTicketFormSnapshot(page, baseUrl, eventSlug, resolvedTarget.formName).catch(() => undefined);
      }
      if (skippedMethods.length > 0) {
        const counts = skippedMethods.reduce((acc, method) => {
          acc[method] = (acc[method] || 0) + 1;
          return acc;
        }, {});
        Object.entries(counts).forEach(([method, count]) => {
          warnings.push({
            section: 'ticketPurchase',
            formName: resolvedTarget.formName,
            target: resolvedTarget.targetLabel,
            message: `Skipped ${count} ${method.replace('_', ' ')} purchase(s) because that payment method is not enabled on the selected ticket page.`,
          });
        });
      }
      const concurrency = ticketPurchaseConcurrencyForPlan(supportedExecutionPlan);
      // The first donationPurchaseCount credit-card purchases also add a donation.
      const donationFlags = assignDonationFlags(supportedExecutionPlan, normalized.ticketPurchases?.donationPurchaseCount);
      const donatingCount = donationFlags.filter(Boolean).length;
      process.stderr.write(`[fallback] Ticket purchase execution plan: ${supportedExecutionPlan.length} supported purchase(s), concurrency=${concurrency}, donating=${donatingCount}\n`);
      const ticketStartedAt = Date.now();
      const purchaseResults = await mapWithConcurrency(supportedExecutionPlan, concurrency, async (paymentMethod, purchaseIndex) => {
        const purchaseTarget = resolvePostCreatePurchaseTargetForOrdinal(resolvedTarget, purchaseIndex);
        const useApi = !shouldUseBrowserCheckout(paymentMethod);
        const addDonation = donationFlags[purchaseIndex] === true;
        try {
          // Retry a flaky checkout up to 2 extra times. Browser purchases build a
          // fresh checkout page per attempt (createTemporaryCheckoutPage), and API
          // purchases are stateless, so a retry is a clean re-attempt.
          const result = await withRetry(
            () => (useApi
              ? performApiTicketPurchase(page, baseUrl, eventSlug, normalized, purchaseTarget, paymentMethod, purchaseIndex)
              : performSeededTicketPurchase(page, baseUrl, eventSlug, normalized, purchaseTarget, purchaseIndex, addDonation)),
            {
              attempts: 3,
              // A ticket page that never rendered its "Add" control is a deterministic
              // page-state failure (broken/blocked assets), not a flaky checkout —
              // retrying just burns ~30s more per attempt, so veto it.
              shouldRetry: (err) => !err?.ticketPageUnavailable,
              onRetry: (err, attempt) => process.stderr.write(
                `[fallback] Purchase ${purchaseIndex + 1} attempt ${attempt} failed (${err.message}); retrying…\n`,
              ),
            },
          );
          return {
            applied: {
            section: 'ticketPurchase',
            formName: resolvedTarget.formName,
            target: purchaseTarget.targetLabel,
            paymentMethod,
            via: result.via || (useApi ? 'api' : 'browser-ui'),
            purchaserEmail: result.purchaser.email,
            guests: result.guestCount,
            donation: result.donationApplied ? normalized.ticketPurchases.donationAmount : 0,
            },
            warning: result.warning ? {
              section: 'ticketPurchase',
              formName: resolvedTarget.formName,
              target: purchaseTarget.targetLabel,
              message: result.warning,
            } : null,
          };
        } catch (error) {
          return {
            warning: {
            section: 'ticketPurchase',
            formName: resolvedTarget.formName,
            target: purchaseTarget.targetLabel,
            message: `Purchase ${purchaseIndex + 1} failed: ${error.message}`,
            },
            skipped: {
            section: 'ticketPurchase',
            formName: resolvedTarget.formName,
            target: purchaseTarget.targetLabel,
            reason: `purchase ${purchaseIndex + 1} failed`,
            },
          };
        }
      });
      purchaseResults.forEach((result) => {
        if (!result) return;
        if (result.applied) applied.push(result.applied);
        if (result.warning) warnings.push(result.warning);
        if (result.skipped) skipped.push(result.skipped);
      });
      process.stderr.write(`[fallback] Ticket purchase activity completed in ${elapsedSeconds(ticketStartedAt)}s\n`);
    }
  } else {
    skipped.push({ section: 'ticketPurchase', reason: 'disabled' });
  }

  const eligibleBidders = (Array.isArray(bidders) ? bidders : [])
    .filter((bidder) => Number(bidder?.id) > 0);
  const auctionItems = filterPostCreateAuctionItems(items, normalized.auctionActivity);
  const donationItems = filterPostCreateDonationItems(items);
  const browser = page.context().browser();
  const bidderSessions = browser
    ? createBidderSessionCache((bidderId) => authenticateAsBidder(page, browser, bidderId, eventSlug, baseUrl))
    : null;

  try {
    if (normalized.auctionActivity?.enabled) {
      if (eligibleBidders.length === 0) {
        skipped.push({ section: 'auctionActivity', reason: 'no bidders available for impersonation' });
      } else if (auctionItems.length === 0) {
        skipped.push({ section: 'auctionActivity', reason: 'no eligible silent/live items were created' });
      } else if (!bidderSessions) {
        skipped.push({ section: 'auctionActivity', reason: 'browser context unavailable for bidder impersonation' });
      } else {
        const auctionStartedAt = Date.now();
        const totalBidActions = Math.max(0, Number(normalized.auctionActivity.bidCount) || 0)
          + Math.max(0, Number(normalized.auctionActivity.maxBidCount) || 0);
        const pools = buildAuctionActivityPools(eligibleBidders, auctionItems, totalBidActions);
        const activeBidders = pools.activeBidders.length ? pools.activeBidders : eligibleBidders;
        const hotItems = pools.hotItems.length ? pools.hotItems : auctionItems;
        const itemState = new Map();
        const itemBidCounts = new Map();
        const itemBidderHistory = new Map();
        const lastBidderByItem = new Map();
        const runBidAction = async (actionIndex, type) => {
          const item = chooseAuctionItem(hotItems, itemBidCounts);
          const bidder = chooseBidderForAuctionItem(activeBidders, item?.id, itemBidderHistory, lastBidderByItem);
          if (!bidder || !item) return;
          const bidIncrement = Math.max(1, Number(item.bid_increment) || 1);
          const current = itemState.get(String(item.id)) || Math.max(Number(item.starting_bid) || bidIncrement, bidIncrement);
          const amount = current;
          const maxAmount = type === 'max'
            ? amount + (bidIncrement * randomIntInclusive(2, 5))
            : null;
          let bidderPage;
          try {
            ({ bidderPage } = await bidderSessions.get(bidder.id));
            await placeBidappBid(bidderPage, baseUrl, eventSlug, item.id, amount, maxAmount);
            itemState.set(String(item.id), (maxAmount || amount) + bidIncrement);
            itemBidCounts.set(String(item.id), (itemBidCounts.get(String(item.id)) || 0) + 1);
            if (!itemBidderHistory.has(String(item.id))) itemBidderHistory.set(String(item.id), new Set());
            itemBidderHistory.get(String(item.id)).add(String(bidder.id));
            lastBidderByItem.set(String(item.id), String(bidder.id));
            applied.push({
              section: 'auctionActivity',
              mode: type === 'max' ? 'maxBid' : 'bid',
              bidder: buildBidderDisplayName(bidder),
              item: item.item_name || `Item ${item.id}`,
              amount,
              maxAmount,
            });
          } catch (error) {
            warnings.push({
              section: 'auctionActivity',
              bidder: buildBidderDisplayName(bidder),
              item: item.item_name || `Item ${item.id}`,
              message: `Bid failed: ${error.message}`,
            });
            await bidderSessions.discard(bidder.id);
          }
        };

        for (let index = 0; index < (normalized.auctionActivity.bidCount || 0); index += 1) {
          await runBidAction(index, 'fast');
        }
        for (let index = 0; index < (normalized.auctionActivity.maxBidCount || 0); index += 1) {
          await runBidAction(index + (normalized.auctionActivity.bidCount || 0), 'max');
        }
        process.stderr.write(`[fallback] Auction activity completed in ${elapsedSeconds(auctionStartedAt)}s\n`);
      }
    }

    if (normalized.donationActivity?.enabled) {
      if (eligibleBidders.length === 0) {
        skipped.push({ section: 'donationActivity', reason: 'no bidders available for impersonation' });
      } else if (donationItems.length === 0) {
        skipped.push({ section: 'donationActivity', reason: 'no donation items were created' });
      } else if (!bidderSessions) {
        skipped.push({ section: 'donationActivity', reason: 'browser context unavailable for bidder impersonation' });
      } else {
        const donationStartedAt = Date.now();
        const donationCount = Math.max(0, Number(normalized.donationActivity.donationCount) || 0);
        for (let index = 0; index < donationCount; index += 1) {
          const bidder = pickRoundRobin(eligibleBidders, index);
          const item = pickRoundRobin(donationItems, index);
          const amount = randomIntInclusive(
            Math.max(1, Number(normalized.donationActivity.amountMin) || 1),
            Math.max(1, Number(normalized.donationActivity.amountMax) || 1),
          );
          const isAnonymous = Math.random() * 100 < (Number(normalized.donationActivity.anonymousRate) || 0);
          let bidderPage;
          try {
            ({ bidderPage } = await bidderSessions.get(bidder.id));
            await placeBidappDonation(bidderPage, baseUrl, eventSlug, item.id, amount, isAnonymous);
            applied.push({
              section: 'donationActivity',
              bidder: buildBidderDisplayName(bidder),
              item: item.item_name || `Donation ${item.id}`,
              amount,
              anonymous: isAnonymous,
            });
          } catch (error) {
            warnings.push({
              section: 'donationActivity',
              bidder: buildBidderDisplayName(bidder),
              item: item.item_name || `Donation ${item.id}`,
              message: `Donation failed: ${error.message}`,
            });
            await bidderSessions.discard(bidder.id);
          }
        }
        process.stderr.write(`[fallback] Donation activity completed in ${elapsedSeconds(donationStartedAt)}s\n`);
      }
    }
  } finally {
    await bidderSessions?.closeAll();
  }

  if (!applied.length && !skipped.length) {
    skipped.push({ section: 'postCreateActivity', reason: 'no configured activity was applied' });
  }

  process.stderr.write(`[fallback] Post-create activity applied=${applied.length}, skipped=${skipped.length}, warnings=${warnings.length}\n`);
  return { applied, skipped, warnings };
}

async function applyTicketPages(page, baseUrl, eventId, eventSlug, ticketPages) {
  const normalized = ticketPages || {};
  if (normalized.enabled === false) {
    return { applied: [], skipped: [{ section: 'ticketPages', reason: 'disabled' }], warnings: [] };
  }

  const plans = buildTicketPagePlans(normalized);
  if (plans.length === 0) {
    return { applied: [], skipped: [{ section: 'ticketPages', reason: 'no pages configured' }], warnings: [] };
  }

  await switchToEvent(page, baseUrl, eventId);
  const applied = [];
  const skipped = [];
  const warnings = [];

  for (const plan of plans) {
    const pageConfig = plan.page || {};
    let currentFormName = plan.initialFormName;

    process.stderr.write(`[fallback] Preparing ticket page "${plan.targetFormName}"...\n`);
    if (!currentFormName) {
      currentFormName = await createNewTicketPage(page, baseUrl);
      applied.push({ section: 'ticketPageForm', action: 'create', formName: currentFormName });
    }

    if (currentFormName !== plan.targetFormName) {
      const renameResult = await renameTicketPage(page, baseUrl, currentFormName, plan.targetFormName);
      if (renameResult.applied) applied.push({ section: 'ticketPageForm', action: 'rename', from: currentFormName, to: plan.targetFormName });
      else skipped.push(renameResult);
      currentFormName = plan.targetFormName;
    }

    const settingsResult = await applyTicketPageSettings(page, baseUrl, currentFormName, pageConfig);
    applied.push(...settingsResult.applied.map((entry) => ({ ...entry, section: 'ticketPageSettings', formName: currentFormName })));
    skipped.push(...settingsResult.skipped.map((entry) => ({ ...entry, section: 'ticketPageSettings', formName: currentFormName })));
    warnings.push(...settingsResult.warnings.map((entry) => ({ ...entry, section: 'ticketPageSettings', formName: currentFormName })));

    await page.goto(`${baseUrl}/admin/modify_tickets.php?form_name=${encodeURIComponent(currentFormName)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#all_tickets_wrapper', { state: 'visible', timeout: 10000 });
    const ticketFormId = await page.locator('#i_ticket_form_id').inputValue();
    const createdTargets = {
      individual: [],
      sponsor: [],
      underwriting: [],
    };

    for (const ticket of Array.isArray(pageConfig.individualTickets) ? pageConfig.individualTickets : []) {
      const saveResult = await createTicketRecord(page, {
        addButtonName: 'Add Ticket',
        formVisibleSelector: '#individual_ticket_form',
        saveResponseSubstring: '/ajax/post_individual_ticket.php',
        fields: {
          '#onblur_i-name': String(ticket.name || 'Ticket'),
          '#onblur_i-price': String(ticket.price ?? 0),
          '#onblur_i-fmv': String(ticket.fairMarketValue ?? 0),
          '#onblur_i-qty': String(ticket.ticketsPerPurchase ?? 1),
          '#onblur_i-availability': String(ticket.availability ?? 0),
        },
        completeButtonName: 'Complete and Go Back',
      });
      await setSelectValue(page, '#onchange_i-visible', ticket.visible === false ? '0' : '1');
      const ticketId = extractCreatedTicketId(saveResult);
      if (ticketId) {
        createdTargets.individual.push({ id: ticketId, name: ticket.name || 'Ticket' });
        for (const question of Array.isArray(ticket.customQuestions) ? ticket.customQuestions : []) {
          await saveCustomQuestion(page, 'individual-ticket', ticketId, question);
          applied.push({ section: 'ticketPageCustomQuestion', type: 'individual', formName: currentFormName, record: ticket.name || 'Ticket', question: question.question || 'Custom question' });
        }
      }
      applied.push({ section: 'ticketPageRecord', type: 'individual', formName: currentFormName, name: ticket.name || 'Ticket' });
    }

    for (const sponsor of Array.isArray(pageConfig.sponsors) ? pageConfig.sponsors : []) {
      const saveResult = await createTicketRecord(page, {
        addButtonName: 'Add Sponsor Level',
        formVisibleSelector: '#sponsor_ticket_form',
        saveResponseSubstring: '/ajax/post_sponsor_ticket.php',
        fields: {
          '#onblur_s-title': String(sponsor.title || 'Sponsor'),
          '#onblur_s-price': String(sponsor.price ?? 0),
          '#onblur_s-fmv': String(sponsor.fairMarketValue ?? 0),
          '#onblur_s-ticket': String(sponsor.ticketsPerPurchase ?? 0),
          '#onblur_s-availability': String(sponsor.availability ?? 0),
        },
        completeButtonName: 'Complete and Go Back',
      });
      await setSelectValue(page, '#onchange_s-visible', sponsor.visible === false ? '0' : '1');
      const sponsorId = extractCreatedTicketId(saveResult);
      if (sponsorId) {
        createdTargets.sponsor.push({ id: sponsorId, name: sponsor.title || 'Sponsor' });
        for (const question of Array.isArray(sponsor.customQuestions) ? sponsor.customQuestions : []) {
          await saveCustomQuestion(page, 'sponsor-ticket', sponsorId, question);
          applied.push({ section: 'ticketPageCustomQuestion', type: 'sponsor', formName: currentFormName, record: sponsor.title || 'Sponsor', question: question.question || 'Custom question' });
        }
      }
      applied.push({ section: 'ticketPageRecord', type: 'sponsor', formName: currentFormName, name: sponsor.title || 'Sponsor' });
    }

    for (const underwriting of Array.isArray(pageConfig.underwriting) ? pageConfig.underwriting : []) {
      const saveResult = await createTicketRecord(page, {
        addButtonName: 'Add Underwriting',
        formVisibleSelector: '#underwriting_ticket_form',
        saveResponseSubstring: '/ajax/post_underwriting_ticket.php',
        fields: {
          '#onblur_u-title': String(underwriting.title || 'Underwriting'),
          '#onblur_u-price': String(underwriting.price ?? 0),
          '#onblur_u-fmv': String(underwriting.fairMarketValue ?? 0),
          '#onblur_u-availability': String(underwriting.availability ?? 0),
        },
        completeButtonName: 'Complete and Go Back',
      });
      await setSelectValue(page, '#onchange_u-visible', underwriting.visible === false ? '0' : '1');
      const underwritingId = extractCreatedTicketId(saveResult);
      if (underwritingId) {
        createdTargets.underwriting.push({ id: underwritingId, name: underwriting.title || 'Underwriting' });
        for (const question of Array.isArray(underwriting.customQuestions) ? underwriting.customQuestions : []) {
          await saveCustomQuestion(page, 'underwriting-ticket', underwritingId, question);
          applied.push({ section: 'ticketPageCustomQuestion', type: 'underwriting', formName: currentFormName, record: underwriting.title || 'Underwriting', question: question.question || 'Custom question' });
        }
      }
      applied.push({ section: 'ticketPageRecord', type: 'underwriting', formName: currentFormName, name: underwriting.title || 'Underwriting' });
    }

    for (const selection of Array.isArray(pageConfig.selections) ? pageConfig.selections : []) {
      const selectable = resolveSelectionSelectable(selection, createdTargets, ticketFormId);
      if (selectable.warning) {
        warnings.push({ section: 'ticketPageSelection', formName: currentFormName, name: selection.name || 'Selection', message: selectable.warning });
      }
      const selectionResult = await saveSelection(page, ticketFormId, selection, selectable);
      applied.push({
        section: 'ticketPageSelection',
        formName: currentFormName,
        name: selection.name || 'Selection',
        id: selectionResult?.id || null,
        showOn: selectable.label,
      });
    }

    warnings.push(...collectTicketPageWarnings(pageConfig, currentFormName));
  }

  const firstFormName = plans[0]?.targetFormName || 'tix';
  const publicUrl = ticketPagePublicUrl(baseUrl, eventSlug, firstFormName);
  process.stderr.write(`[fallback] Ticket pages applied=${applied.length}, skipped=${skipped.length}, warnings=${warnings.length}\n`);
  return { applied, skipped, warnings, publicUrl, primaryFormName: firstFormName };
}

function mapCreatedItemsByIndex(items, indexKey) {
  return new Map(
    (Array.isArray(items) ? items : [])
      .filter((item) => item && item.id)
      .map((item) => [Number(item[indexKey]), item]),
  );
}

function resolveAttachedItemsForPage(page, itemConfig) {
  const bulkIndexes = Array.isArray(page?.[itemConfig.bulkIndexKey]) ? page[itemConfig.bulkIndexKey] : [];
  const exactIndexes = Array.isArray(page?.[itemConfig.exactIndexKey]) ? page[itemConfig.exactIndexKey] : [];
  const bulkResolvedItems = bulkIndexes
    .map((bulkIndex) => itemConfig.byBulkIndex.get(Number(bulkIndex)) || null)
    .filter(Boolean);
  const exactResolvedItems = exactIndexes
    .map((exactIndex) => itemConfig.byExactIndex.get(Number(exactIndex)) || null)
    .filter(Boolean);
  return {
    resolvedItems: [...bulkResolvedItems, ...exactResolvedItems],
    missingBulkIndexes: bulkIndexes.filter((bulkIndex) => !itemConfig.byBulkIndex.has(Number(bulkIndex))),
    missingExactIndexes: exactIndexes.filter((exactIndex) => !itemConfig.byExactIndex.has(Number(exactIndex))),
  };
}

function buildTicketPageItemAttachmentPlans(ticketPages, quantityItems, donationItems) {
  const pages = Array.isArray(ticketPages?.pages) ? ticketPages.pages : [];
  const quantityConfig = {
    type: 'quantity',
    bulkIndexKey: 'quantityItemBulkIndexes',
    exactIndexKey: 'quantityItemExactIndexes',
    byBulkIndex: mapCreatedItemsByIndex(quantityItems, 'bulkIndex'),
    byExactIndex: mapCreatedItemsByIndex(quantityItems, 'exactIndex'),
  };
  const donationConfig = {
    type: 'donation',
    bulkIndexKey: 'donationItemBulkIndexes',
    exactIndexKey: 'donationItemExactIndexes',
    byBulkIndex: mapCreatedItemsByIndex(donationItems, 'bulkIndex'),
    byExactIndex: mapCreatedItemsByIndex(donationItems, 'exactIndex'),
  };

  return pages.flatMap((page, pageIndex) => {
    const quantity = resolveAttachedItemsForPage(page, quantityConfig);
    const donation = resolveAttachedItemsForPage(page, donationConfig);
    return [{
      pageIndex,
      formName: String(page?.formName || '').trim() || 'tix',
      resolvedItems: [...quantity.resolvedItems, ...donation.resolvedItems],
      missingQuantityBulkIndexes: quantity.missingBulkIndexes,
      missingQuantityExactIndexes: quantity.missingExactIndexes,
      missingDonationBulkIndexes: donation.missingBulkIndexes,
      missingDonationExactIndexes: donation.missingExactIndexes,
    }];
  });
}

async function applyQuantityItemTier(page, item, csrfToken) {
  const tiers = Array.isArray(item?.quantity_tiers) ? item.quantity_tiers : [];
  const applied = [];
  const skipped = [];

  for (const tier of tiers) {
    const quantity = Math.max(1, Number(tier?.quantity) || 0);
    const price = Math.max(0, Number(tier?.price) || 0);
    if (!quantity) {
      skipped.push({ section: 'quantityItemTier', itemId: String(item.id), reason: 'missing quantity' });
      continue;
    }

    const result = await postAdminForm(page, '/ajax/admin/manage-items.php', {
      action: 'set_item_quantity',
      id: 'new',
      quantity: String(quantity),
      price: String(price),
      item_id: String(item.id),
    }, csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {});

    if (result.status >= 400 || result.body?.success === false) {
      throw new Error(result.body?.message || `Quantity tier save failed for item ${item.id}`);
    }

    applied.push({
      section: 'quantityItemTier',
      itemId: String(item.id),
      itemName: item.item_name || 'Quantity item',
      quantity,
      price,
    });
  }

  return { applied, skipped };
}

async function syncTicketPageItems(page, baseUrl, formName, resolvedItems) {
  await page.goto(`${baseUrl}/admin/ticket_form.php?form_name=${encodeURIComponent(formName)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#onblur-form_title', { state: 'visible', timeout: 10000 });

  const ticketFormId = await page.locator('#ticket-form-id').inputValue();
  const itemIds = resolvedItems.map((item) => String(item.id));
  const result = await page.evaluate(async ({ formId, ids }) => {
    const body = new URLSearchParams();
    body.append('action', 'sync-items');
    body.append('formId', String(formId));
    for (const id of ids) body.append('itemIds[]', String(id));

    const response = await fetch('/ajax/admin/ticket-form.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { success: false, message: text };
    }
    return { status: response.status, body: json };
  }, { formId: ticketFormId, ids: itemIds });

  if (result.status >= 400 || result.body?.success === false) {
    throw new Error(result.body?.message || `Quantity item sync failed for ticket page ${formName}`);
  }

  return {
    section: 'ticketPageItems',
    formName,
    ticketFormId: String(ticketFormId),
    itemIds,
  };
}

async function applyPostItemConfig(payload) {
  const playwright = requirePlaywright();
  const browserType = playwright[payload.browser || 'chromium'];
  if (!browserType?.launch) {
    throw new Error(`Unsupported Playwright browser: ${payload.browser}`);
  }

  const browser = await browserType.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const page = await browser.newPage();

  try {
    await loginToAdminSession(page, payload);
    await ensureSessionEventContext(page, payload);
    const csrfToken = await fetchCsrfTokenFromButler(page, payload);
    await switchToEvent(page, payload.baseUrl, payload.eventId);

    const applied = [];
    const skipped = [];
    const warnings = [];
    const quantityItems = Array.isArray(payload.quantityItems) ? payload.quantityItems : [];
    const donationItems = Array.isArray(payload.donationItems) ? payload.donationItems : [];

    for (const item of quantityItems) {
      const result = await applyQuantityItemTier(page, item, csrfToken);
      applied.push(...result.applied);
      skipped.push(...result.skipped);
    }

    const plans = buildTicketPageItemAttachmentPlans(payload.ticketPages, quantityItems, donationItems);
    for (const plan of plans) {
      if (plan.missingQuantityBulkIndexes.length > 0) {
        warnings.push({
          section: 'ticketPageQuantityItems',
          formName: plan.formName,
          message: `Some selected bulk quantity items were not created: bulk indexes ${plan.missingQuantityBulkIndexes.join(', ')}`,
        });
      }
      if (plan.missingQuantityExactIndexes.length > 0) {
        warnings.push({
          section: 'ticketPageQuantityItems',
          formName: plan.formName,
          message: `Some selected quantity items were not created: exact indexes ${plan.missingQuantityExactIndexes.join(', ')}`,
        });
      }
      if (plan.missingDonationBulkIndexes.length > 0) {
        warnings.push({
          section: 'ticketPageDonationItems',
          formName: plan.formName,
          message: `Some selected bulk donation items were not created: bulk indexes ${plan.missingDonationBulkIndexes.join(', ')}`,
        });
      }
      if (plan.missingDonationExactIndexes.length > 0) {
        warnings.push({
          section: 'ticketPageDonationItems',
          formName: plan.formName,
          message: `Some selected donation items were not created: exact indexes ${plan.missingDonationExactIndexes.join(', ')}`,
        });
      }

      if (plan.resolvedItems.length === 0) continue;
      applied.push(await syncTicketPageItems(page, payload.baseUrl, plan.formName, plan.resolvedItems));
    }

    return {
      ok: true,
      eventId: String(payload.eventId),
      postItemConfig: { applied, skipped, warnings },
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Create an event via the admin AJAX endpoint.
 *
 * Mirrors clickbid-tests/tests/setup/event-setup.spec.ts Phase 0:
 *   - Grabs CSRF token from a butler page meta tag
 *   - POSTs to /ajax/admin/organization/events.php with action=create-event
 *   - Parses the JSON response for the new event ID and slug
 */
async function createEventViaAdmin(payload) {
  const playwright = requirePlaywright();
  const browserType = playwright[payload.browser || 'chromium'];
  if (!browserType?.launch) {
    throw new Error(`Unsupported Playwright browser: ${payload.browser}`);
  }

  const browser = await browserType.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const page = await browser.newPage();

  try {
    await loginToAdminSession(page, payload);
    await ensureSessionEventContext(page, payload);
    const csrfToken = await fetchCsrfTokenFromButler(page, payload);

    // ── Step 4: Create event via AJAX ──────────────────────────────────
    // POST to /ajax/admin/organization/events.php with action=create-event.
    // This is the same endpoint the admin wizard form submits to, but called
    // directly — no multi-step wizard navigation needed.
    const eventCreateForm = {
      action: 'create-event',
      reuseKeyword: '',  // empty = create new event (don't reuse existing keyword)
      keyword: payload.event.slug,
      eventName: payload.event.name,
      eventStartDate: toDateOnly(payload.event.startDate),
      eventClosingDate: toDateOnly(payload.event.endDate),
      eventOnCallDate: toDateOnly(payload.event.onCallDate || payload.event.endDate || payload.event.startDate),
      timeZone: payload.event.timezone || 'America/Chicago',
      openAuctionEarly: 'true',
      firstName: payload.event.contactFirstName,
      lastName: payload.event.contactLastName,
      email: payload.event.contactEmail,
      phone: payload.event.contactPhone,
      // Don't copy anything from an existing event — start clean
      copyFromEvent: '0',
      copyAuctionSettings: 'false',
      copyBidders: 'false',
      copyItems: 'false',
      copyLandingPage: 'false',
      copyTicketPages: 'false',
      copyTableSeating: 'false',
      moveTicketSales: 'false',
      copyComposedTexts: 'false',
      copyComposedEmails: 'false',
      copyMerchantAccount: 'false',
      copyCustomCss: 'false',
    };
    process.stderr.write(
      `[fallback] Submitting admin event create AJAX: keyword=${eventCreateForm.keyword}, ` +
      `start=${eventCreateForm.eventStartDate}, closing=${eventCreateForm.eventClosingDate}, ` +
      `onCall=${eventCreateForm.eventOnCallDate}, timezone=${eventCreateForm.timeZone}, ` +
      `contact=${eventCreateForm.email}, phone=${eventCreateForm.phone}\n`
    );
    const createEventResponse = await page.request.post(`${payload.baseUrl}/ajax/admin/organization/events.php`, {
      form: eventCreateForm,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    let result = await parseApiResponseBody(createEventResponse);

    if (typeof result === 'string') {
      const responseText = result.trim();
      const failureMessage =
        `AJAX event creation returned non-JSON response ` +
        `(HTTP ${createEventResponse.status()}, ${createEventResponse.url()}): ` +
        `${responseText ? responseText.slice(0, 1000) : '(empty response)'}`;
      result = await recoverCreatedEventFromFailedAdminResponse(page, payload, failureMessage);
      if (!result) {
        try {
          result = await createEventViaAdminWizard(page, payload, failureMessage);
        } catch (wizardError) {
          throw new Error(await describeFailedEventCreation(page, payload, `${failureMessage} Wizard fallback also failed: ${wizardError.message}`));
        }
      }
    }

    if (!createEventResponse.ok()) {
      const failureMessage = `AJAX event creation failed with HTTP ${createEventResponse.status()}: ${JSON.stringify(result)}`;
      const recovered = await recoverCreatedEventFromFailedAdminResponse(page, payload, failureMessage);
      if (!recovered) {
        try {
          result = await createEventViaAdminWizard(page, payload, failureMessage);
        } catch (wizardError) {
          throw new Error(await describeFailedEventCreation(page, payload, `${failureMessage} Wizard fallback also failed: ${wizardError.message}`));
        }
      } else {
        result = recovered;
      }
    }

    if (!result.success) {
      const rawMessage = result.message || JSON.stringify(result);
      if (/keyword/i.test(rawMessage) && /already/i.test(rawMessage)) {
        throw new Error(
          `Event keyword "${payload.event.slug}" is already in use on ClickBid. ` +
          `Change the Event keyword in the Event Details section and try again.`
        );
      }
      throw new Error(`AJAX event creation failed: ${rawMessage}`);
    }

    const eventId = String(result.id ?? result.data?.id);
    const eventSlug = result.slug ?? result.data?.slug ?? payload.event.slug;

    if (!eventId) {
      throw new Error(
        `AJAX event creation returned success but no event ID. Response: ${JSON.stringify(result)}`
      );
    }

    let auctionSettingsResult = null;
    if (payload.auctionSettings && payload.auctionSettings.enabled !== false) {
      auctionSettingsResult = await applyAuctionSettings(page, payload.baseUrl, eventId, payload.auctionSettings);
    }

    let ticketPagesResult = null;
    if (payload.ticketPages && payload.ticketPages.enabled) {
      ticketPagesResult = await applyTicketPages(page, payload.baseUrl, eventId, eventSlug, payload.ticketPages);
    }
    return {
      ok: true,
      eventId,
      eventSlug,
      eventName: payload.event.name,
      adminUrl: `${payload.baseUrl}/events/${eventSlug}`,
      publicUrl: ticketPagesResult?.publicUrl || ticketPagePublicUrl(payload.baseUrl, eventSlug),
      auctionSettings: auctionSettingsResult,
      ticketPages: ticketPagesResult,
    };
  } catch (err) {
    // Screenshot on failure for diagnostics
    const pathMod = require('path');
    const logDir = process.env.MKEVENT_LOG_DIR || pathMod.join(require('os').tmpdir(), 'mkEvent-logs');
    try {
      const fs = require('fs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = pathMod.join(logDir, `fallback-failure-${ts}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      process.stderr.write(`\n[Screenshot saved: ${screenshotPath}]\n`);
    } catch (_) {
      // best-effort — don't mask the original error
    }
    throw err;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function applyStandalonePostCreateActivity(payload) {
  const playwright = requirePlaywright();
  const browserType = playwright[payload.browser || 'chromium'];
  if (!browserType?.launch) {
    throw new Error(`Unsupported Playwright browser: ${payload.browser}`);
  }

  const browser = await browserType.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  const page = await browser.newPage();

  try {
    await loginToAdminSession(page, payload);
    await ensureSessionEventContext(page, payload);
    await switchToEvent(page, payload.baseUrl, payload.eventId);
    const result = await applyPostCreateActivity(
      page,
      payload.baseUrl,
      payload.eventSlug,
      payload.postCreateActivity,
      payload.ticketPages,
      payload.bidders,
      payload.items,
    );
    return {
      ok: true,
      eventId: String(payload.eventId),
      eventSlug: payload.eventSlug,
      postCreateActivity: result,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const result = payload.action === 'post-item-config'
    ? await applyPostItemConfig(payload)
    : payload.action === 'post-create-activity'
      ? await applyStandalonePostCreateActivity(payload)
      : await createEventViaAdmin(payload);
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write((error && error.stack) ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  applyAuctionSettings,
  applyPostItemConfig,
  applyStandalonePostCreateActivity,
  applyQuantityItemTier,
  assignExistingMerchantAccount,
  buildAuctionActivityPools,
  buildCheckoutPerson,
  buildTicketPurchaseRequestData,
  buildTicketPurchaseSeedData,
  buildTicketPurchaseExecutionPlan,
  buildTicketPageItemAttachmentPlans,
  createBidderSessionCache,
  createTemporaryCheckoutPage,
  gotoResolvedPublicTicketPage,
  chooseBidderForAuctionItem,
  filterPostCreateAuctionItems,
  filterPostCreateDonationItems,
  resolveTicketPurchasePaymentSupport,
  navigateTicketPurchaseSection,
  shouldUseBrowserCheckout,
  assignDonationFlags,
  withRetry,
  ticketPurchaseConcurrencyForPlan,
  API_TICKET_PURCHASE_CONCURRENCY,
  CREDIT_CARD_TICKET_PURCHASE_CONCURRENCY,
  createEventViaAdmin,
  ensureSessionEventContext,
  fetchCsrfTokenFromButler,
  findOrganizationEventBySlug,
  readOrganizationEventsSummary,
  loginToAdminSession,
  main,
  readStdin,
  setInputValue,
  setSelectValue,
  syncTicketPageItems,
  switchToEvent,
  waitForLoginOutcome,
  requirePlaywright,
  resolvePlaywrightCandidate,
  buildTicketPagePlans,
  resolvePostCreatePurchaseTarget,
  resolvePostCreatePurchaseTargetForOrdinal,
  resolveSelectionSelectable,
};
