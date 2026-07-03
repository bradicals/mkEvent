const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('./event-model.js');

function todayDateOnly() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

test('slugifyForClickBid produces a valid slug with at least one letter and max 50 chars', () => {
  assert.equal(model.slugifyForClickBid('QA Silent Auction Bug Repro 2026!!'), 'qasilentauctionbugrepro2026');
  assert.equal(model.slugifyForClickBid('123'), 'event123');
  assert.equal(model.slugifyForClickBid('A'.repeat(80)).length, 50);
});

test('buildPublicEventUrl uses the event slug as the subdomain', () => {
  assert.equal(model.buildPublicEventUrl('https://cbo.bid', 'velvetsymphony'), 'https://velvetsymphony.cbo.bid');
  assert.equal(model.buildPublicEventUrl('https://cbotriage.bid', 'velvetsymphony'), 'https://velvetsymphony.cbotriage.bid');
  assert.equal(model.buildPublicEventUrl('https://cbo.bid', 'velvetsymphony', 'vip'), 'https://velvetsymphony.cbo.bid/vip');
});

test('randomEventName produces varied event-like names', () => {
  const originalRandom = Math.random;
  let seed = 0;
  Math.random = () => {
    seed = (seed * 9301 + 49297 + 1) % 233280;
    return seed / 233280;
  };
  const seen = new Set();
  try {
    for (let index = 0; index < 50; index += 1) {
      const name = model.randomEventName();
      assert.match(name, /^[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){1,2}$/);
      seen.add(name);
    }
  } finally {
    Math.random = originalRandom;
  }
  assert.ok(seen.size >= 35, `expected at least 35 unique names, got ${seen.size}`);
});

test('buildRecipe/exportRecipeConfig clamp stale event dates to ClickBid create constraints', () => {
  const today = todayDateOnly();
  const config = {
    ...model.DEFAULT_CONFIG,
    basics: {
      ...model.DEFAULT_CONFIG.basics,
      name: 'Stale Date',
      slug: 'staledate',
      startDate: '2000-01-01',
      endDate: '2000-01-02',
      onCallDate: '2000-01-02',
    },
  };

  const recipe = model.buildRecipe(config);
  assert.equal(recipe.event.startDate, today);
  assert.equal(recipe.event.endDate, today);
  assert.equal(recipe.event.onCallDate, today);

  const exported = model.exportRecipeConfig(config);
  assert.equal(exported.event.startDate, today);
  assert.equal(exported.event.endDate, today);
  assert.equal(exported.event.onCallDate, today);
});

test('importRecipeConfig updates stale imported dates to visible safe values', () => {
  const today = todayDateOnly();
  const imported = model.importRecipeConfig(model.DEFAULT_CONFIG, {
    environment: { id: 'stage' },
    event: {
      name: 'Old Recipe',
      slug: 'oldrecipe',
      startDate: '2000-01-01',
      endDate: '2000-01-02',
      onCallDate: '2000-01-02',
    },
  });

  assert.equal(imported.basics.startDate, today);
  assert.equal(imported.basics.endDate, today);
  assert.equal(imported.basics.onCallDate, today);
});

test('preset export/import reuses recipe structure but preserves current event identity fields', () => {
  // Relative dates: importPresetConfig clamps the preserved schedule to today
  // (normalizeEventSchedule), so hardcoded dates break once the calendar
  // passes them.
  const daysOut = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const currentStart = daysOut(30);
  const currentEnd = daysOut(31);
  const base = {
    ...model.DEFAULT_CONFIG,
    api: {
      ...model.DEFAULT_CONFIG.api,
      ...model.environmentPatch('dev2'),
    },
    basics: {
      ...model.DEFAULT_CONFIG.basics,
      name: 'Current Event Name',
      slug: 'currenteventname',
      startDate: currentStart,
      startTime: '09:00',
      endDate: currentEnd,
      endTime: '17:00',
      onCallDate: currentEnd,
    },
    bidders: {
      ...model.DEFAULT_CONFIG.bidders,
      bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 42 },
    },
    items: {
      ...model.DEFAULT_CONFIG.items,
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 12 },
    },
  };

  const presetSource = {
    ...base,
    basics: {
      ...base.basics,
      name: 'Preset Event Name',
      slug: 'preseteventname',
      startDate: daysOut(60),
      endDate: daysOut(61),
      onCallDate: daysOut(61),
    },
    bidders: {
      ...base.bidders,
      bulk: { ...base.bidders.bulk, count: 7 },
    },
    items: {
      ...base.items,
      bulk: { ...base.items.bulk, silentCount: 3, liveCount: 2 },
    },
  };

  const preset = model.exportPresetConfig(presetSource, 'QA Preset');
  assert.equal(preset.kind, 'mkEventPreset');
  assert.equal(preset.name, 'QA Preset');
  assert.equal(preset.recipe.event.name, 'Preset Event Name');

  const imported = model.importPresetConfig(base, preset);
  assert.equal(imported.basics.name, 'Current Event Name');
  assert.equal(imported.basics.slug, 'currenteventname');
  assert.equal(imported.basics.startDate, currentStart);
  assert.equal(imported.items.bulk.silentCount, 3);
  assert.equal(imported.items.bulk.liveCount, 2);
  assert.equal(imported.bidders.bulk.count, 7);
  assert.equal(imported.api.env, 'dev2');
});

test('normalizePostCreateActivity clamps the selected ticket page and target to configured ticket pages', () => {
  const ticketPages = model.normalizeTicketPages({
    enabled: true,
    preset: 'custom',
    pages: [{
      formName: 'tix',
      displayName: 'Tickets',
      individualTickets: [{ name: 'General Admission', ticketsPerPurchase: 2 }],
      sponsors: [{ title: 'Gold Sponsor', ticketsPerPurchase: 8 }],
      underwriting: [],
      selections: [],
    }],
  });

  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    useFaker: false,
    ticketPurchases: {
      pageIndex: 99,
      targetType: 'sponsor-ticket',
      targetIndex: 4,
      purchaseCount: 3,
      quantity: 2,
      addDonation: true,
      donationAmount: 125,
      paymentMethod: 'credit_card',
    },
  }, ticketPages);

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.useFaker, false);
  assert.equal(normalized.ticketPurchases.pageIndex, 0);
  assert.equal(normalized.ticketPurchases.targetType, 'sponsor-ticket');
  assert.equal(normalized.ticketPurchases.targetIndex, 0);
  assert.equal(normalized.ticketPurchases.purchaseCount, 3);
  assert.equal(normalized.ticketPurchases.quantity, 2);
  assert.equal(normalized.ticketPurchases.addDonation, true);
  assert.equal(normalized.ticketPurchases.donationAmount, 125);
  assert.deepEqual(normalized.ticketPurchases.paymentMix, {
    check: 0,
    cash: 0,
    invoice: 0,
    credit_card: 3,
  });
  assert.equal(normalized.auctionActivity.enabled, false);
  assert.equal(normalized.donationActivity.enabled, false);
});

