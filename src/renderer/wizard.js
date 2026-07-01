// Wizard step metadata + validation + quick-start presets (pure, testable).

const STEPS = [
  { id: 'connect',  num: 1, icon: 'fa-plug',          title: 'Connect',          subtitle: 'Point mkEvent at a QA environment and organization.' },
  { id: 'basics',   num: 2, icon: 'fa-circle-info',   title: 'Event basics',     subtitle: 'Name, keyword, schedule, and contact.' },
  { id: 'bidders',  num: 3, icon: 'fa-users',         title: 'Bidders',          subtitle: 'How many bidders to generate, and how.' },
  { id: 'items',    num: 4, icon: 'fa-gavel',         title: 'Items',            subtitle: 'Silent, live, donation, and quantity items.' },
  { id: 'auction',  num: 5, icon: 'fa-sliders',       title: 'Auction settings', subtitle: 'Admin toggles applied after the event is created.' },
  { id: 'tickets',  num: 6, icon: 'fa-ticket',        title: 'Ticket pages',     subtitle: 'Ticket forms, ticket types, selections, and questions.' },
  { id: 'activity', num: 7, icon: 'fa-cart-shopping', title: 'Activity',         subtitle: 'Optional public checkout seeding for guest and sales data.' },
  { id: 'review',   num: 8, icon: 'fa-rocket-launch', title: 'Review & create',  subtitle: 'Confirm the recipe, then build the event.' },
];

function basicsReady(cfg) {
  const b = cfg.basics || {};
  return Boolean(
    b.name && b.slug && b.startDate && b.endDate && b.onCallDate &&
    b.contactFirstName && b.contactLastName && b.contactEmail && b.contactPhone
  );
}

function connectReady(cfg) {
  return Boolean(cfg.api && cfg.api.organizationId && cfg.api.orgToken);
}

function canCreateEvent(cfg, slugCheck) {
  const slug = cfg.basics ? cfg.basics.slug : '';
  const slugBlocked = slugCheck && slugCheck.slug === slug && ['taken', 'invalid'].includes(slugCheck.state);
  return Boolean(connectReady(cfg) && basicsReady(cfg) && !slugBlocked);
}

function stepReady(cfg, id, slugCheck) {
  if (id === 'connect') return connectReady(cfg);
  if (id === 'basics') return basicsReady(cfg);
  if (id === 'review') return canCreateEvent(cfg, slugCheck);
  return true; // bidders/items/auction/tickets/activity always have valid defaults
}

function readyCount(cfg, slugCheck) {
  return STEPS.reduce((n, s) => n + (stepReady(cfg, s.id, slugCheck) ? 1 : 0), 0);
}

const QUICK_START = [
  { id: 'gala',    icon: 'fa-champagne-glasses', name: 'Typical gala', blurb: '75 bidders · 58 items',
    bidders: 75,  items: { silent: 40,  live: 12, donation: 6,  quantity: 0 } },
  { id: 'stress',  icon: 'fa-gauge-high',        name: 'Stress test',  blurb: '500 bidders · 270 items',
    bidders: 500, items: { silent: 180, live: 60, donation: 30, quantity: 0 } },
  { id: 'minimal', icon: 'fa-feather',           name: 'Minimal',      blurb: '5 bidders · 7 items',
    bidders: 5,   items: { silent: 5,   live: 2,  donation: 0,  quantity: 0 } },
];

function applyQuickStart(setCfg, preset) {
  if (!preset) return;
  setCfg((current) => ({
    ...current,
    bidders: { ...current.bidders, bulk: { ...current.bidders.bulk, count: preset.bidders } },
    items: {
      ...current.items,
      bulk: {
        ...current.items.bulk,
        silentCount: preset.items.silent,
        liveCount: preset.items.live,
        donationCount: preset.items.donation,
        quantityCount: preset.items.quantity,
      },
    },
  }));
}

const WIZARD_API = { STEPS, stepReady, canCreateEvent, readyCount, QUICK_START, applyQuickStart };
// ponytail: dual CJS/browser export — Vite bundles this file as a plain ES
// module (no CJS interop for local source files), so a bare `module.exports`
// throws `ReferenceError: module is not defined` at runtime in the renderer.
// Node (wizard.test.js via require()) still gets module.exports as before;
// the browser bundle reads globalThis.WIZARD instead. Mirrors the existing
// event-model.js UMD pattern in this repo.
if (typeof module === 'object' && module.exports) module.exports = WIZARD_API;
if (typeof globalThis !== 'undefined') globalThis.WIZARD = WIZARD_API;
