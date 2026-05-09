const assert = require('node:assert/strict');
const test = require('node:test');
const model = require('./event-model.js');

test('slugifyForClickBid produces a valid slug with at least one letter and max 50 chars', () => {
  assert.equal(model.slugifyForClickBid('QA Silent Auction Bug Repro 2026!!'), 'qa-silent-auction-bug-repro-2026');
  assert.equal(model.slugifyForClickBid('123'), 'event-123');
  assert.equal(model.slugifyForClickBid('A'.repeat(80)).length, 50);
});

test('validateSlug enforces ClickBid API slug rules', () => {
  assert.deepEqual(model.validateSlug('qa-event-1'), []);
  assert.deepEqual(model.validateSlug('12'), ['Keyword must be at least 3 characters.','Keyword must contain at least one letter.']);
  assert.deepEqual(model.validateSlug('1234'), ['Keyword must contain at least one letter.']);
  assert.deepEqual(model.validateSlug('bad slug'), ['Keyword may contain only lowercase letters, numbers, and dashes.']);
});

test('generateBidders creates predictable API-shaped bidder records', () => {
  const bidders = model.generateBidders({ count: 3, startNum: 100, firstNamePrefix: 'QA', lastNamePrefix: 'Bidder', emailPrefix: 'qa-bidder', emailDomain: 'example.test', acceptTexts: false });
  assert.equal(bidders.length, 3);
  assert.deepEqual(bidders[0], {
    bidder_number: 100,
    first_name: 'QA 001',
    last_name: 'Bidder 001',
    accept_texts: false,
    emails: [{ email: 'qa-bidder-001@example.test', primary: true }],
  });
  assert.equal(bidders[2].bidder_number, 102);
});

test('generateItems creates mixed silent/live/donation item records with known type IDs', () => {
  const items = model.generateItems({ silentCount: 2, liveCount: 1, donationCount: 1, startNum: 10, namePrefix: 'QA Item', startingBid: 25, bidIncrement: 5, fairMarketValue: 100, reserveAmount: 0, statusId: 1 });
  assert.equal(items.length, 4);
  assert.equal(items[0].item_number, 10);
  assert.equal(items[0].item_type_id, 10);
  assert.equal(items[2].item_type_id, 20);
  assert.equal(items[3].item_type_id, 30);
  assert.equal(items[3].starting_bid, 0);
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
    },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Secret Export Test', slug: 'secret-export-test' },
    bidders: { ...model.DEFAULT_CONFIG.bidders, count: 7 },
    items: { ...model.DEFAULT_CONFIG.items, silentCount: 3, liveCount: 2 },
  };

  const exported = model.exportRecipeConfig(current);
  assert.equal(exported.environment.id, 'dev2');
  assert.equal(exported.event.slug, 'secret-export-test');
  assert.equal(exported.bidders.count, 7);
  assert.equal(JSON.stringify(exported).includes('secret-org-token'), false);
  assert.equal(JSON.stringify(exported).includes('secret-event-token'), false);

  const imported = model.importRecipeConfig(current, {
    environment: { id: 'dev4', baseUrl: 'https://malicious.example' },
    event: { name: 'Imported Event', slug: 'Imported Event!!' },
    bidders: { count: 2 },
    items: { donationCount: 4 },
  });

  assert.equal(imported.api.env, 'dev4');
  assert.equal(imported.api.baseUrl, 'https://cbodev4.com');
  assert.equal(imported.api.orgToken, 'secret-org-token');
  assert.equal(imported.api.eventToken, 'secret-event-token');
  assert.equal(imported.api.browser, 'firefox');
  assert.equal(imported.basics.name, 'Imported Event');
  assert.equal(imported.basics.slug, 'imported-event');
  assert.equal(imported.bidders.count, 2);
  assert.equal(imported.items.donationCount, 4);
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
    },
    basics: { ...model.DEFAULT_CONFIG.basics, name: 'Should Not Persist', slug: 'should-not-persist' },
    bidders: { ...model.DEFAULT_CONFIG.bidders, count: 99 },
    items: { ...model.DEFAULT_CONFIG.items, silentCount: 99 },
  };

  const saved = model.exportLocalSettings(current);
  assert.equal(saved.version, model.LOCAL_SETTINGS_VERSION);
  assert.equal(saved.api.env, 'dev3');
  assert.equal(saved.api.organizationId, 'local-org');
  assert.equal(saved.api.orgToken, 'secret-org-token');
  assert.equal(saved.api.eventToken, 'secret-event-token');
  assert.equal(JSON.stringify(saved).includes('Should Not Persist'), false);
  assert.equal(JSON.stringify(saved).includes('should-not-persist'), false);

  const restored = model.importLocalSettings(model.DEFAULT_CONFIG, {
    api: { ...saved.api, baseUrl: 'https://malicious.example' },
  });
  assert.equal(restored.api.env, 'dev3');
  assert.equal(restored.api.baseUrl, 'https://cbodev3.com');
  assert.equal(restored.api.apiBaseUrl, 'https://cbodev3.com/api/v4');
  assert.equal(restored.api.organizationId, 'local-org');
  assert.equal(restored.api.orgToken, 'secret-org-token');
  assert.equal(restored.api.eventToken, 'secret-event-token');
  assert.equal(restored.api.browser, 'webkit');
  assert.equal(restored.basics.name, model.DEFAULT_CONFIG.basics.name);
  assert.equal(restored.bidders.count, model.DEFAULT_CONFIG.bidders.count);
});

test('buildRecipe returns settings-only recipe without customer-facing preview config', () => {
  const recipe = model.buildRecipe({
    api: model.DEFAULT_CONFIG.api,
    basics: model.DEFAULT_CONFIG.basics,
    bidders: { ...model.DEFAULT_CONFIG.bidders, count: 1 },
    items: { ...model.DEFAULT_CONFIG.items, silentCount: 1, liveCount: 0, donationCount: 0 },
  });
  assert.equal(recipe.environment.id, 'dev2');
  assert.equal(recipe.bidders.records.length, 1);
  assert.equal(recipe.items.records.length, 1);
  assert.equal(recipe.customerFacingPages, 'use-clickbid-defaults');
  assert.equal(Object.hasOwn(recipe, 'preview'), false);
});