test('normalizePostCreateActivity defaults donationPurchaseCount to the credit-card count when addDonation is on', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      enabled: true,
      addDonation: true,
      paymentMix: { check: 4, credit_card: 6 },
    },
  }, model.DEFAULT_CONFIG.ticketPages);
  // migration: addDonation on + no explicit count -> all credit-card purchases donate
  assert.equal(normalized.ticketPurchases.donationPurchaseCount, 6);
  assert.equal(normalized.ticketPurchases.addDonation, true);
});

test('normalizePostCreateActivity clamps donationPurchaseCount to the credit-card count', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      enabled: true,
      addDonation: true,
      donationPurchaseCount: 50,
      paymentMix: { check: 4, credit_card: 6 },
    },
  }, model.DEFAULT_CONFIG.ticketPages);
  assert.equal(normalized.ticketPurchases.donationPurchaseCount, 6);
});

test('normalizePostCreateActivity forces donationPurchaseCount to 0 when addDonation is off', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      enabled: true,
      addDonation: false,
      donationPurchaseCount: 5,
      paymentMix: { credit_card: 6 },
    },
  }, model.DEFAULT_CONFIG.ticketPages);
  assert.equal(normalized.ticketPurchases.donationPurchaseCount, 0);
});

test('normalizePostCreateActivity honors an explicit partial donationPurchaseCount', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      enabled: true,
      addDonation: true,
      donationPurchaseCount: 2,
      paymentMix: { credit_card: 6 },
    },
  }, model.DEFAULT_CONFIG.ticketPages);
  assert.equal(normalized.ticketPurchases.donationPurchaseCount, 2);
});

test('normalizePostCreateActivity derives purchase count from mixed payment counts', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      paymentMix: {
        check: 2,
        cash: 1,
        invoice: 3,
        credit_card: 4,
      },
    },
  }, model.DEFAULT_CONFIG.ticketPages);

  assert.equal(normalized.ticketPurchases.purchaseCount, 10);
  assert.deepEqual(normalized.ticketPurchases.paymentMix, {
    check: 2,
    cash: 1,
    invoice: 3,
    credit_card: 4,
  });
});

test('normalizePostCreateActivity preserves mixed ticket target mode', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    ticketPurchases: {
      targetMode: 'mixed',
    },
  }, model.normalizeTicketPages({
    enabled: true,
    pages: [{
      ...model.DEFAULT_CONFIG.ticketPages.pages[0],
      sponsors: [{ ...model.DEFAULT_CONFIG.ticketPages.pages[0].sponsors[0] }],
    }],
  }));

  assert.equal(normalized.ticketPurchases.targetMode, 'mixed');
});

test('findUnsupportedTicketPurchasePayments flags payment counts not enabled on the selected ticket page', () => {
  const unsupported = model.findUnsupportedTicketPurchasePayments({
    paymentMix: {
      check: 2,
      cash: 1,
      invoice: 3,
      credit_card: 4,
    },
  }, {
    settings: {
      creditCard: true,
      sendInvoice: false,
      cash: false,
      check: true,
    },
  });

  assert.deepEqual(unsupported, {
    cash: 1,
    invoice: 3,
  });
});

test('normalizePostCreateActivity preserves auction and donation activity settings', () => {
  const normalized = model.normalizePostCreateActivity({
    enabled: true,
    auctionActivity: {
      enabled: true,
      bidCount: 9,
      maxBidCount: 4,
      includeSilent: false,
      includeLive: true,
    },
    donationActivity: {
      enabled: true,
      donationCount: 5,
      amountMin: 40,
      amountMax: 140,
      anonymousRate: 60,
    },
  }, model.DEFAULT_CONFIG.ticketPages);

  assert.equal(normalized.auctionActivity.enabled, true);
  assert.equal(normalized.auctionActivity.bidCount, 9);
  assert.equal(normalized.auctionActivity.maxBidCount, 4);
  assert.equal(normalized.auctionActivity.includeSilent, false);
  assert.equal(normalized.auctionActivity.includeLive, true);
  assert.equal(normalized.donationActivity.enabled, true);
  assert.equal(normalized.donationActivity.donationCount, 5);
  assert.equal(normalized.donationActivity.amountMin, 40);
  assert.equal(normalized.donationActivity.amountMax, 140);
  assert.equal(normalized.donationActivity.anonymousRate, 60);
});

test('buildRecipe includes normalized post-create activity', () => {
  const recipe = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    basics: {
      ...model.DEFAULT_CONFIG.basics,
      name: 'Post Create Recipe',
      slug: 'postcreaterecipe',
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      onCallDate: '2026-06-02',
    },
    ticketPages: {
      enabled: true,
      preset: 'basic',
      pages: [{
        ...model.DEFAULT_CONFIG.ticketPages.pages[0],
        individualTickets: [{ ...model.DEFAULT_CONFIG.ticketPages.pages[0].individualTickets[0], ticketsPerPurchase: 2 }],
        sponsors: [],
      }],
    },
    postCreateActivity: {
      enabled: true,
      ticketPurchases: {
        quantity: 1,
        addDonation: true,
        donationAmount: 60,
        paymentMix: { credit_card: 2 },
      },
      auctionActivity: {
        enabled: true,
        bidCount: 7,
        maxBidCount: 2,
      },
      donationActivity: {
        enabled: true,
        donationCount: 3,
        amountMin: 50,
        amountMax: 150,
      },
    },
  });

  assert.equal(recipe.postCreateActivity.enabled, true);
  assert.equal(recipe.postCreateActivity.ticketPurchases.purchaseCount, 2);
  assert.equal(recipe.postCreateActivity.ticketPurchases.quantity, 1);
  assert.equal(recipe.postCreateActivity.ticketPurchases.addDonation, true);
  assert.equal(recipe.postCreateActivity.ticketPurchases.donationPurchaseCount, 2);
  assert.equal(recipe.postCreateActivity.ticketPurchases.donationAmount, 60);
  assert.equal(recipe.postCreateActivity.auctionActivity.bidCount, 7);
  assert.equal(recipe.postCreateActivity.auctionActivity.maxBidCount, 2);
  assert.equal(recipe.postCreateActivity.donationActivity.donationCount, 3);
  assert.equal(recipe.postCreateActivity.donationActivity.amountMin, 50);
  assert.equal(recipe.postCreateActivity.donationActivity.amountMax, 150);
});

