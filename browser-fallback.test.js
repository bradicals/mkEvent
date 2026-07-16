const assert = require('node:assert/strict');
const test = require('node:test');
const fallback = require('./browser-fallback.cjs');

test('resolvePlaywrightCandidate loads the local playwright package', () => {
  const mod = fallback.resolvePlaywrightCandidate('playwright');
  assert.ok(mod);
  assert.equal(typeof mod.chromium.launch, 'function');
});

test('requirePlaywright resolves mkEvent-local Playwright by default', () => {
  const original = process.env.MKEVENT_PLAYWRIGHT_MODULE;
  delete process.env.MKEVENT_PLAYWRIGHT_MODULE;

  try {
    const mod = fallback.requirePlaywright();
    assert.ok(mod);
    assert.equal(typeof mod.chromium.launch, 'function');
  } finally {
    if (original === undefined) delete process.env.MKEVENT_PLAYWRIGHT_MODULE;
    else process.env.MKEVENT_PLAYWRIGHT_MODULE = original;
  }
});

test('requirePlaywright accepts an explicit module override', () => {
  const original = process.env.MKEVENT_PLAYWRIGHT_MODULE;
  process.env.MKEVENT_PLAYWRIGHT_MODULE = 'playwright';

  try {
    const mod = fallback.requirePlaywright();
    assert.ok(mod);
    assert.equal(typeof mod.chromium.launch, 'function');
  } finally {
    if (original === undefined) delete process.env.MKEVENT_PLAYWRIGHT_MODULE;
    else process.env.MKEVENT_PLAYWRIGHT_MODULE = original;
  }
});

test('assignExistingMerchantAccount assigns existing Stripe account via direct AJAX', async () => {
  const actions = [];
  const fakePage = {
    evaluate: async (_fn, action) => {
      actions.push(action);
      if (action === 'check_existing_account') {
        return { status: 200, body: { success: true, alreadyExists: true, id: 123, ein: '12-3456789', countryId: 1 } };
      }
      if (action === 'assign_existing_account') {
        return { status: 200, body: { success: true, message: 'Account has been updated' } };
      }
      throw new Error(`Unexpected action ${action}`);
    },
  };

  const result = await fallback.assignExistingMerchantAccount(fakePage);

  assert.deepEqual(actions, ['check_existing_account', 'assign_existing_account']);
  assert.equal(result.applied, true);
  assert.equal(result.action, 'assign_existing_account');
});

test('assignExistingMerchantAccount skips when no existing Stripe account is found', async () => {
  const actions = [];
  const fakePage = {
    evaluate: async (_fn, action) => {
      actions.push(action);
      return { status: 200, body: { success: true, alreadyExists: false, id: 123, ein: '12-3456789', countryId: 1 } };
    },
  };

  const result = await fallback.assignExistingMerchantAccount(fakePage);

  assert.deepEqual(actions, ['check_existing_account']);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no existing Stripe account found for this EIN');
});

test('buildTicketPagePlans preserves first default form and resolves duplicate names', () => {
  const plans = fallback.buildTicketPagePlans({
    enabled: true,
    pages: [
      { formName: 'tix' },
      { formName: 'tix' },
      { formName: 'custom-form' },
      { formName: '' },
    ],
  });

  assert.equal(plans.length, 4);
  assert.equal(plans[0].targetFormName, 'tix');
  assert.equal(plans[0].initialFormName, null);
  assert.equal(plans[1].targetFormName, 'tix_2');
  assert.equal(plans[2].targetFormName, 'custom-form');
  assert.equal(plans[3].targetFormName, 'tix_4');
});

