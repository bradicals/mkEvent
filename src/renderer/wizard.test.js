const test = require('node:test');
const assert = require('node:assert/strict');
const wizard = require('./wizard.js');

const baseCfg = () => ({
  api: { env: 'stage', organizationId: '', orgToken: '' },
  basics: {
    name: '', slug: '', startDate: '', endDate: '', onCallDate: '',
    contactFirstName: '', contactLastName: '', contactEmail: '', contactPhone: '',
  },
  bidders: { bulk: { count: 5 } },
  items: { bulk: { silentCount: 5, liveCount: 0, donationCount: 0, quantityCount: 0 } },
});

const fullBasics = {
  name: 'QA Gala', slug: 'qa-gala', startDate: '2026-08-01', endDate: '2026-08-02',
  onCallDate: '2026-08-01', contactFirstName: 'A', contactLastName: 'B',
  contactEmail: 'a@b.com', contactPhone: '5551212',
};

test('STEPS has 8 steps ending in review', () => {
  assert.equal(wizard.STEPS.length, 8);
  assert.equal(wizard.STEPS[0].id, 'connect');
  assert.equal(wizard.STEPS.at(-1).id, 'review');
});

test('connect step ready only with org id + token', () => {
  const cfg = baseCfg();
  assert.equal(wizard.stepReady(cfg, 'connect'), false);
  cfg.api.organizationId = 'org1';
  cfg.api.orgToken = 'tok';
  assert.equal(wizard.stepReady(cfg, 'connect'), true);
});

test('basics step ready needs all required fields', () => {
  const cfg = baseCfg();
  assert.equal(wizard.stepReady(cfg, 'basics'), false);
  cfg.basics = { ...fullBasics };
  assert.equal(wizard.stepReady(cfg, 'basics'), true);
});

test('optional steps are always ready', () => {
  const cfg = baseCfg();
  for (const id of ['bidders', 'items', 'auction', 'tickets', 'activity']) {
    assert.equal(wizard.stepReady(cfg, id), true, id);
  }
});

test('canCreateEvent requires connect + basics and unblocked slug', () => {
  const cfg = baseCfg();
  assert.equal(wizard.canCreateEvent(cfg, null), false);
  cfg.api.organizationId = 'org1';
  cfg.api.orgToken = 'tok';
  cfg.basics = { ...fullBasics };
  assert.equal(wizard.canCreateEvent(cfg, { state: 'ok', slug: 'qa-gala' }), true);
  assert.equal(wizard.canCreateEvent(cfg, { state: 'taken', slug: 'qa-gala' }), false);
});

test('readyCount counts ready steps', () => {
  const cfg = baseCfg();
  // connect+basics not ready, review not ready => 5 optional ready
  assert.equal(wizard.readyCount(cfg, null), 5);
});

test('applyQuickStart merges counts into bulk shapes', () => {
  let cfg = baseCfg();
  const setCfg = (fn) => { cfg = fn(cfg); };
  wizard.applyQuickStart(setCfg, wizard.QUICK_START.find(p => p.id === 'stress'));
  assert.equal(cfg.bidders.bulk.count, 500);
  assert.equal(cfg.items.bulk.silentCount, 180);
  // untouched sibling fields preserved
  assert.equal(cfg.items.bulk.quantityCount, 0);
});