test('validateSlug enforces ClickBid API slug rules', () => {
  assert.deepEqual(model.validateSlug('qaevent1'), []);
  assert.deepEqual(model.validateSlug('12'), ['Keyword must be at least 3 characters.', 'Keyword must contain at least one letter.']);
  assert.deepEqual(model.validateSlug('1234'), ['Keyword must contain at least one letter.']);
  assert.deepEqual(model.validateSlug('bad slug'), ['Keyword may contain only lowercase letters and numbers.']);
});

test('validateEventSlugAvailability returns local invalid state without calling proxy', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = () => {
    called = true;
    return Promise.resolve({
      status: 200,
      json: async () => ({ status: 200, headers: {}, body: JSON.stringify({ is_valid: true }) }),
    });
  };

  try {
    const result = await model.validateEventSlugAvailability({
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      organizationId: '2716',
      orgToken: 'tok',
      proxyUrl: 'http://localhost:9999/proxy',
    }, '12');

    assert.equal(result.isValid, false);
    assert.equal(result.source, 'local');
    assert.match(result.reason, /at least 3 characters/i);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('validateEventSlugAvailability sends the candidate slug to the remote validator', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = '';
  let capturedBody;
  global.fetch = (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return Promise.resolve({
      status: 200,
      json: async () => ({ status: 200, headers: {}, body: JSON.stringify({ is_valid: true }) }),
    });
  };

  try {
    const result = await model.validateEventSlugAvailability({
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      organizationId: '2716',
      orgToken: 'tok',
      proxyUrl: 'http://localhost:9999/proxy',
    }, 'whimsicalaffairs');

    assert.equal(capturedUrl, 'http://localhost:9999/proxy');
    assert.equal(capturedBody.url, 'https://cbodev2.com/api/v4/organizations/2716/validate-event-slug');
    assert.equal(capturedBody.method, 'POST');
    assert.deepEqual(JSON.parse(capturedBody.body), { slug: 'whimsicalaffairs' });
    assert.equal(result.isValid, true);
    assert.equal(result.slug, 'whimsicalaffairs');
    assert.equal(result.source, 'remote');
  } finally {
    global.fetch = originalFetch;
  }
});

test('validateEventSlugAvailability returns remote taken state', async () => {
  const originalFetch = global.fetch;
  global.fetch = () => Promise.resolve({
    status: 200,
    json: async () => ({ status: 200, headers: {}, body: JSON.stringify({ is_valid: false }) }),
  });

  try {
    const result = await model.validateEventSlugAvailability({
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      organizationId: '2716',
      orgToken: 'tok',
      proxyUrl: 'http://localhost:9999/proxy',
    }, 'whimsicalaffairs');

    assert.equal(result.isValid, false);
    assert.equal(result.source, 'remote');
    assert.match(result.reason, /already in use/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('validateEventSlugAvailability throws useful API errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = () => Promise.resolve({
    status: 200,
    json: async () => ({ status: 401, headers: {}, body: JSON.stringify({ message: 'Invalid token' }) }),
  });

  try {
    await assert.rejects(
      () => model.validateEventSlugAvailability({
        apiBaseUrl: 'https://cbodev2.com/api/v4',
        organizationId: '2716',
        orgToken: 'tok',
        proxyUrl: 'http://localhost:9999/proxy',
      }, 'qavalidslug'),
      /Invalid token/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateBidders creates predictable API-shaped bidder records', () => {
  const bidders = model.generateBidders({ count: 3, startNum: 100, firstNamePrefix: 'QA', lastNamePrefix: 'Bidder', emailPrefix: 'qa-bidder', emailDomain: 'example.com', acceptTexts: false });
  assert.equal(bidders.length, 3);
  assert.deepEqual(bidders[0], {
    bidder_number: 100,
    first_name: 'QA 001',
    last_name: 'Bidder 001',
    accept_texts: false,
    emails: [{ email: 'qa-bidder-001@example.com', primary: true }],
  });
  assert.equal(bidders[2].bidder_number, 102);
});

test('generateBidders with useFaker produces realistic records with addresses', () => {
  const bidders = model.generateBidders({
    count: 5,
    startNum: 100,
    useFaker: true,
    emailDomain: 'mailinator.com',
    acceptTexts: true,
  });
  assert.equal(bidders.length, 5);
  // Should not be prefix-based names
  assert.ok(bidders[0].first_name !== 'QA 001', 'first name should not be prefix-based');
  assert.ok(bidders[0].last_name !== 'Bidder 001', 'last name should not be prefix-based');
  // All should have phones and addresses
  for (const b of bidders) {
    assert.ok(b.phones, 'faker bidders should have phones');
    assert.ok(b.phones[0].phone.length === 10, 'phone should be 10 digits');
    assert.match(b.phones[0].phone, /^555\d{7}$/, 'phone should use a 555 prefix');
    assert.ok(b.address, 'faker bidders should have address');
    assert.ok(typeof b.address === 'string', 'address should be a flat string');
    assert.ok(b.city, 'faker bidders should have city');
    assert.ok(b.state, 'faker bidders should have state');
    assert.ok(b.zip, 'faker bidders should have zip');
    assert.ok(b.emails[0].email.includes('mailinator.com'), 'should use configured email domain');
    assert.equal(b.accept_texts, true, 'acceptTexts should carry through');
  }
  // Each bidder should be unique
  const names = bidders.map(b => `${b.first_name} ${b.last_name}`);
  assert.equal(new Set(names).size, 5, 'all faker names should be unique');
});

test('generateItems creates mixed silent/live/donation/quantity item records with known type IDs', () => {
  const items = model.generateItems({ silentCount: 2, liveCount: 1, donationCount: 1, quantityCount: 1, startNum: 10, namePrefix: 'QA Item', startingBid: 25, bidIncrement: 5, fairMarketValue: 100, reserveAmount: 0, statusId: 1, quantityItemQty: 100, quantityItemTiers: '1-25, 5-100' });
  assert.equal(items.length, 5);
  assert.equal(items[0].item_number, 10);
  assert.equal(items[0].item_type_id, 10);
  assert.equal(items[2].item_type_id, 20);
  assert.equal(items[3].item_type_id, 30);
  assert.equal(items[3].starting_bid, 0);
  assert.equal(items[4].item_type_id, 40);
  assert.equal(items[4].qty, 100);
  assert.deepEqual(items[4].quantity_tiers, [{ quantity: 1, price: 25 }, { quantity: 5, price: 100 }]);
});

test('generateItems with useFaker produces type-appropriate names and varied pricing', () => {
  const items = model.generateItems({ silentCount: 3, liveCount: 2, donationCount: 2, quantityCount: 1, startNum: 100, useFaker: true, quantityItemQty: 100, quantityItemTiers: '1-25, 5-100' });
  assert.equal(items.length, 8);
  // Silent items (type 10)
  assert.equal(items[0].item_type_id, 10);
  assert.ok(!items[0].item_name.includes('QA Item'), 'silent name should not be prefix-based');
  assert.ok(items[0].starting_bid >= 25, 'silent starting bid should be realistic');
  assert.ok(items[0].fair_market_value >= 50, 'silent FMV should be realistic');
  // Live items (type 20) — should have higher pricing
  const liveItems = items.filter(i => i.item_type_id === 20);
  assert.equal(liveItems.length, 2);
  assert.ok(!liveItems[0].item_name.includes('QA Item'), 'live name should not be prefix-based');
  assert.ok(liveItems[0].starting_bid >= 100, 'live starting bid should be higher than silent');
  assert.ok(liveItems[0].fair_market_value >= 500, 'live FMV should be premium');
  // Donation items (type 30) — no bidding
  const donationItems = items.filter(i => i.item_type_id === 30);
  assert.equal(donationItems.length, 2);
  assert.ok(!donationItems[0].item_name.includes('QA Item'), 'donation name should not be prefix-based');
  assert.equal(donationItems[0].starting_bid, 0, 'donations should have 0 starting bid');
  assert.equal(donationItems[0].bid_increment, 0, 'donations should have 0 bid increment');
  assert.ok(donationItems[0].reserve_amount === 0, 'donations should have 0 reserve');
  // All item numbers sequential
  assert.equal(items[0].item_number, 100);
  const quantityItems = items.filter(i => i.item_type_id === 40);
  assert.equal(quantityItems.length, 1);
  assert.equal(quantityItems[0].starting_bid, 0);
  assert.equal(quantityItems[0].bid_increment, 0);
  assert.equal(quantityItems[0].reserve_amount, 0);
  assert.equal(items[7].item_number, 107);
  // All names unique
  const names = items.map(i => i.item_name);
  assert.equal(new Set(names).size, 8, 'all faker item names should be unique');
});

test('environment presets derive API URL from the single base URL', () => {
  assert.equal(model.ENVIRONMENTS.dev.baseUrl, 'https://cbodev.bid');
  assert.equal(model.ENVIRONMENTS.dev4.baseUrl, 'https://cbodev4.com');
  assert.deepEqual(model.environmentPatch('triage'), {
    env: 'triage',
    environmentLabel: 'Triage',
    baseUrl: 'https://cbotriage.bid',
    apiBaseUrl: 'https://cbotriage.bid/api/v4',
    adminBaseUrl: 'https://cbotriage.bid',
    publicBaseUrl: 'https://cbotriage.bid',
  });
});

test('exportRecipeConfig excludes tokens and importRecipeConfig preserves local credentials', () => {
  const current = {
    api: {
      ...model.DEFAULT_CONFIG.api,
      env: 'dev2',
      organizationId: '2716',
      orgToken: 'secret-org-token',
      eventToken: 'secret-event-token',
      browser: 'firefox',
      adminEmail: 'admin@example.test',
      adminPassword: 'secret-browser-password',
    },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Secret Export Test', slug: 'secretexporttest', startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 7 },
      exact: { records: [{ bidder_number: 700, first_name: 'Exact', last_name: 'Bidder', email: 'exact@example.test' }] },
    },
    items: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 3, liveCount: 2 },
      exact: { records: [{ item_number: 901, item_name: 'Exact Item', type: 'silent' }] },
    },
  };

  const exported = model.exportRecipeConfig(current);
  assert.equal(exported.environment.id, 'dev2');
  assert.equal(exported.event.slug, 'secretexporttest');
  assert.equal(exported.bidders.bulk.count, 7);
  assert.equal(exported.bidders.exact.records.length, 1);
  assert.equal(JSON.stringify(exported).includes('secret-org-token'), false);
  assert.equal(JSON.stringify(exported).includes('secret-event-token'), false);

  const imported = model.importRecipeConfig(current, {
    environment: { id: 'dev4', baseUrl: 'https://malicious.example' },
    event: { name: 'Imported Event', slug: 'Imported Event!!', contactPhone: '(555) 777-1212' },
    bidders: {
      activeTab: 'exact',
      bulk: { count: 2 },
      exact: { records: [{ bidder_number: 800, first_name: 'Imported', last_name: 'Bidder' }] },
    },
    items: {
      activeTab: 'exact',
      bulk: { donationCount: 4 },
      exact: { records: [{ item_number: 950, item_name: 'Imported Item', type: 'donation' }] },
    },
  });

  assert.equal(imported.api.env, 'dev4');
  assert.equal(imported.api.baseUrl, 'https://cbodev4.com');
  assert.equal(imported.api.orgToken, 'secret-org-token');
  assert.equal(imported.api.eventToken, 'secret-event-token');
  assert.equal(imported.api.browser, 'firefox');
  assert.equal(imported.api.adminEmail, 'admin@example.test');
  assert.equal(imported.api.adminPassword, 'secret-browser-password');
  assert.equal(imported.basics.name, 'Imported Event');
  assert.equal(imported.basics.slug, 'importedevent');
  assert.equal(imported.basics.contactPhone, '5557771212');
  assert.equal(imported.bidders.bulk.count, 2);
  assert.equal(imported.bidders.exact.records.length, 1);
  assert.equal(imported.items.bulk.donationCount, 4);
  assert.equal(imported.items.exact.records.length, 1);
});

test('importRecipeConfig upgrades legacy flat bidder/item settings into bulk mode', () => {
  const imported = model.importRecipeConfig(model.DEFAULT_CONFIG, {
    event: { name: 'Legacy Import', slug: 'legacyimport' },
    bidders: { count: 3, startNum: 200, firstNamePrefix: 'Legacy' },
    items: { silentCount: 2, liveCount: 1, donationCount: 0, startNum: 10 },
  });

  assert.equal(imported.bidders.bulk.count, 3);
  assert.equal(imported.bidders.bulk.startNum, 200);
  assert.equal(imported.bidders.bulk.firstNamePrefix, 'Legacy');
  assert.equal(imported.items.bulk.silentCount, 2);
  assert.equal(imported.items.bulk.liveCount, 1);
  assert.equal(imported.items.bulk.startNum, 10);
});

test('local settings persistence stores credentials separately from recipes', () => {
  const current = {
    api: {
      ...model.DEFAULT_CONFIG.api,
      env: 'dev3',
      organizationId: 'local-org',
      orgToken: 'secret-org-token',
      eventToken: 'secret-event-token',
      browser: 'webkit',
      adminEmail: 'admin@example.test',
      adminPassword: 'secret-browser-password',
      profileLabel: 'Dev 3 Local Org',
    },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Should Not Persist', slug: 'shouldnotpersist' },
    bidders: { ...model.DEFAULT_CONFIG.bidders, bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 99 } },
    items: { ...model.DEFAULT_CONFIG.items, bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 99 } },
  };

  const savedConfig = model.saveApiProfile(current);
  const saved = model.exportLocalSettings(savedConfig);
  assert.equal(saved.version, model.LOCAL_SETTINGS_VERSION);
  assert.equal(saved.globals.browser, 'webkit');
  assert.equal(saved.globals.adminEmail, 'admin@example.test');
  assert.equal(saved.globals.adminPassword, 'secret-browser-password');
  assert.equal(saved.profiles['dev3::local-org'].env, 'dev3');
  assert.equal(saved.profiles['dev3::local-org'].organizationId, 'local-org');
  assert.equal(saved.profiles['dev3::local-org'].orgToken, 'secret-org-token');
  assert.equal(saved.profiles['dev3::local-org'].eventToken, 'secret-event-token');
  assert.equal(saved.profiles['dev3::local-org'].label, 'Dev 3 Local Org');
  assert.equal(saved.selectedProfileByEnv.dev3, 'dev3::local-org');
  assert.equal(JSON.stringify(saved).includes('Should Not Persist'), false);
  assert.equal(JSON.stringify(saved).includes('shouldnotpersist'), false);

  const restored = model.importLocalSettings({
    ...model.DEFAULT_CONFIG,
    api: {
      ...model.DEFAULT_CONFIG.api,
      ...model.environmentPatch('dev3'),
    },
  }, saved);
  assert.equal(restored.api.env, 'dev3');
  assert.equal(restored.api.baseUrl, 'https://cbodev3.com');
  assert.equal(restored.api.apiBaseUrl, 'https://cbodev3.com/api/v4');
  assert.equal(restored.api.organizationId, 'local-org');
  assert.equal(restored.api.orgToken, 'secret-org-token');
  assert.equal(restored.api.eventToken, 'secret-event-token');
  assert.equal(restored.api.browser, 'webkit');
  assert.equal(restored.api.adminEmail, 'admin@example.test');
  assert.equal(restored.api.adminPassword, 'secret-browser-password');
  assert.equal(restored.api.profileLabel, 'Dev 3 Local Org');
  assert.equal(restored.api.selectedProfileId, 'dev3::local-org');
  assert.equal(restored.basics.name, model.DEFAULT_CONFIG.basics.name);
  assert.equal(restored.bidders.bulk.count, model.DEFAULT_CONFIG.bidders.bulk.count);
});