test('resolveSelectionSelectable targets the requested ticket or sponsor and falls back to All', () => {
  const createdTargets = {
    individual: [{ id: '11', name: 'General Admission' }],
    sponsor: [{ id: '22', name: 'Gold Sponsor' }],
  };

  const all = fallback.resolveSelectionSelectable({ showOnType: 'ticket-form', showOnIndex: 0 }, createdTargets, '99');
  assert.deepEqual(all, { id: '99', type: 'ticket-form', label: 'All', warning: null });

  const individual = fallback.resolveSelectionSelectable({ showOnType: 'individual-ticket', showOnIndex: 0 }, createdTargets, '99');
  assert.deepEqual(individual, { id: '11', type: 'individual-ticket', label: 'General Admission (Individual)', warning: null });

  const sponsor = fallback.resolveSelectionSelectable({ showOnType: 'sponsor-ticket', showOnIndex: 0 }, createdTargets, '99');
  assert.deepEqual(sponsor, { id: '22', type: 'sponsor-ticket', label: 'Gold Sponsor (Sponsor)', warning: null });

  const fallbackAll = fallback.resolveSelectionSelectable({ showOnType: 'individual-ticket', showOnIndex: 9 }, createdTargets, '99');
  assert.equal(fallbackAll.id, '99');
  assert.equal(fallbackAll.type, 'ticket-form');
  assert.equal(fallbackAll.label, 'All');
  assert.match(fallbackAll.warning, /falling back to all/i);
});

test('resolvePostCreatePurchaseTarget selects the configured ticket page and purchase target', () => {
  const resolved = fallback.resolvePostCreatePurchaseTarget({
    enabled: true,
    ticketPurchases: {
      pageIndex: 0,
      targetType: 'sponsor-ticket',
      targetIndex: 0,
    },
  }, {
    enabled: true,
    pages: [{
      formName: 'vip',
      individualTickets: [{ name: 'General Admission', ticketsPerPurchase: 2 }],
      sponsors: [{ title: 'Gold Sponsor', ticketsPerPurchase: 8 }],
    }],
  });

  assert.equal(resolved.formName, 'vip');
  assert.equal(resolved.targetType, 'sponsor-ticket');
  assert.equal(resolved.targetLabel, 'Gold Sponsor');
  assert.equal(resolved.guestsPerUnit, 8);
  assert.equal(resolved.warning, null);
});

test('resolvePostCreatePurchaseTarget returns a warning when the requested target does not exist', () => {
  const resolved = fallback.resolvePostCreatePurchaseTarget({
    enabled: true,
    ticketPurchases: {
      pageIndex: 0,
      targetType: 'sponsor-ticket',
      targetIndex: 0,
    },
  }, {
    enabled: true,
    pages: [{
      formName: 'tix',
      individualTickets: [{ name: 'General Admission', ticketsPerPurchase: 2 }],
      sponsors: [],
    }],
  });

  assert.equal(resolved.formName, 'tix');
  assert.equal(resolved.targetConfig, null);
  assert.match(resolved.warning, /no sponsor levels/i);
});

test('resolvePostCreatePurchaseTarget returns mixed candidates when target mode is mixed', () => {
  const resolved = fallback.resolvePostCreatePurchaseTarget({
    enabled: true,
    ticketPurchases: {
      pageIndex: 0,
      targetMode: 'mixed',
    },
  }, {
    enabled: true,
    pages: [{
      formName: 'vip',
      individualTickets: [{ name: 'General Admission', ticketsPerPurchase: 2 }],
      sponsors: [{ title: 'Gold Sponsor', ticketsPerPurchase: 8 }],
    }],
  });

  assert.equal(resolved.targetMode, 'mixed');
  assert.equal(resolved.candidates.length, 2);
  assert.equal(resolved.candidates[0].targetType, 'individual-ticket');
  assert.equal(resolved.candidates[1].targetType, 'sponsor-ticket');
});

test('resolvePostCreatePurchaseTargetForOrdinal rotates mixed targets by purchase index', () => {
  const resolved = fallback.resolvePostCreatePurchaseTarget({
    enabled: true,
    ticketPurchases: {
      pageIndex: 0,
      targetMode: 'mixed',
    },
  }, {
    enabled: true,
    pages: [{
      formName: 'vip',
      individualTickets: [{ name: 'General Admission', ticketsPerPurchase: 2 }],
      sponsors: [{ title: 'Gold Sponsor', ticketsPerPurchase: 8 }],
    }],
  });

  const first = fallback.resolvePostCreatePurchaseTargetForOrdinal(resolved, 0);
  const second = fallback.resolvePostCreatePurchaseTargetForOrdinal(resolved, 1);
  const third = fallback.resolvePostCreatePurchaseTargetForOrdinal(resolved, 2);

  assert.equal(first.targetType, 'individual-ticket');
  assert.equal(second.targetType, 'sponsor-ticket');
  assert.equal(third.targetType, 'individual-ticket');
});