test('legacy local settings migrate into an env-specific org profile', () => {
  const restored = model.importLocalSettings(model.DEFAULT_CONFIG, {
    api: {
      env: 'dev2',
      organizationId: '2159',
      orgToken: 'legacy-token',
      eventToken: 'legacy-event-token',
      browser: 'firefox',
      adminEmail: 'admin@example.test',
      adminPassword: 'secret-browser-password',
      proxyUrl: 'http://localhost:9999/proxy',
    },
  });

  assert.equal(restored.api.env, 'dev2');
  assert.equal(restored.api.organizationId, '2159');
  assert.equal(restored.api.selectedProfileId, 'dev2::2159');
  assert.equal(restored.api.savedProfiles['dev2::2159'].orgToken, 'legacy-token');
  assert.equal(restored.api.adminEmail, 'admin@example.test');
});

test('LOCAL_SETTINGS_KEY_PREFIX uses a single global settings key', () => {
  assert.equal(model.LOCAL_SETTINGS_KEY_PREFIX, 'mkEvent.localSettings.v3');
});

test('saveApiProfile, applyApiProfile, and deleteApiProfile manage env-scoped org credentials', () => {
  let config = {
    ...model.DEFAULT_CONFIG,
    api: {
      ...model.DEFAULT_CONFIG.api,
      ...model.environmentPatch('stage'),
      organizationId: '2159',
      orgToken: 'stage-token',
      eventToken: 'stage-event-token',
      profileLabel: 'Main Stage Org',
    },
  };

  config = model.saveApiProfile(config);
  assert.equal(config.api.selectedProfileId, 'stage::2159');
  assert.equal(config.api.savedProfiles['stage::2159'].label, 'Main Stage Org');

  config = {
    ...config,
    api: {
      ...config.api,
      ...model.environmentPatch('dev2'),
      organizationId: '9999',
      orgToken: 'dev2-token',
      eventToken: 'dev2-event-token',
      profileLabel: 'Dev2 Org',
    },
  };
  config = model.saveApiProfile(config);
  assert.equal(config.api.selectedProfileByEnv.stage, 'stage::2159');
  assert.equal(config.api.selectedProfileByEnv.dev2, 'dev2::9999');

  let switched = model.importLocalSettings({
    ...model.DEFAULT_CONFIG,
    api: {
      ...model.DEFAULT_CONFIG.api,
      ...model.environmentPatch('stage'),
    },
  }, model.exportLocalSettings(config));
  assert.equal(switched.api.organizationId, '2159');

  switched = model.applyApiProfile({
    ...switched,
    api: {
      ...switched.api,
      ...model.environmentPatch('dev2'),
      savedProfiles: config.api.savedProfiles,
      selectedProfileByEnv: config.api.selectedProfileByEnv,
    },
  }, 'dev2::9999');
  assert.equal(switched.api.organizationId, '9999');
  assert.equal(switched.api.orgToken, 'dev2-token');

  switched = model.deleteApiProfile(switched, 'dev2::9999');
  assert.equal(switched.api.savedProfiles['dev2::9999'], undefined);
  assert.equal(switched.api.organizationId, '');
});

test('buildRecipe returns mixed bulk+exact recipe without customer-facing preview config', () => {
  const recipe = model.buildRecipe({
    api: model.DEFAULT_CONFIG.api,
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, count: 1 },
      exact: { records: [{ bidder_number: 500, first_name: 'Exact', last_name: 'Bidder', email: 'exact@example.test', phone: '(555) 444-3333' }] },
    },
    items: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 1, liveCount: 0, donationCount: 0 },
      exact: { records: [{ item_number: 901, item_name: 'Exact Item', type: 'donation', status_id: 1, starting_bid: 999, bid_increment: 9, fair_market_value: 0, reserve_amount: 0 }] },
    },
  });
  assert.equal(recipe.environment.id, 'stage');
  assert.equal(recipe.bidders.bulk.records.length, 1);
  assert.equal(recipe.bidders.exact.records.length, 1);
  assert.equal(recipe.bidders.count, 2);
  assert.equal(recipe.bidders.exact.records[0].phones[0].phone, '5554443333');
  assert.equal(recipe.items.bulk.records.length, 1);
  assert.equal(recipe.items.exact.records.length, 1);
  assert.equal(recipe.items.count, 2);
  assert.equal(recipe.items.exact.records[0].item_type_id, model.ITEM_TYPE_IDS.donation);
  assert.equal(recipe.items.exact.records[0].starting_bid, 0);
  assert.equal(recipe.customerFacingPages, 'use-clickbid-defaults');
  assert.equal(Object.hasOwn(recipe, 'preview'), false);
});