test('buildTicketPurchaseExecutionPlan expands the configured payment mix in deterministic order', () => {
  assert.deepEqual(
    fallback.buildTicketPurchaseExecutionPlan({
      paymentMix: {
        check: 2,
        cash: 1,
        invoice: 1,
        credit_card: 2,
      },
    }),
    ['check', 'check', 'cash', 'invoice', 'credit_card', 'credit_card'],
  );
});

test('createTemporaryCheckoutPage creates an isolated browser context', async () => {
  const calls = [];
  const fakeCheckoutContext = {
    newPage: async () => {
      calls.push('newPage');
      return { id: 'checkout-page' };
    },
    close: async () => {
      calls.push('closeContext');
    },
  };
  const fakeBrowser = {
    newContext: async (options) => {
      calls.push(['newContext', options]);
      return fakeCheckoutContext;
    },
  };
  const fakeReferencePage = {
    context: () => ({
      browser: () => fakeBrowser,
      newPage: async () => {
        throw new Error('should not use existing context newPage');
      },
    }),
  };

  const checkout = await fallback.createTemporaryCheckoutPage(fakeReferencePage);

  assert.deepEqual(checkout.page, { id: 'checkout-page' });
  assert.deepEqual(calls[0], ['newContext', { ignoreHTTPSErrors: true }]);
  assert.equal(calls[1], 'newPage');
  await checkout.close();
  assert.equal(calls[2], 'closeContext');
});

test('createBidderSessionCache reuses sessions and closes them once', async () => {
  const calls = [];
  const cache = fallback.createBidderSessionCache(async (bidderId) => {
    calls.push(['auth', bidderId]);
    return {
      bidderPage: { bidderId },
      bidderContext: {
        close: async () => calls.push(['close', bidderId]),
      },
    };
  });

  const first = await cache.get(10);
  const second = await cache.get('10');
  const third = await cache.get(11);

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.deepEqual(calls, [['auth', 10], ['auth', 11]]);

  await cache.closeAll();
  assert.deepEqual(calls, [['auth', 10], ['auth', 11], ['close', 10], ['close', 11]]);
});

test('createBidderSessionCache retries after failed authentication', async () => {
  let attempts = 0;
  const cache = fallback.createBidderSessionCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary auth failure');
    return {
      bidderPage: { ok: true },
      bidderContext: { close: async () => undefined },
    };
  });

  await assert.rejects(() => cache.get(12), /temporary auth failure/);
  const session = await cache.get(12);

  assert.deepEqual(session.bidderPage, { ok: true });
  assert.equal(attempts, 2);
  await cache.closeAll();
});

test('gotoResolvedPublicTicketPage navigates directly without admin discovery', async () => {
  const calls = [];
  const fakePage = {
    goto: async (url, options) => {
      calls.push(['goto', url, options]);
    },
    waitForLoadState: async (state, options) => {
      calls.push(['waitForLoadState', state, options]);
    },
    url: () => 'https://event.cbo.bid',
    getByRole: () => ({
      isVisible: async () => false,
    }),
  };

  await fallback.gotoResolvedPublicTicketPage(fakePage, 'https://event.cbo.bid');

  assert.deepEqual(calls[0], ['goto', 'https://event.cbo.bid', { waitUntil: 'load' }]);
  assert.equal(calls[1][0], 'waitForLoadState');
  assert.equal(calls[1][1], 'networkidle');
});

test('findOrganizationEventBySlug recovers event id from org event cards', async () => {
  const calls = [];
  const fakePage = {
    goto: async (url, options) => {
      calls.push(['goto', url, options]);
    },
    waitForLoadState: async (state, options) => {
      calls.push(['waitForLoadState', state, options]);
    },
    evaluate: async (_fn, slug) => {
      calls.push(['evaluate', slug]);
      return { id: '4575', slug, name: 'Recovered Event' };
    },
  };

  const found = await fallback.findOrganizationEventBySlug(
    fakePage,
    'https://cbotriage.bid',
    '2518',
    'CrystalBanquetPackaging',
  );

  assert.deepEqual(found, {
    id: '4575',
    slug: 'crystalbanquetpackaging',
    name: 'Recovered Event',
  });
  assert.equal(calls[0][0], 'goto');
  assert.equal(calls[0][1], 'https://cbotriage.bid/app/public/organizations/2518/events?status=all&sort_by=keyword');
});