test('auction settings default to assigning merchant account and syncing bidder start number', () => {
  const config = {
    api: model.DEFAULT_CONFIG.api,
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: { ...model.DEFAULT_CONFIG.bidders, bulk: { ...model.DEFAULT_CONFIG.bidders.bulk, startNum: 432 } },
    items: model.DEFAULT_CONFIG.items,
    auctionSettings: model.DEFAULT_CONFIG.auctionSettings,
  };

  const recipe = model.buildRecipe(config);
  assert.equal(recipe.auctionSettings.enabled, true);
  assert.equal(recipe.auctionSettings.useExistingMerchantAccount, true);
  assert.equal(recipe.auctionSettings.requireCreditCard, true);
  assert.equal(recipe.auctionSettings.startingBidderNumber, '432');

  const exported = model.exportRecipeConfig(config);
  assert.equal(exported.auctionSettings.useExistingMerchantAccount, true);
  assert.equal(exported.auctionSettings.startingBidderNumber, '432');
});

test('admin fee percent: blank default, keeps valid decimals, rejects negative/garbage', () => {
  assert.equal(model.normalizeAuctionSettings().adminFeePercent, '');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: '' }).adminFeePercent, '');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: '3.63' }).adminFeePercent, '3.63');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: 5 }).adminFeePercent, '5');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: '  2.5 ' }).adminFeePercent, '2.5');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: '-1' }).adminFeePercent, '');
  assert.equal(model.normalizeAuctionSettings({ adminFeePercent: 'abc' }).adminFeePercent, '');
});

test('admin fee opt-out defaults to false and coerces to boolean', () => {
  assert.equal(model.normalizeAuctionSettings().allowAdminFeeOptOut, false);
  assert.equal(model.normalizeAuctionSettings({ allowAdminFeeOptOut: true }).allowAdminFeeOptOut, true);
  assert.equal(model.normalizeAuctionSettings({ allowAdminFeeOptOut: 1 }).allowAdminFeeOptOut, true);
});

test('admin fee description defaults blank and coerces to string', () => {
  assert.equal(model.normalizeAuctionSettings().adminFeeDescription, '');
  assert.equal(model.normalizeAuctionSettings({ adminFeeDescription: 'Admin Fees Description' }).adminFeeDescription, 'Admin Fees Description');
});

test('ticket pages default off and normalize basic/full presets for quick setup', () => {
  const off = model.normalizeTicketPages();
  assert.equal(off.enabled, false);
  assert.equal(off.preset, 'off');
  assert.equal(off.pages[0].formName, 'tix');

  const basic = model.normalizeTicketPages({ enabled: true, preset: 'basic', pages: [] });
  assert.equal(basic.enabled, true);
  assert.equal(basic.pages[0].individualTickets.length, 1);
  assert.equal(basic.pages[0].individualTickets[0].name, 'General Admission');
  assert.equal(basic.pages[0].individualTickets[0].price, 100);
  assert.equal(basic.pages[0].sponsors.length, 1);
  assert.equal(basic.pages[0].underwriting.length, 0);

  const full = model.normalizeTicketPages({ enabled: true, preset: 'full', pages: [] });
  assert.equal(full.enabled, true);
  assert.equal(full.pages[0].underwriting.length, 1);
  assert.equal(full.pages[0].selections.length, 2);
  assert.equal(full.pages[0].individualTickets[0].customQuestions.length, 2);
  assert.equal(full.pages[0].individualTickets[0].customQuestions[1].type, 'dropdown');
  assert.equal(full.pages[0].individualTickets[0].customQuestions[1].showOn, 'guest');
  assert.equal(full.pages[0].individualTickets[0].customQuestions[1].isActive, true);
  assert.deepEqual(full.pages[0].individualTickets[0].customQuestions[1].answers, ['Chicken', 'Vegetarian', 'No meal needed']);
  assert.equal(full.pages[0].sponsors[0].customQuestions.length, 2);
  assert.equal(full.pages[0].sponsors[0].customQuestions[0].required, true);
  assert.equal(full.pages[0].selections[0].showOnType, 'ticket-form');
  assert.equal(full.pages[0].selections[0].description, '');
});

test('normalizeTicketPages accepts comma-separated custom question answers and show-on placement', () => {
  const normalized = model.normalizeTicketPages({
    enabled: true,
    preset: 'custom',
    pages: [{
      formName: 'tix',
      displayName: 'Tickets',
      individualTickets: [{
        name: 'General Admission',
        price: 100,
        customQuestions: [{
          question: 'Meal preference',
          type: 'dropdown',
          showOn: 'guest',
          required: true,
          isActive: false,
          answers: 'Chicken, Vegetarian, No meal needed',
        }],
      }],
      sponsors: [],
      underwriting: [],
      selections: [{ name: 'Chicken', description: 'Dinner choice', quantity: 20, visible: true, showOnType: 'individual-ticket', showOnIndex: 0 }],
    }],
  });

  assert.deepEqual(normalized.pages[0].individualTickets[0].customQuestions[0], {
    question: 'Meal preference',
    type: 'dropdown',
    showOn: 'guest',
    required: true,
    isActive: false,
    answers: ['Chicken', 'Vegetarian', 'No meal needed'],
  });
  assert.equal(normalized.pages[0].selections[0].showOnType, 'individual-ticket');
  assert.equal(normalized.pages[0].selections[0].showOnIndex, 0);
  assert.equal(normalized.pages[0].selections[0].description, 'Dinner choice');
});

test('normalizeTicketPages preserves an intentionally cleared custom question label', () => {
  const normalized = model.normalizeTicketPages({
    enabled: true,
    preset: 'custom',
    pages: [{
      formName: 'tix',
      displayName: 'Tickets',
      individualTickets: [{
        name: 'General Admission',
        price: 100,
        customQuestions: [{
          question: '',
          type: 'text',
          showOn: 'ticket',
          required: false,
          isActive: true,
          answers: [],
        }],
      }],
      sponsors: [],
      underwriting: [],
      selections: [],
    }],
  });

  assert.equal(normalized.pages[0].individualTickets[0].customQuestions[0].question, '');
});

test('buildRecipe/export/import preserve ticket page config without credentials', () => {
  const config = {
    api: { ...model.DEFAULT_CONFIG.api, orgToken: 'secret-org-token' },
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: model.DEFAULT_CONFIG.bidders,
    items: model.DEFAULT_CONFIG.items,
    auctionSettings: model.DEFAULT_CONFIG.auctionSettings,
    ticketPages: {
      enabled: true,
      preset: 'custom',
      useFaker: true,
      pages: [{
        formName: 'vip',
        displayName: 'VIP Tickets',
        settings: { creditCard: true, sendInvoice: false, cash: true, check: false, allowGuestUpdates: true, showQrCode: true },
        individualTickets: [{ name: 'VIP Admission', price: 250, fairMarketValue: 50, ticketsPerPurchase: 1, availability: 25, visible: true, customQuestions: [{ question: 'Guest meal', type: 'dropdown', showOn: 'guest', required: true, isActive: false, answers: ['Chicken', 'Vegetarian'] }] }],
        sponsors: [{ title: 'Gold Sponsor', price: 1000, fairMarketValue: 0, ticketsPerPurchase: 8, availability: 5, visible: true, customQuestions: [{ question: 'Logo contact', type: 'text', showOn: 'ticket', required: true, isActive: true, answers: [] }] }],
        underwriting: [{ title: 'Dessert Sponsor', price: 500, fairMarketValue: 0, availability: 5, visible: true, customQuestions: [{ question: 'Plaque wording', type: 'text', showOn: 'ticket', required: false, isActive: true, answers: [] }] }],
        selections: [{ name: 'Vegetarian', description: 'Plant-based entree', quantity: 20, visible: true, showOnType: 'sponsor-ticket', showOnIndex: 0 }],
      }],
    },
  };

  const recipe = model.buildRecipe(config);
  assert.equal(recipe.ticketPages.enabled, true);
  assert.equal(recipe.ticketPages.pages[0].formName, 'vip');
  assert.equal(recipe.customerFacingPages, 'configured-ticket-pages');

  const summary = model.summarizeRecipe(recipe);
  assert.equal(summary.ticketPages.pageCount, 1);
  assert.equal(summary.ticketPages.individualTickets, 1);
  assert.equal(summary.ticketPages.customQuestions, 3);

  const exported = model.exportRecipeConfig(config);
  assert.equal(exported.ticketPages.pages[0].displayName, 'VIP Tickets');
  assert.equal(JSON.stringify(exported).includes('secret-org-token'), false);

  const imported = model.importRecipeConfig(model.DEFAULT_CONFIG, exported);
  assert.equal(imported.ticketPages.enabled, true);
  assert.equal(imported.ticketPages.pages[0].underwriting[0].title, 'Dessert Sponsor');
  assert.equal(imported.ticketPages.pages[0].individualTickets[0].customQuestions[0].type, 'dropdown');
  assert.equal(imported.ticketPages.pages[0].individualTickets[0].customQuestions[0].showOn, 'guest');
  assert.equal(imported.ticketPages.pages[0].individualTickets[0].customQuestions[0].required, true);
  assert.equal(imported.ticketPages.pages[0].individualTickets[0].customQuestions[0].isActive, false);
  assert.equal(imported.ticketPages.pages[0].sponsors[0].customQuestions[0].question, 'Logo contact');
  assert.equal(imported.ticketPages.pages[0].underwriting[0].customQuestions[0].question, 'Plaque wording');
  assert.equal(imported.ticketPages.pages[0].selections[0].showOnType, 'sponsor-ticket');
  assert.equal(imported.ticketPages.pages[0].selections[0].description, 'Plant-based entree');
});

test('pruneTicketPageItemSelections drops wrong-type and out-of-range indexes, keeps valid ones', () => {
  const typed = {
    bulkQuantityItems: [{ bulkIndex: 60 }, { bulkIndex: 61 }],
    exactQuantityItems: [{ exactIndex: 0 }],
    bulkDonationItems: [{ bulkIndex: 40 }],
    exactDonationItems: [{ exactIndex: 1 }],
  };
  const pages = [{
    formName: 'tix',
    quantityItemBulkIndexes: [32, 33, 60, 61], // 32,33 are not quantity items
    quantityItemExactIndexes: [0, 9],          // 9 out of range
    donationItemBulkIndexes: [40, 7],          // 7 not a donation item
    donationItemExactIndexes: [1],             // valid
  }];

  const { pages: pruned, drops } = model.pruneTicketPageItemSelections(pages, typed);

  assert.deepEqual(pruned[0].quantityItemBulkIndexes, [60, 61]);
  assert.deepEqual(pruned[0].quantityItemExactIndexes, [0]);
  assert.deepEqual(pruned[0].donationItemBulkIndexes, [40]);
  assert.deepEqual(pruned[0].donationItemExactIndexes, [1]);

  // drops record what was removed, per page/field
  const qb = drops.find((d) => d.field === 'quantityItemBulkIndexes');
  assert.deepEqual(qb.indexes, [32, 33]);
  assert.equal(qb.formName, 'tix');
  assert.ok(drops.some((d) => d.field === 'quantityItemExactIndexes' && d.indexes.join() === '9'));
  assert.ok(drops.some((d) => d.field === 'donationItemBulkIndexes' && d.indexes.join() === '7'));
});

test('pruneTicketPageItemSelections is a no-op (empty drops) when all selections are valid', () => {
  const typed = {
    bulkQuantityItems: [{ bulkIndex: 1 }, { bulkIndex: 2 }],
    exactQuantityItems: [{ exactIndex: 0 }],
    bulkDonationItems: [{ bulkIndex: 0 }],
    exactDonationItems: [{ exactIndex: 1 }],
  };
  const pages = [{
    formName: 'tix',
    quantityItemBulkIndexes: [1, 2],
    quantityItemExactIndexes: [0],
    donationItemBulkIndexes: [0],
    donationItemExactIndexes: [1],
  }];
  const { pages: pruned, drops } = model.pruneTicketPageItemSelections(pages, typed);
  assert.deepEqual(drops, []);
  assert.deepEqual(pruned[0].quantityItemBulkIndexes, [1, 2]);
});

test('buildRecipe prunes stale quantity selections and records itemSelectionDrops', () => {
  const recipe = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    items: {
      activeTab: 'bulk',
      // bulk order: silent, live, donation, quantity -> quantity occupies the LAST 2 indexes (2,3)
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 2, liveCount: 0, donationCount: 0, quantityCount: 2, startNum: 1 },
      exact: { records: [] },
    },
    ticketPages: {
      enabled: true,
      preset: 'custom',
      pages: [{
        ...model.DEFAULT_CONFIG.ticketPages.pages[0],
        quantityItemBulkIndexes: [0, 2, 3], // 0 is a silent item (stale); 2,3 are quantity
        quantityItemExactIndexes: [],
        donationItemBulkIndexes: [],
        donationItemExactIndexes: [],
      }],
    },
  });

  assert.deepEqual(recipe.ticketPages.pages[0].quantityItemBulkIndexes, [2, 3]);
  assert.ok(Array.isArray(recipe.ticketPages.itemSelectionDrops));
  const drop = recipe.ticketPages.itemSelectionDrops.find((d) => d.field === 'quantityItemBulkIndexes');
  assert.deepEqual(drop.indexes, [0]);
});