test('readOrganizationEventsSummary returns visible org event count and keywords', async () => {
  const fakePage = {
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
    evaluate: async () => ({
      headingText: 'All Events - 10',
      visibleCount: 10,
      cardCount: 10,
      keywords: ['biscuits', 'bodabeedabop'],
    }),
  };

  const summary = await fallback.readOrganizationEventsSummary(fakePage, 'https://cbotriage.bid', '2518');

  assert.equal(summary.headingText, 'All Events - 10');
  assert.equal(summary.visibleCount, 10);
  assert.deepEqual(summary.keywords, ['biscuits', 'bodabeedabop']);
});

test('resolveTicketPurchasePaymentSupport reflects selected ticket page settings', () => {
  assert.deepEqual(
    fallback.resolveTicketPurchasePaymentSupport({
      settings: {
        creditCard: true,
        sendInvoice: false,
        cash: false,
        check: true,
      },
    }),
    {
      check: true,
      cash: false,
      invoice: false,
      credit_card: true,
    },
  );
});

test('buildCheckoutPerson produces distinct full names across early generated guests', () => {
  const seen = new Set();
  for (let index = 0; index < 30; index += 1) {
    const person = fallback.buildCheckoutPerson(index);
    const fullName = `${person.firstName} ${person.lastName}`;
    assert.equal(seen.has(fullName), false);
    assert.match(person.phone, /^555\d{7}$/);
    seen.add(fullName);
  }
});

test('buildTicketPurchaseSeedData derives purchaser and guest counts from the selected target', () => {
  const seeded = fallback.buildTicketPurchaseSeedData(
    { ticketPurchases: { quantity: 2 } },
    { targetIndex: 1, targetType: 'individual-ticket', targetConfig: { ticketsPerPurchase: 3 } },
    4,
  );

  assert.equal(seeded.purchaseType, 'individual');
  assert.equal(seeded.unitCount, 2);
  assert.equal(seeded.expectedGuests, 6);
  assert.equal(seeded.guestSeeds.length, 6);
  assert.equal(typeof seeded.purchaser.firstName, 'string');
  assert.deepEqual(seeded.guestSeeds[0], seeded.purchaser);
  assert.notEqual(
    `${seeded.guestSeeds[1].firstName} ${seeded.guestSeeds[1].lastName}`,
    `${seeded.purchaser.firstName} ${seeded.purchaser.lastName}`,
  );
});

test('buildTicketPurchaseRequestData preserves scraped dataset and computed guests', () => {
  const requestData = fallback.buildTicketPurchaseRequestData(
    {
      purchaseType: 'individual',
      dataset: { id: '55', type: 'individual', price: '125.00', name: 'General Admission' },
      questions: [{ questionId: '9', answer: 'Chicken' }],
    },
    {
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.com',
      phone: '5551234567',
      address: '123 Main St',
      city: 'Miami',
      state: 'Florida',
      postalCode: '33101',
    },
    [{
      firstName: 'Guest',
      lastName: 'One',
      email: 'guest1@example.com',
      phone: '5550000001',
    }],
    2,
    2,
  );

  assert.equal(requestData.paymentMethod, 2);
  assert.equal(requestData.total, 250);
  assert.equal(requestData.purchases[0].current, '2');
  assert.deepEqual(requestData.purchases[0].questions, [{ questionId: '9', answer: 'Chicken' }]);
  assert.equal(requestData.guests.length, 1);
  assert.equal(requestData.guests[0].ticketId, '55');
});

test('filterPostCreateAuctionItems respects the configured item type toggles', () => {
  const items = [
    { id: '1', item_type_id: 10, item_name: 'Silent Item' },
    { id: '2', item_type_id: 20, item_name: 'Live Item' },
    { id: '3', item_type_id: 30, item_name: 'Donation Item' },
  ];

  assert.deepEqual(
    fallback.filterPostCreateAuctionItems(items, { includeSilent: true, includeLive: false }).map((item) => item.id),
    ['1'],
  );
  assert.deepEqual(
    fallback.filterPostCreateAuctionItems(items, { includeSilent: false, includeLive: true }).map((item) => item.id),
    ['2'],
  );
  assert.deepEqual(
    fallback.filterPostCreateAuctionItems(items, { includeSilent: true, includeLive: true }).map((item) => item.id),
    ['1', '2'],
  );
});

test('filterPostCreateDonationItems returns only donation items', () => {
  const items = [
    { id: '1', item_type_id: 10, item_name: 'Silent Item' },
    { id: '2', item_type_id: 30, item_name: 'Fund-a-need' },
    { id: '3', item_type_id: 40, item_name: 'Drink Tickets' },
  ];

  assert.deepEqual(
    fallback.filterPostCreateDonationItems(items).map((item) => item.id),
    ['2'],
  );
});

test('buildAuctionActivityPools intentionally narrows large bidder/item pools', () => {
  const bidders = Array.from({ length: 56 }, (_, index) => ({ id: String(index + 1) }));
  const items = Array.from({ length: 34 }, (_, index) => ({ id: String(index + 1) }));

  const pools = fallback.buildAuctionActivityPools(bidders, items, 12);

  assert.equal(pools.activeBidders.length, 6);
  assert.equal(pools.hotItems.length, 4);
});

test('chooseBidderForAuctionItem prefers a bidder who has not already bid that item', () => {
  const bidders = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const history = new Map([['99', new Set(['1', '2'])]]);
  const lastBidderByItem = new Map([['99', '2']]);

  const bidder = fallback.chooseBidderForAuctionItem(bidders, '99', history, lastBidderByItem);
  assert.equal(bidder.id, '3');
});

test('buildTicketPageItemAttachmentPlans resolves quantity and donation item indexes', () => {
  const plans = fallback.buildTicketPageItemAttachmentPlans({
    enabled: true,
    pages: [
      { formName: 'tix', quantityItemBulkIndexes: [0], quantityItemExactIndexes: [0, 2], donationItemBulkIndexes: [1], donationItemExactIndexes: [0] },
      { formName: 'vip', quantityItemExactIndexes: [1], donationItemExactIndexes: [1] },
    ],
  }, [
    { bulkIndex: 0, id: '100', item_name: 'Bulk Drink Tickets' },
    { exactIndex: 0, id: '101', item_name: 'Drink Tickets' },
    { exactIndex: 1, id: '102', item_name: 'Raffle Bundle' },
  ], [
    { bulkIndex: 1, id: '200', item_name: 'Bulk Mission Fund' },
    { exactIndex: 0, id: '201', item_name: 'Exact Mission Fund' },
  ]);

  assert.equal(plans.length, 2);
  assert.equal(plans[0].formName, 'tix');
  assert.deepEqual(plans[0].resolvedItems.map((item) => item.id), ['100', '101', '200', '201']);
  assert.deepEqual(plans[0].missingQuantityBulkIndexes, []);
  assert.deepEqual(plans[0].missingQuantityExactIndexes, [2]);
  assert.deepEqual(plans[0].missingDonationBulkIndexes, []);
  assert.deepEqual(plans[0].missingDonationExactIndexes, []);
  assert.equal(plans[1].formName, 'vip');
  assert.deepEqual(plans[1].resolvedItems.map((item) => item.id), ['102']);
  assert.deepEqual(plans[1].missingQuantityBulkIndexes, []);
  assert.deepEqual(plans[1].missingQuantityExactIndexes, []);
  assert.deepEqual(plans[1].missingDonationBulkIndexes, []);
  assert.deepEqual(plans[1].missingDonationExactIndexes, [1]);
});

// ── navigateTicketPurchaseSection: navigate by stable data-target ──────────
// Regression: the donation step's visible label is event-customizable (e.g.
// "Make a donation"), so matching the literal label "donation" failed and
// donations were never seeded. We must navigate by the stable data-target attr.
function makeNavFakePage(presentTargets) {
  const clicks = [];
  const locatorFor = (selector) => {
    const match = selector.match(/data-target="([^"]+)"/);
    const target = match ? match[1] : null;
    const present = Boolean(target) && presentTargets.includes(target);
    const self = {
      count: async () => (present ? 1 : 0),
      first() { return self; },
      nth() { return self; },
      click: async () => { clicks.push(selector); },
    };
    return self;
  };
  return {
    clicks,
    locator: (selector) => locatorFor(selector),
    // No accessible-name match available (simulates a renamed label).
    getByRole: () => ({ count: async () => 0, first() { return this; }, click: async () => {} }),
  };
}