test('buildRecipe preserves bulk and exact item references for ticket pages', () => {
  const recipe = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    items: {
      activeTab: 'exact',
      bulk: { ...model.DEFAULT_CONFIG.items.bulk, silentCount: 0, liveCount: 0, donationCount: 1, quantityCount: 2, startNum: 50 },
      exact: {
        records: [
          { item_number: 70, item_name: 'Exact Drink Ticket', type: 'quantity', qty: 100, quantity_tiers: '1-25' },
          { item_number: 71, item_name: 'Exact Mission Fund', type: 'donation' },
        ],
      },
    },
    ticketPages: {
      enabled: true,
      preset: 'custom',
      pages: [{
        ...model.DEFAULT_CONFIG.ticketPages.pages[0],
        quantityItemBulkIndexes: [1, 2],
        quantityItemExactIndexes: [0],
        donationItemBulkIndexes: [0],
        donationItemExactIndexes: [1],
      }],
    },
  });

  assert.equal(recipe.items.bulkQuantityItems.length, 2);
  assert.equal(recipe.items.bulkQuantityItems[0].bulkIndex, 1);
  assert.equal(recipe.items.bulkQuantityItems[0].item_type_id, model.ITEM_TYPE_IDS.quantity);
  assert.equal(recipe.items.exactQuantityItems.length, 1);
  assert.equal(recipe.items.bulkDonationItems.length, 1);
  assert.equal(recipe.items.bulkDonationItems[0].bulkIndex, 0);
  assert.equal(recipe.items.exactDonationItems.length, 1);
  assert.deepEqual(recipe.ticketPages.pages[0].quantityItemBulkIndexes, [1, 2]);
  assert.deepEqual(recipe.ticketPages.pages[0].quantityItemExactIndexes, [0]);
  assert.deepEqual(recipe.ticketPages.pages[0].donationItemBulkIndexes, [0]);
  assert.deepEqual(recipe.ticketPages.pages[0].donationItemExactIndexes, [1]);
});

test('apiProxyCall normalizes proxy-side errors into upstream response envelope', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 403,
    json: async () => ({ error: 'http_403', message: 'Host is not allowed' }),
  });

  try {
    const result = await model.apiProxyCall('http://localhost:9999/proxy', 'https://evil.example/api', 'GET', {});
    assert.equal(result.status, 403);
    assert.deepEqual(result.headers, {});
    assert.deepEqual(JSON.parse(result.body), { error: 'http_403', message: 'Host is not allowed' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('browserFallbackCreateEvent posts to the proxy fallback endpoint', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedBody;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, eventSlug: 'qa-fallback' }),
    };
  };

  try {
    const result = await model.browserFallbackCreateEvent('http://localhost:9999/proxy', { browser: 'chromium', event: { slug: 'qa-fallback' } });
    assert.equal(capturedUrl, 'http://localhost:9999/fallback/create-event');
    assert.equal(capturedBody.browser, 'chromium');
    assert.equal(result.eventSlug, 'qa-fallback');
  } finally {
    global.fetch = originalFetch;
  }
});

test('browserFallbackApplyPostItemConfig posts to the proxy post-item endpoint', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedBody;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, eventId: 'evt-qty' }),
    };
  };

  try {
    const result = await model.browserFallbackApplyPostItemConfig('http://localhost:9999/proxy', { eventId: 'evt-qty', quantityItems: [{ id: '12' }] });
    assert.equal(capturedUrl, 'http://localhost:9999/fallback/post-item-config');
    assert.equal(capturedBody.eventId, 'evt-qty');
    assert.equal(capturedBody.quantityItems[0].id, '12');
    assert.equal(result.eventId, 'evt-qty');
  } finally {
    global.fetch = originalFetch;
  }
});

test('httpCreateEvent posts to the http create endpoint', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedBody;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, eventId: '4591' }),
    };
  };

  try {
    const result = await model.httpCreateEvent('http://localhost:9999/proxy', { browser: 'chromium', event: { slug: 'qa-http' } });
    assert.equal(capturedUrl, 'http://localhost:9999/fallback/create-event-http');
    assert.equal(capturedBody.browser, 'chromium');
    assert.equal(result.eventId, '4591');
  } finally {
    global.fetch = originalFetch;
  }
});

test('httpApplyPostItemConfig posts to the http post-item-config endpoint', async () => {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedBody;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, eventId: 'evt-http' }),
    };
  };

  try {
    const result = await model.httpApplyPostItemConfig('http://localhost:9999/proxy', { eventId: 'evt-http', quantityItems: [{ id: '99' }] });
    assert.equal(capturedUrl, 'http://localhost:9999/fallback/post-item-config-http');
    assert.equal(capturedBody.eventId, 'evt-http');
    assert.equal(result.eventId, 'evt-http');
  } finally {
    global.fetch = originalFetch;
  }
});

test('summarizeRecipe publicUrl reflects the primary ticket-page form name', () => {
  const baseConfig = model.buildRecipe(model.DEFAULT_CONFIG);
  // Ticket pages OFF -> URL is the event root (no path).
  const offSummary = model.summarizeRecipe(baseConfig);
  assert.ok(/^https:\/\/[^/]+$/.test(offSummary.publicUrl), `expected root URL, got ${offSummary.publicUrl}`);

  // Ticket pages ON with a custom form name -> URL carries the form name.
  const withPages = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    api: { ...model.DEFAULT_CONFIG.api, env: 'stage', baseUrl: 'https://cbo.bid' },
    basics: { ...model.DEFAULT_CONFIG.basics, slug: 'qa1234' },
    ticketPages: { enabled: true, preset: 'basic', pages: [{ formName: 'gala-dinner', displayName: 'Gala' }] },
  });
  const onSummary = model.summarizeRecipe(withPages);
  assert.equal(onSummary.publicUrl, 'https://qa1234.cbo.bid/gala-dinner');

  // Ticket pages ON but default 'tix' form name -> still collapses to root.
  const withDefault = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    api: { ...model.DEFAULT_CONFIG.api, env: 'stage', baseUrl: 'https://cbo.bid' },
    basics: { ...model.DEFAULT_CONFIG.basics, slug: 'qa1234' },
    ticketPages: { enabled: true, preset: 'basic', pages: [{ formName: 'tix', displayName: 'Tickets' }] },
  });
  assert.equal(model.summarizeRecipe(withDefault).publicUrl, 'https://qa1234.cbo.bid');
});