test('navigateTicketPurchaseSection navigates by data-target even when the label is renamed', async () => {
  const page = makeNavFakePage(['donation']);
  const ok = await fallback.navigateTicketPurchaseSection(page, 'donation');
  assert.equal(ok, true);
  assert.ok(
    page.clicks.some((selector) => selector.includes('data-target="donation"')),
    'should click an element selected by its data-target attribute',
  );
});

test('navigateTicketPurchaseSection returns false when target is absent and no label matches', async () => {
  const page = makeNavFakePage([]);
  const ok = await fallback.navigateTicketPurchaseSection(page, 'donation');
  assert.equal(ok, false);
});

// ── shouldUseBrowserCheckout: donation purchases must use the browser path ──
test('shouldUseBrowserCheckout routes only credit-card purchases through the browser checkout', () => {
  // Donations ride exclusively on credit-card purchases, so routing is purely by
  // payment method: credit_card -> browser/Stripe, everything else -> fast API.
  assert.equal(fallback.shouldUseBrowserCheckout('credit_card'), true);
  assert.equal(fallback.shouldUseBrowserCheckout('check'), false);
  assert.equal(fallback.shouldUseBrowserCheckout('cash'), false);
  assert.equal(fallback.shouldUseBrowserCheckout('invoice'), false);
});

// ── withRetry: bounded retry for flaky checkout steps ───────────────────────
test('withRetry returns on first success without retrying', async () => {
  let calls = 0;
  const result = await fallback.withRetry(async () => { calls += 1; return 'ok'; }, { attempts: 3 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries a failing call up to the attempt limit then succeeds', async () => {
  let calls = 0;
  const retries = [];
  const result = await fallback.withRetry(
    async () => { calls += 1; if (calls < 3) throw new Error(`boom ${calls}`); return 'recovered'; },
    { attempts: 3, onRetry: (err, attempt) => retries.push(attempt) },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3); // 1 initial + 2 retries
  assert.deepEqual(retries, [1, 2]);
});

test('withRetry throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => fallback.withRetry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { attempts: 3 }),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('withRetry respects shouldRetry to avoid retrying non-transient failures', async () => {
  let calls = 0;
  await assert.rejects(
    () => fallback.withRetry(
      async () => { calls += 1; throw new Error('permanent'); },
      { attempts: 3, shouldRetry: () => false },
    ),
    /permanent/,
  );
  assert.equal(calls, 1); // never retried
});

// ── assignDonationFlags: only the first N credit-card purchases donate ──────
test('assignDonationFlags marks the first N credit-card purchases as donating', () => {
  const plan = ['check', 'credit_card', 'cash', 'credit_card', 'credit_card', 'invoice'];
  // donationPurchaseCount = 2 -> first 2 credit_card entries donate, others never
  const flags = fallback.assignDonationFlags(plan, 2);
  assert.deepEqual(flags, [false, true, false, true, false, false]);
});

test('assignDonationFlags never marks non-credit-card purchases', () => {
  const plan = ['check', 'cash', 'invoice'];
  const flags = fallback.assignDonationFlags(plan, 3);
  assert.deepEqual(flags, [false, false, false]);
});

test('assignDonationFlags with 0 donates nothing; with large N caps at credit-card count', () => {
  const plan = ['credit_card', 'credit_card'];
  assert.deepEqual(fallback.assignDonationFlags(plan, 0), [false, false]);
  assert.deepEqual(fallback.assignDonationFlags(plan, 99), [true, true]);
});

// ── ticketPurchaseConcurrencyForPlan: browser plans use browser concurrency ──
test('ticketPurchaseConcurrencyForPlan uses browser concurrency for credit-card/donation plans', () => {
  const api = fallback.API_TICKET_PURCHASE_CONCURRENCY;
  const browser = fallback.CREDIT_CARD_TICKET_PURCHASE_CONCURRENCY;
  assert.equal(typeof browser, 'number');
  // a plan containing any credit-card purchase runs the browser/Stripe checkout
  assert.equal(fallback.ticketPurchaseConcurrencyForPlan(['credit_card', 'check']), browser);
  // a plan with no credit-card purchases uses the fast API concurrency
  assert.equal(fallback.ticketPurchaseConcurrencyForPlan(['check', 'cash', 'invoice']), api);
});

test('seedCustomPaymentTypes posts each name in-page and records applied/warnings', async () => {
  const calls = [];
  const page = {
    evaluate: async (_fn, arg) => {
      calls.push(arg);
      if (arg.typeName === 'xy') {
        return { status: 422, body: { message: 'The name field must be at least 3 characters.' } };
      }
      return { status: 200, body: { success: true, custom_payment_type: { id: calls.length, name: arg.typeName } } };
    },
  };

  const result = await fallback.seedCustomPaymentTypes(page, 'my-event', ['Venmo', 'xy', 'Zelle']);

  assert.deepEqual(calls.map((c) => c.slug), ['my-event', 'my-event', 'my-event']);
  assert.equal(result.applied.length, 2);
  assert.equal(result.applied[0].name, 'Venmo');
  assert.equal(result.applied[0].id, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /at least 3 characters/);
});

test('buildButlerCheckoutPlan expands per-type counts and warns on unknown types', () => {
  const typeIds = new Map([
    ['venmo', { id: '281', name: 'Venmo' }],
    ['zelle', { id: '282', name: 'Zelle' }],
  ]);
  const { plan, warnings } = fallback.buildButlerCheckoutPlan({ Venmo: 2, Zelle: 1, Missing: 3 }, typeIds);

  assert.deepEqual(plan, [
    { typeName: 'Venmo', typeId: '281' },
    { typeName: 'Venmo', typeId: '281' },
    { typeName: 'Zelle', typeId: '282' },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Missing/);
});

test('buildButlerCheckoutPlan rejects non-finite counts and caps expansion at maxTotal', () => {
  const typeIds = new Map([
    ['venmo', { id: '281', name: 'Venmo' }],
    ['zelle', { id: '282', name: 'Zelle' }],
  ]);

  const infinite = fallback.buildButlerCheckoutPlan({ Venmo: Infinity, Zelle: 'Infinity' }, typeIds, 10);
  assert.deepEqual(infinite.plan, []);
  assert.equal(infinite.warnings.length, 2);
  assert.match(infinite.warnings[0].message, /not a usable count/);

  const oversized = fallback.buildButlerCheckoutPlan({ Venmo: 1e9, Zelle: 2 }, typeIds, 5);
  assert.equal(oversized.plan.length, 5);
  assert.ok(oversized.warnings.some((w) => /capped/.test(w.message)));
});

test('buildButlerCheckoutPostData computes totals from rows and JSON-stringifies them', () => {
  const scraped = {
    rows: [
      { itemId: '644788', bidId: '1990465', taxable: '1', taxRate: '7', taxAmount: 1.75, typeId: 40, fmv: '0', quantityCount: '3', quantityPurchased: '1', subTotal: 25 },
      { itemId: '644789', bidId: '1990466,1990467', taxable: '0', taxRate: '0', taxAmount: 0, typeId: 30, fmv: '0', quantityCount: 0, quantityPurchased: '', subTotal: 40 },
    ],
    firstName: 'QA', lastName: 'Automation',
    address: '', address2: '', city: '', state: '', zip: '',
    fmvAmount: 0, bidAmount: 25, donationAmount: 40,
  };

  const postData = fallback.buildButlerCheckoutPostData({
    csrfToken: 'tok123', bidderId: 3398207, scraped, customPaymentTypeId: '281',
  });

  assert.equal(postData.action, 'checkout');
  assert.equal(postData.csrf, 'tok123');
  assert.equal(postData.bidderId, '3398207');
  assert.equal(postData.payTypeId, '99');
  assert.equal(postData.checkOutMethodId, '4');
  assert.equal(postData.checkNumber, '');
  assert.equal(postData.taxAmount, '1.75');
  assert.equal(postData.totalAmount, '66.75'); // 25 + 1.75 + 40
  assert.equal(postData.customPaymentTypeId, '281');
  assert.equal(typeof postData.rows, 'string');
  assert.equal(JSON.parse(postData.rows).length, 2);

  const noType = fallback.buildButlerCheckoutPostData({ csrfToken: 't', bidderId: 1, scraped });
  assert.equal('customPaymentTypeId' in noType, false);
});
