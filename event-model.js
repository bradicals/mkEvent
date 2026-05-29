(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EventModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ITEM_TYPE_IDS = Object.freeze({
    silent: 10,
    live: 20,
    donation: 30,
    quantity: 40,
  });

  // ── Random event name pool ───────────────────────────────────────────
  const EVENT_ADJECTIVES = [
    'Silent','Charity','Annual','Grand','Moonlit','Starlit','Sparkling',
    'Enchanted','Golden','Midnight','Crystal','Twilight','Emerald','Royal',
    'Vintage','Coastal','Harvest','Winter','Spring','Summer','Autumn',
    'Neon','Rustic','Elegant','Whimsical','Cosmic','Tropical','Frosty',
    'Radiant','Velvet','Lucky','Bold','Hidden','Sacred','Electric','Jade',
    'Luminous','Candescent','Silver','Ivory','Amber','Sapphire','Opulent',
    'Lantern','Garden','Riviera','Starry','Civic','Glowing','Majestic',
    'Elevated','Classic','Regal','Sunset','Dazzling','Polished','Noble',
    'Shimmering','Festive','Heritage','Dreamy','Merry','Brilliant','Timeless',
  ];

  const EVENT_MODIFIERS = [
    'Harbor','Garden','River','Crown','Summit','Legacy','Lantern','Horizon',
    'Oasis','Meadow','Terrace','Boulevard','Skyline','Moon','Star','Rose',
    'Pearl','Beacon','Park','Pavilion','Bridge','Hall','Grove','Vista',
    'Sands','Valley','Heights','Cove','Manor','Plaza','Shore','Gilded',
  ];

  const EVENT_NOUNS = [
    'Gala','Auction','Ball','Soiree','Festival','Celebration','Night',
    'Affair','Extravaganza','Banquet','Carnival','Showcase','Rendezvous',
    'Spectacular','Masquerade','Jubilee','Bash','Gathering','Party','Feast',
    'Fair','Fundraiser','Classic','Cruise','Horizons','Dreams','Wonders',
    'Journey','Symphony','Haven','Rising','Nights','Benefit','Social',
    'Mixer','Reception','Launch','Parade','Experience','Retreat','Celebration',
    'Benefit Dinner','Market','Revue','Benefit Bash','Moonlight','Gathering',
  ];

  function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function randomEventName() {
    const patternRoll = Math.random();
    const adjective = pickRandom(EVENT_ADJECTIVES);
    const modifier = pickRandom(EVENT_MODIFIERS);
    const noun = pickRandom(EVENT_NOUNS);

    if (patternRoll < 0.34) {
      return `${adjective} ${noun}`;
    }
    if (patternRoll < 0.67) {
      return `${adjective} ${modifier} ${noun}`;
    }
    return `${modifier} ${noun}`;
  }

  const ITEM_TYPE_OPTIONS = Object.freeze([
    Object.freeze({ value: 'silent', label: 'Silent', itemTypeId: ITEM_TYPE_IDS.silent }),
    Object.freeze({ value: 'live', label: 'Live', itemTypeId: ITEM_TYPE_IDS.live }),
    Object.freeze({ value: 'donation', label: 'Donation', itemTypeId: ITEM_TYPE_IDS.donation }),
    Object.freeze({ value: 'quantity', label: 'Quantity', itemTypeId: ITEM_TYPE_IDS.quantity }),
  ]);

  const ENVIRONMENTS = Object.freeze({
    stage: Object.freeze({ label: 'Stage', baseUrl: 'https://cbo.bid' }),
    triage: Object.freeze({ label: 'Triage', baseUrl: 'https://cbotriage.bid' }),
    dev: Object.freeze({ label: 'Dev', baseUrl: 'https://cbodev.bid' }),
    dev2: Object.freeze({ label: 'Dev 2', baseUrl: 'https://cbodev2.com' }),
    dev3: Object.freeze({ label: 'Dev 3', baseUrl: 'https://cbodev3.com' }),
    dev4: Object.freeze({ label: 'Dev 4', baseUrl: 'https://cbodev4.com' }),
  });

  function trimTrailingSlash(value) {
    return String(value || '').replace(/\/$/, '');
  }

  function apiBaseUrlFrom(baseUrl) {
    const cleanBaseUrl = trimTrailingSlash(baseUrl);
    return cleanBaseUrl ? `${cleanBaseUrl}/api/v4` : '';
  }

  function todayDateOnly() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function maxDateOnly(a, b) {
    if (!isDateOnly(a)) return isDateOnly(b) ? b : '';
    if (!isDateOnly(b)) return a;
    return a >= b ? a : b;
  }

  function minDateOnly(a, b) {
    if (!isDateOnly(a)) return isDateOnly(b) ? b : '';
    if (!isDateOnly(b)) return a;
    return a <= b ? a : b;
  }

  function normalizeEventSchedule(basics = {}) {
    const today = todayDateOnly();
    const startDate = maxDateOnly(basics.startDate, today) || today;
    const endDate = maxDateOnly(basics.endDate, startDate) || startDate;
    const requestedOnCallDate = basics.onCallDate || endDate;
    const onCallDate = minDateOnly(maxDateOnly(requestedOnCallDate, startDate), endDate) || endDate;
    return { startDate, endDate, onCallDate };
  }

  function buildPublicEventUrl(baseUrl, eventSlug, formName = '') {
    const slug = String(eventSlug || '').trim();
    const cleanBaseUrl = trimTrailingSlash(baseUrl);
    if (!slug || !cleanBaseUrl) return '';
    try {
      const parsed = new URL(cleanBaseUrl);
      parsed.hostname = `${slug}.${parsed.hostname}`;
      parsed.pathname = formName && formName !== 'tix' ? `/${String(formName).replace(/^\/+/, '')}` : '/';
      parsed.search = '';
      parsed.hash = '';
      return trimTrailingSlash(parsed.toString());
    } catch (_) {
      return '';
    }
  }

  function environmentPatch(env) {
    const key = ENVIRONMENTS[env] ? env : 'stage';
    const preset = ENVIRONMENTS[key];
    return {
      env: key,
      environmentLabel: preset.label,
      baseUrl: preset.baseUrl,
      apiBaseUrl: apiBaseUrlFrom(preset.baseUrl),
      adminBaseUrl: preset.baseUrl,
      publicBaseUrl: preset.baseUrl,
    };
  }

  const RECIPE_VERSION = 1;
  const LOCAL_SETTINGS_VERSION = 3;
  const LOCAL_SETTINGS_KEY_PREFIX = 'mkEvent.localSettings.v3';
  const LOCAL_PRESET_LIBRARY_KEY = 'mkEvent.localPresets.v1';
  const LOCAL_PRESET_VERSION = 1;

  const DEFAULT_CONFIG = Object.freeze({
    api: {
      env: 'stage',
      environmentLabel: 'Stage',
      baseUrl: 'https://cbo.bid',
      apiBaseUrl: 'https://cbo.bid/api/v4',
      adminBaseUrl: 'https://cbo.bid',
      publicBaseUrl: 'https://cbo.bid',
      organizationId: '',
      orgToken: '',
      eventToken: '',
      browser: 'chromium',
      adminEmail: '',
      adminPassword: '',
      proxyUrl: 'http://localhost:9999/proxy',
      savedProfiles: {},
      selectedProfileId: '',
      selectedProfileByEnv: {},
      profileLabel: '',
    },
    basics: {
      name: 'QA Event',
      slug: 'qaevent',
      startDate: '',
      startTime: '09:00',
      endDate: '',
      endTime: '17:00',
      onCallDate: '',
      timezone: 'America/New_York',
      contactFirstName: 'QA',
      contactLastName: 'Automation',
      contactEmail: 'qa-event@example.com',
      contactPhone: '5550000000',
    },
    bidders: {
      activeTab: 'bulk',
      bulk: {
        count: 5,
        startNum: 100,
        useFaker: false,
        firstNamePrefix: 'QA',
        lastNamePrefix: 'Bidder',
        emailPrefix: 'qa-bidder',
        emailDomain: 'example.com',
        acceptTexts: false,
        addPhones: false,
      },
      exact: {
        records: [],
      },
    },
    items: {
      activeTab: 'bulk',
      bulk: {
        silentCount: 5,
        liveCount: 0,
        donationCount: 0,
        quantityCount: 0,
        startNum: 1,
        useFaker: false,
        namePrefix: 'QA Item',
        startingBid: 25,
        bidIncrement: 5,
        fairMarketValue: 100,
        reserveAmount: 0,
        statusId: 1,
        quantityItemQty: 100,
        quantityItemTiers: '1-25, 5-100, 10-180',
      },
      exact: {
        records: [],
      },
    },
    auctionSettings: {
      enabled: true,
      useExistingMerchantAccount: true,
      maxBidding: true,
      allowBidderRegistration: true,
      enableTextToRegister: false,
      resetMobileCheckin: true,
      requireAddress: false,
      requireCreditCard: true,
      syncStartingBidderNumber: true,
      startingBidderNumber: '',
      enableCrypto: false,
      enableLink: false,
    },
    ticketPages: {
      enabled: false,
      preset: 'off',
      useFaker: false,
      pages: [
        {
          formName: 'tix',
          displayName: 'Tickets',
          settings: {
            creditCard: true,
            sendInvoice: true,
            cash: false,
            check: false,
            allowGuestUpdates: true,
            showQrCode: true,
          },
          individualTickets: [
            {
              name: 'General Admission',
              price: 100,
              fairMarketValue: 0,
              ticketsPerPurchase: 1,
              availability: 100,
              visible: true,
              customQuestions: [],
            },
          ],
          sponsors: [
            {
              title: 'Gold Sponsor',
              price: 1000,
              fairMarketValue: 0,
              ticketsPerPurchase: 8,
              availability: 10,
              visible: true,
              customQuestions: [],
            },
          ],
          underwriting: [],
          selections: [],
          quantityItemBulkIndexes: [],
          quantityItemExactIndexes: [],
          donationItemBulkIndexes: [],
          donationItemExactIndexes: [],
        },
      ],
    },
    postCreateActivity: {
      enabled: false,
      useFaker: true,
      ticketPurchases: {
        enabled: true,
        pageIndex: 0,
        targetMode: 'specific',
        targetType: 'individual-ticket',
        targetIndex: 0,
        purchaseCount: 1,
        quantity: 1,
        addDonation: false,
        donationPurchaseCount: 0,
        donationAmount: 50,
        paymentMethod: 'check',
        paymentMix: {
          check: 1,
          cash: 0,
          invoice: 0,
          credit_card: 0,
        },
      },
      auctionActivity: {
        enabled: false,
        bidCount: 6,
        maxBidCount: 2,
        includeSilent: true,
        includeLive: true,
      },
      donationActivity: {
        enabled: false,
        donationCount: 3,
        amountMin: 25,
        amountMax: 250,
        anonymousRate: 25,
      },
    },
  });

  function pad(num, width = 3) {
    return String(num).padStart(width, '0');
  }

  function clampString(value, max) {
    return String(value || '').slice(0, max);
  }

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function slugifyForClickBid(value) {
    let slug = String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '');

    if (!/[a-z]/.test(slug)) slug = `event${slug || 'qa'}`;
    if (slug.length < 3) slug = `${slug}event`;
    return slug.slice(0, 50);
  }

  function validateSlug(slug) {
    const errors = [];
    const value = String(slug || '');
    if (value.length < 3) errors.push('Keyword must be at least 3 characters.');
    if (value.length > 50) errors.push('Keyword must be 50 characters or less.');
    if (!/[a-zA-Z]/.test(value)) errors.push('Keyword must contain at least one letter.');
    if (!/^[a-z0-9]+$/.test(value)) errors.push('Keyword may contain only lowercase letters and numbers.');
    return errors;
  }

  function normalizeBidderSection(section) {
    const base = section || {};
    const fallbackBulk = {
      count: Number(base.count) || DEFAULT_CONFIG.bidders.bulk.count,
      startNum: Number(base.startNum) || DEFAULT_CONFIG.bidders.bulk.startNum,
      firstNamePrefix: base.firstNamePrefix || DEFAULT_CONFIG.bidders.bulk.firstNamePrefix,
      lastNamePrefix: base.lastNamePrefix || DEFAULT_CONFIG.bidders.bulk.lastNamePrefix,
      emailPrefix: base.emailPrefix || DEFAULT_CONFIG.bidders.bulk.emailPrefix,
      emailDomain: base.emailDomain || DEFAULT_CONFIG.bidders.bulk.emailDomain,
      acceptTexts: Boolean(base.acceptTexts),
      addPhones: Boolean(base.addPhones),
    };

    return {
      activeTab: base.activeTab === 'exact' ? 'exact' : 'bulk',
      bulk: {
        ...DEFAULT_CONFIG.bidders.bulk,
        ...(base.bulk || fallbackBulk),
      },
      exact: {
        records: Array.isArray(base.exact?.records)
          ? base.exact.records
          : Array.isArray(base.records)
            ? base.records
            : [],
      },
    };
  }

  function normalizeItemSection(section) {
    const base = section || {};
    const fallbackBulk = {
      silentCount: Number(base.silentCount) || 0,
      liveCount: Number(base.liveCount) || 0,
      donationCount: Number(base.donationCount) || 0,
      quantityCount: Number(base.quantityCount) || 0,
      startNum: Number(base.startNum) || DEFAULT_CONFIG.items.bulk.startNum,
      namePrefix: base.namePrefix || DEFAULT_CONFIG.items.bulk.namePrefix,
      startingBid: Number(base.startingBid) || 0,
      bidIncrement: Number(base.bidIncrement) || 0,
      fairMarketValue: Number(base.fairMarketValue) || 0,
      reserveAmount: Number(base.reserveAmount) || 0,
      statusId: Number(base.statusId) || DEFAULT_CONFIG.items.bulk.statusId,
      quantityItemQty: Math.max(1, Number(base.quantityItemQty) || DEFAULT_CONFIG.items.bulk.quantityItemQty),
      quantityItemTiers: serializeQuantityTiers(base.quantityItemTiers || DEFAULT_CONFIG.items.bulk.quantityItemTiers),
    };

    return {
      activeTab: base.activeTab === 'exact' ? 'exact' : 'bulk',
      bulk: {
        ...DEFAULT_CONFIG.items.bulk,
        ...(base.bulk || fallbackBulk),
      },
      exact: {
        records: Array.isArray(base.exact?.records)
          ? base.exact.records
          : Array.isArray(base.records)
            ? base.records
            : [],
      },
    };
  }

  function normalizeAuctionSettings(section, bidderSection) {
    const defaults = DEFAULT_CONFIG.auctionSettings;
    const base = section || {};
    const bulkStartNum = Number(bidderSection?.bulk?.startNum) || DEFAULT_CONFIG.bidders.bulk.startNum;
    const startingBidderNumber = base.syncStartingBidderNumber === false
      ? String(base.startingBidderNumber || '')
      : String(bulkStartNum || '');

    return {
      enabled: base.enabled !== false,
      useExistingMerchantAccount: base.useExistingMerchantAccount !== false,
      maxBidding: base.maxBidding !== undefined ? Boolean(base.maxBidding) : defaults.maxBidding,
      allowBidderRegistration: base.allowBidderRegistration !== undefined ? Boolean(base.allowBidderRegistration) : defaults.allowBidderRegistration,
      enableTextToRegister: Boolean(base.enableTextToRegister),
      resetMobileCheckin: base.resetMobileCheckin !== false,
      requireAddress: Boolean(base.requireAddress),
      requireCreditCard: base.requireCreditCard !== undefined ? Boolean(base.requireCreditCard) : defaults.requireCreditCard,
      syncStartingBidderNumber: base.syncStartingBidderNumber !== false,
      startingBidderNumber,
      enableCrypto: Boolean(base.enableCrypto),
      enableLink: Boolean(base.enableLink),
    };
  }

  function cloneTicketPageDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG.ticketPages.pages[0]));
  }

  function ticketPagePreset(preset) {
    const page = cloneTicketPageDefaults();
    if (preset === 'full') {
      page.underwriting = [
        { title: 'Dessert Sponsor', price: 500, fairMarketValue: 0, availability: 5, visible: true },
      ];
      page.selections = [
        { name: 'Chicken', description: '', quantity: 100, visible: true, showOnType: 'ticket-form', showOnIndex: 0 },
        { name: 'Vegetarian', description: '', quantity: 50, visible: true, showOnType: 'ticket-form', showOnIndex: 0 },
      ];
      page.customQuestions = [];
      page.individualTickets[0].customQuestions = [
        { question: 'Guest names', type: 'text', showOn: 'ticket', required: false, isActive: true, answers: [] },
        { question: 'Meal preference', type: 'dropdown', showOn: 'guest', required: false, isActive: true, answers: ['Chicken', 'Vegetarian', 'No meal needed'] },
      ];
      page.sponsors[0].customQuestions = [
        { question: 'Company logo contact', type: 'text', showOn: 'ticket', required: true, isActive: true, answers: [] },
        { question: 'Recognition preference', type: 'dropdown', showOn: 'ticket', required: false, isActive: true, answers: ['Website', 'Program', 'Both'] },
      ];
    }
    return page;
  }

  function normalizeCustomQuestionAnswers(value) {
    const rawAnswers = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];

    return rawAnswers
      .map((answer) => clampString(answer, 80).trim())
      .filter(Boolean);
  }

  function normalizeCustomQuestions(records) {
    return (Array.isArray(records) ? records : []).map((record) => ({
      question: clampString(record?.question ?? '', 120),
      type: ['text', 'dropdown'].includes(record?.type) ? record.type : 'text',
      showOn: ['ticket', 'guest'].includes(record?.showOn) ? record.showOn : 'ticket',
      required: Boolean(record?.required),
      isActive: record?.isActive !== false,
      answers: normalizeCustomQuestionAnswers(record?.answers),
    }));
  }

  function normalizeSelectionRecord(record) {
    const normalized = normalizeTicketRecord(
      record,
      { name: 'Selection', description: '', quantity: 100, visible: true, showOnType: 'ticket-form', showOnIndex: 0 },
      'name',
    );
    normalized.description = clampString(record?.description ?? '', 255);
    normalized.showOnType = ['ticket-form', 'individual-ticket', 'sponsor-ticket'].includes(record?.showOnType)
      ? record.showOnType
      : 'ticket-form';
    normalized.showOnIndex = normalized.showOnType === 'ticket-form'
      ? 0
      : Math.max(0, Number(record?.showOnIndex) || 0);
    return normalized;
  }

  function normalizeQuantityTiers(value) {
    const rawTiers = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];

    return rawTiers
      .map((entry) => {
        if (typeof entry === 'string') {
          const parts = entry.split(/[:-]/).map((part) => part.trim());
          const quantity = Math.max(1, Number(parts[0]) || 0);
          const price = Math.max(0, Number(parts[1]) || 0);
          if (!quantity || !price) return null;
          return { quantity, price };
        }
        const quantity = Math.max(1, Number(entry?.quantity) || 0);
        const price = Math.max(0, Number(entry?.price) || 0);
        if (!quantity || !price) return null;
        return { quantity, price };
      })
      .filter(Boolean);
  }

  function serializeQuantityTiers(tiers) {
    return normalizeQuantityTiers(tiers)
      .map((tier) => `${tier.quantity}-${tier.price}`)
      .join(', ');
  }

  function normalizeTicketRecord(record, defaults, nameKey) {
    const base = record || {};
    const normalized = { ...defaults };
    Object.entries(defaults).forEach(([key, value]) => {
      if (key === nameKey) {
        normalized[key] = clampString(base[key] || value, 80);
      } else if (typeof value === 'boolean') {
        normalized[key] = base[key] !== undefined ? Boolean(base[key]) : value;
      } else if (typeof value === 'number') {
        normalized[key] = base[key] !== undefined ? Math.max(0, Number(base[key]) || 0) : value;
      } else {
        normalized[key] = base[key] ?? value;
      }
    });
    normalized.customQuestions = normalizeCustomQuestions(base.customQuestions);
    return normalized;
  }

  function normalizeTicketPages(section) {
    const defaults = DEFAULT_CONFIG.ticketPages;
    const base = section || {};
    const preset = ['off', 'basic', 'full', 'custom'].includes(base.preset) ? base.preset : (base.enabled ? 'basic' : 'off');
    const enabled = preset === 'off' ? false : Boolean(base.enabled);
    const sourcePages = Array.isArray(base.pages) && base.pages.length > 0
      ? base.pages
      : [ticketPagePreset(preset === 'off' ? 'basic' : preset)];

    const pages = sourcePages.map((rawPage) => {
      const defaultPage = cloneTicketPageDefaults();
      const page = rawPage || {};
      return {
        formName: clampString(page.formName || defaultPage.formName, 20),
        displayName: clampString(page.displayName || defaultPage.displayName, 80),
        settings: {
          ...defaultPage.settings,
          ...(page.settings || {}),
        },
        individualTickets: (Array.isArray(page.individualTickets) ? page.individualTickets : defaultPage.individualTickets)
          .map((record) => normalizeTicketRecord(record, defaultPage.individualTickets[0], 'name')),
        sponsors: (Array.isArray(page.sponsors) ? page.sponsors : defaultPage.sponsors)
          .map((record) => normalizeTicketRecord(record, defaultPage.sponsors[0], 'title')),
        underwriting: (Array.isArray(page.underwriting) ? page.underwriting : [])
          .map((record) => normalizeTicketRecord(record, { title: 'Underwriting Opportunity', price: 250, fairMarketValue: 0, availability: 10, visible: true }, 'title')),
        selections: (Array.isArray(page.selections) ? page.selections : [])
          .map((record) => normalizeSelectionRecord(record)),
        quantityItemBulkIndexes: (Array.isArray(page.quantityItemBulkIndexes) ? page.quantityItemBulkIndexes : [])
          .map((index) => Math.max(0, Number(index) || 0))
          .filter((value, index, array) => array.indexOf(value) === index),
        quantityItemExactIndexes: (Array.isArray(page.quantityItemExactIndexes) ? page.quantityItemExactIndexes : [])
          .map((index) => Math.max(0, Number(index) || 0))
          .filter((value, index, array) => array.indexOf(value) === index),
        donationItemBulkIndexes: (Array.isArray(page.donationItemBulkIndexes) ? page.donationItemBulkIndexes : [])
          .map((index) => Math.max(0, Number(index) || 0))
          .filter((value, index, array) => array.indexOf(value) === index),
        donationItemExactIndexes: (Array.isArray(page.donationItemExactIndexes) ? page.donationItemExactIndexes : [])
          .map((index) => Math.max(0, Number(index) || 0))
          .filter((value, index, array) => array.indexOf(value) === index),
        pageCustomQuestions: normalizeCustomQuestions(page.customQuestions),
      };
    });

    return {
      enabled,
      preset,
      useFaker: Boolean(base.useFaker || defaults.useFaker),
      pages,
    };
  }

  function resolvePurchaseTargetDefaults(ticketPages) {
    const pages = Array.isArray(ticketPages?.pages) ? ticketPages.pages : [];
    const selectedPage = pages[0] || null;
    if (selectedPage?.individualTickets?.length) {
      return { pageIndex: 0, targetMode: 'specific', targetType: 'individual-ticket', targetIndex: 0 };
    }
    if (selectedPage?.sponsors?.length) {
      return { pageIndex: 0, targetMode: 'specific', targetType: 'sponsor-ticket', targetIndex: 0 };
    }
    return { pageIndex: 0, targetMode: 'specific', targetType: 'individual-ticket', targetIndex: 0 };
  }

  function normalizeAuctionActivity(section) {
    const defaults = DEFAULT_CONFIG.postCreateActivity.auctionActivity;
    const base = section || {};
    return {
      enabled: Boolean(base.enabled),
      bidCount: Math.max(0, Number(base.bidCount) || defaults.bidCount),
      maxBidCount: Math.max(0, Number(base.maxBidCount) || defaults.maxBidCount),
      includeSilent: base.includeSilent !== false,
      includeLive: base.includeLive !== false,
    };
  }

  function normalizeDonationActivity(section) {
    const defaults = DEFAULT_CONFIG.postCreateActivity.donationActivity;
    const base = section || {};
    const amountMin = Math.max(1, Number(base.amountMin) || defaults.amountMin);
    const amountMax = Math.max(amountMin, Number(base.amountMax) || defaults.amountMax);
    return {
      enabled: Boolean(base.enabled),
      donationCount: Math.max(0, Number(base.donationCount) || defaults.donationCount),
      amountMin,
      amountMax,
      anonymousRate: Math.min(100, Math.max(0, Number(base.anonymousRate) || 0)),
    };
  }

  function normalizeTicketPurchasePaymentMix(purchaseBase, defaults) {
    const rawMix = purchaseBase?.paymentMix || {};
    const hasExplicitMix = Object.keys(rawMix).length > 0;
    const fallbackMethod = ['check', 'cash', 'invoice', 'credit_card'].includes(purchaseBase?.paymentMethod)
      ? purchaseBase.paymentMethod
      : defaults.paymentMethod;
    const fallbackCount = Math.max(1, Number(purchaseBase?.purchaseCount) || defaults.purchaseCount);
    const mix = {
      check: Math.max(0, Number(rawMix.check) || 0),
      cash: Math.max(0, Number(rawMix.cash) || 0),
      invoice: Math.max(0, Number(rawMix.invoice) || 0),
      credit_card: Math.max(0, Number(rawMix.credit_card) || 0),
    };

    if (!hasExplicitMix) {
      mix[fallbackMethod] = fallbackCount;
    }

    const purchaseCount = Object.values(mix).reduce((total, count) => total + count, 0);
    if (purchaseCount === 0) {
      mix.check = fallbackCount;
      return { paymentMix: mix, purchaseCount: fallbackCount };
    }

    return { paymentMix: mix, purchaseCount };
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

  function findUnsupportedTicketPurchasePayments(ticketPurchases, pageConfig) {
    const support = resolveTicketPurchasePaymentSupport(pageConfig);
    const mix = ticketPurchases?.paymentMix || {};
    return Object.fromEntries(
      Object.entries(mix)
        .filter(([method, count]) => Number(count) > 0 && support[method] === false)
        .map(([method, count]) => [method, Number(count) || 0]),
    );
  }

  // Donations can only be seeded through the credit-card/Stripe checkout, so a
  // donating purchase IS a credit-card purchase. donationPurchaseCount = how many
  // of the credit-card purchases also add a donation, clamped to the credit-card
  // count. Migration: a legacy recipe with addDonation:true but no explicit count
  // means "all credit-card purchases donate".
  function resolveDonationPurchasePlan(purchaseBase, paymentMix) {
    const creditCardCount = Math.max(0, Number(paymentMix?.credit_card) || 0);
    const addDonationFlag = Boolean(purchaseBase?.addDonation);
    const hasExplicitCount = purchaseBase?.donationPurchaseCount !== undefined
      && purchaseBase?.donationPurchaseCount !== null;
    let donationPurchaseCount;
    if (hasExplicitCount) {
      donationPurchaseCount = addDonationFlag
        ? Math.max(0, Math.min(creditCardCount, Number(purchaseBase.donationPurchaseCount) || 0))
        : 0;
    } else {
      // legacy migration: all credit-card purchases donate when the flag is on
      donationPurchaseCount = addDonationFlag ? creditCardCount : 0;
    }
    return {
      donationPurchaseCount,
      addDonation: donationPurchaseCount > 0,
    };
  }

  function normalizePostCreateActivity(section, ticketPages) {
    const defaults = DEFAULT_CONFIG.postCreateActivity;
    const normalizedTicketPages = normalizeTicketPages(ticketPages);
    const fallbackTarget = resolvePurchaseTargetDefaults(normalizedTicketPages);
    const base = section || {};
    const purchaseBase = base.ticketPurchases || {};
    const pages = normalizedTicketPages.pages;
    const pageIndex = Math.min(
      Math.max(0, Number(purchaseBase.pageIndex) || fallbackTarget.pageIndex),
      Math.max(0, pages.length - 1),
    );
    const selectedPage = pages[pageIndex] || null;
    const allowedTargetTypes = ['individual-ticket', 'sponsor-ticket'];
    let targetType = allowedTargetTypes.includes(purchaseBase.targetType)
      ? purchaseBase.targetType
      : fallbackTarget.targetType;
    if (targetType === 'individual-ticket' && !(selectedPage?.individualTickets?.length)) {
      targetType = selectedPage?.sponsors?.length ? 'sponsor-ticket' : 'individual-ticket';
    }
    if (targetType === 'sponsor-ticket' && !(selectedPage?.sponsors?.length)) {
      targetType = selectedPage?.individualTickets?.length ? 'individual-ticket' : 'sponsor-ticket';
    }
    const targetPool = targetType === 'sponsor-ticket'
      ? (selectedPage?.sponsors || [])
      : (selectedPage?.individualTickets || []);
    const targetIndex = Math.min(
      Math.max(0, Number(purchaseBase.targetIndex) || 0),
      Math.max(0, targetPool.length - 1),
    );
    const paymentPlan = normalizeTicketPurchasePaymentMix(purchaseBase, defaults.ticketPurchases);

    return {
      enabled: Boolean(base.enabled),
      useFaker: base.useFaker !== false,
      ticketPurchases: {
        enabled: purchaseBase.enabled !== false,
        pageIndex,
        targetMode: purchaseBase.targetMode === 'mixed' ? 'mixed' : fallbackTarget.targetMode,
        targetType,
        targetIndex,
        purchaseCount: paymentPlan.purchaseCount,
        quantity: Math.max(1, Number(purchaseBase.quantity) || defaults.ticketPurchases.quantity),
        ...resolveDonationPurchasePlan(purchaseBase, paymentPlan.paymentMix),
        donationAmount: Math.max(1, Number(purchaseBase.donationAmount) || defaults.ticketPurchases.donationAmount),
        paymentMethod: ['check', 'cash', 'invoice', 'credit_card'].includes(purchaseBase.paymentMethod)
          ? purchaseBase.paymentMethod
          : defaults.ticketPurchases.paymentMethod,
        paymentMix: paymentPlan.paymentMix,
      },
      auctionActivity: normalizeAuctionActivity(base.auctionActivity),
      donationActivity: normalizeDonationActivity(base.donationActivity),
    };
  }

  // ── Lightweight faker for realistic bidder data ────────────────────────
  const FAKE_FIRST_NAMES = [
    'James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda',
    'David','Elizabeth','William','Barbara','Richard','Susan','Joseph','Jessica',
    'Thomas','Sarah','Christopher','Karen','Charles','Lisa','Daniel','Nancy',
    'Matthew','Betty','Anthony','Margaret','Mark','Sandra','Donald','Ashley',
    'Steven','Kimberly','Andrew','Emily','Paul','Donna','Joshua','Michelle',
    'Kenneth','Carol','Kevin','Amanda','Brian','Dorothy','George','Melissa',
    'Timothy','Deborah','Ronald','Stephanie','Edward','Rebecca','Jason','Sharon',
    'Jeffrey','Laura','Ryan','Cynthia','Jacob','Kathleen','Gary','Amy',
    'Nicholas','Angela','Eric','Shirley','Jonathan','Anna','Stephen','Brenda',
    'Larry','Pamela','Justin','Emma','Scott','Nicole','Brandon','Helen',
    'Benjamin','Samantha','Samuel','Katherine','Raymond','Christine','Gregory','Debra',
    'Frank','Rachel','Alexander','Carolyn','Patrick','Janet','Jack','Catherine',
    'Dennis','Maria','Jerry','Heather','Tyler','Diane','Aaron','Ruth',
  ];
  const FAKE_LAST_NAMES = [
    'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
    'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson',
    'Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson',
    'White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker',
    'Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill',
    'Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell',
    'Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner','Diaz',
    'Parker','Cruz','Edwards','Collins','Reyes','Stewart','Morris','Morales',
    'Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper','Peterson',
    'Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward',
    'Richardson','Watson','Brooks','Chavez','Wood','James','Bennett','Gray',
    'Mendoza','Ruiz','Hughes','Price','Alvarez','Castillo','Sanders','Patel',
    'Myers','Long','Ross','Foster','Jimenez','Powell',
  ];
  const FAKE_STREET_NAMES = [
    'Oak','Maple','Cedar','Pine','Elm','Birch','Walnut','Willow',
    'Spruce','Ash','Cherry','Laurel','Hickory','Chestnut','Sycamore','Magnolia',
    'Peach','Poplar','Cypress','Hazel','Juniper','Aspen','Dogwood','Redwood',
  ];
  const FAKE_STREET_SUFFIXES = ['St','Ave','Blvd','Dr','Ln','Ct','Way','Rd'];
  const FAKE_CITIES = [
    'Springfield','Franklin','Clinton','Georgetown','Salem','Madison',
    'Arlington','Burlington','Manchester','Oxford','Cambridge','Rochester',
    'Henderson','Kingston','Dover','Fairfield','Winston','Hamilton',
  ];
  const FAKE_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
    'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VT','VA','WA','WV','WI','WY',
  ];

  let _fakeIndex = 0;
  function fakeBidder(bidderNumber, config) {
    const i = _fakeIndex++;
    const first = FAKE_FIRST_NAMES[i % FAKE_FIRST_NAMES.length];
    const last = FAKE_LAST_NAMES[(i * 7 + 3) % FAKE_LAST_NAMES.length];
    const streetNum = 100 + ((i * 13 + 7) % 9900);
    const street = FAKE_STREET_NAMES[(i * 11) % FAKE_STREET_NAMES.length];
    const suffix = FAKE_STREET_SUFFIXES[(i * 3) % FAKE_STREET_SUFFIXES.length];
    const city = FAKE_CITIES[(i * 5) % FAKE_CITIES.length];
    const state = FAKE_STATES[(i * 9) % FAKE_STATES.length];
    const zip = String(10000 + ((i * 17 + 1) % 89999));
    const phone = `555${String((i * 311 + 7) % 10000000).padStart(7, '0')}`;
    const emailDomain = String(config.emailDomain || 'example.com').toLowerCase();

    return {
      bidder_number: bidderNumber,
      first_name: clampString(first, 25),
      last_name: clampString(last, 35),
      accept_texts: Boolean(config.acceptTexts),
      emails: [{ email: `${first.toLowerCase()}.${last.toLowerCase()}${bidderNumber}@${emailDomain}`, primary: true }],
      phones: [{ phone, primary: true }],
      address: `${streetNum} ${street} ${suffix}`,
      city,
      state,
      zip,
    };
  }

  function generateBidders(config) {
    const count = Math.max(0, Number(config.count) || 0);
    const startNum = Number(config.startNum) || 1;

    if (config.useFaker) {
      _fakeIndex = 0;
      return Array.from({ length: count }, (_, index) =>
        fakeBidder(startNum + index, config)
      );
    }

    const firstNamePrefix = clampString(config.firstNamePrefix || 'QA', 20);
    const lastNamePrefix = clampString(config.lastNamePrefix || 'Bidder', 28);
    const emailPrefix = String(config.emailPrefix || 'qa-bidder').toLowerCase();
    const emailDomain = String(config.emailDomain || 'example.com').toLowerCase();

    return Array.from({ length: count }, (_, index) => {
      const ordinal = pad(index + 1);
      const bidder = {
        bidder_number: startNum + index,
        first_name: clampString(`${firstNamePrefix} ${ordinal}`, 25),
        last_name: clampString(`${lastNamePrefix} ${ordinal}`, 35),
        accept_texts: Boolean(config.acceptTexts),
        emails: [{ email: `${emailPrefix}-${ordinal}@${emailDomain}`, primary: true }],
      };

      if (config.addPhones) {
        bidder.phones = [{ phone: `555000${String(index + 1).padStart(4, '0')}`, primary: true }];
      }

      return bidder;
    });
  }

  function normalizeExactBidderRecords(records) {
    return (Array.isArray(records) ? records : []).flatMap((record) => {
      const firstName = clampString(record?.first_name || '', 25);
      const lastName = clampString(record?.last_name || '', 35);
      const email = String(record?.email || '').trim().toLowerCase();
      const phone = digitsOnly(record?.phone || '');
      const bidderNumber = Number(record?.bidder_number);
      const hasAnyValue = firstName || lastName || email || phone || bidderNumber;
      if (!hasAnyValue) return [];

      const bidder = {
        bidder_number: bidderNumber > 0 ? bidderNumber : undefined,
        first_name: firstName,
        last_name: lastName,
        accept_texts: Boolean(record?.accept_texts),
      };

      if (email) bidder.emails = [{ email, primary: true }];
      if (phone) bidder.phones = [{ phone, primary: true }];
      return [bidder];
    });
  }

  // ── Lightweight faker for realistic item data ─────────────────────────
  const FAKE_SILENT_ITEMS = [
    'Weekend Getaway Package','Wine Tasting Experience','Gourmet Dinner for Two',
    'Spa Day Package','Artisan Gift Basket','Cooking Class','Golf Foursome',
    'Concert Tickets','Museum Family Membership','Brewery Tour','Photography Session',
    'Yoga Retreat Day Pass','Hot Air Balloon Ride','Painting Workshop','Sailing Excursion',
    'Mountain Biking Adventure','Vineyard Tour & Tasting','Guided Hiking Trip',
    'Pottery Making Class','Stand-Up Paddleboard Rental','Horseback Riding Lesson',
    'Rock Climbing Session','Kayak Tour','Escape Room Experience','Indoor Skydiving',
    'Distillery Tour','Tea Tasting Experience','Flower Arranging Class',
    'Jewelry Making Workshop','Surfing Lesson','Culinary Walking Tour',
    'Ski Pass Bundle','Helicopter Tour','Scuba Diving Intro','Zipline Adventure',
    'Farm-to-Table Dinner','Outdoor Movie Night Package','Truffle Making Class',
    'Sunset Cruise','Archery Lesson','Axe Throwing Experience','Birdwatching Tour',
    'Stargazing Package','Glass Blowing Class','Vintage Wine Collection',
  ];
  const FAKE_LIVE_ITEMS = [
    'Luxury Vacation Package','Signed Memorabilia','Designer Handbag','Premium Wine Collection',
    'VIP Sports Tickets','Fine Art Painting','Diamond Necklace','Exotic Car Driving Experience',
    'Celebrity Meet & Greet','Custom Jewelry Piece','Antique Furniture','First Edition Book',
    'Rare Coin Collection','Handcrafted Violin','Original Sculpture','Beachfront Condo Stay',
    'Gourmet Chef Dinner','Porsche Track Day','Broadway Show Tickets','Yacht Charter',
    'Private Jet Experience','Exclusive Golf Club Membership','Luxury Watch','Vintage Guitar',
    'Custom Tailored Suit','Premium Whiskey Collection','Original Movie Prop',
    'Thoroughbred Racehorse Naming Rights','Luxury Ski Chalet Weekend','Private Concert',
    'Hot Air Balloon Festival Package','Island Getaway','Sports Hall of Fame Tour',
    'Fine Dining Chef Table Experience','Celebrity Golf Outing','Luxury Safari Adventure',
    'Vintage Sports Car','Exclusive Wine Locker','Bespoke Perfume Creation',
    'Art Gallery Private Viewing','Luxury Camping Glamping Package','Master Sommelier Class',
    'Helicopter Ski Trip','Private Polo Lesson','Exclusive Auction Experience',
  ];
  const FAKE_DONATION_ITEMS = [
    'Cash Donation','General Fund Contribution','Scholarship Fund','Building Fund',
    'Program Sponsorship','Memorial Donation','Technology Upgrade Fund','Youth Program Support',
    'Community Outreach Fund','Facility Renovation','Educational Materials','Emergency Relief',
    'Animal Welfare Fund','Arts Program Support','Sports Equipment Fund','Library Expansion',
    'Health & Wellness Program','Environmental Initiative','Food Pantry Support',
    'Music Program Fund','Science Lab Equipment','Playground Fund','Transportation Fund',
    'Teacher Appreciation Fund','Student Leadership Program','Veterinary Care Fund',
    'Garden & Green Space Fund','Senior Services Fund','Mental Health Awareness Fund',
    'Clean Water Initiative','Disaster Recovery Fund','Digital Literacy Program',
    'Cultural Exchange Program','After-School Program','Nutrition Program Fund',
    'Career Development Fund','Language Learning Program','Community Theater Fund',
    'Wildlife Conservation','Historic Preservation Fund','Innovation Lab Fund',
    'Accessibility Improvements','Volunteer Recognition Fund','Family Support Services',
    'Outdoor Education Fund','Music Therapy Program','Artist Residency Fund',
  ];

  let _fakeItemIndex = 0;
  function fakeItem(type, itemNumber, sequence, config = {}) {
    const i = _fakeItemIndex++;
    const pool = type === 'live' ? FAKE_LIVE_ITEMS
      : type === 'donation' ? FAKE_DONATION_ITEMS
      : FAKE_SILENT_ITEMS;
    const name = pool[i % pool.length];

    // Vary pricing based on type
    let startingBid, bidIncrement, fairMarketValue;
    if (type === 'donation') {
      startingBid = 0;
      bidIncrement = 0;
      fairMarketValue = [50, 100, 100, 250, 250, 500][(i * 3) % 6];
    } else if (type === 'live') {
      startingBid = [100, 250, 250, 500, 500, 1000][(i * 5) % 6];
      bidIncrement = [25, 50, 50, 100, 100, 250][(i * 7) % 6];
      fairMarketValue = [500, 1000, 1500, 2000, 2500, 5000][(i * 11) % 6];
    } else if (type === 'quantity') {
      startingBid = 0;
      bidIncrement = 0;
      fairMarketValue = [25, 50, 75, 100, 150, 200][(i * 11) % 6];
    } else {
      startingBid = [25, 25, 50, 50, 75, 100][(i * 3) % 6];
      bidIncrement = [5, 5, 10, 10, 10, 25][(i * 7) % 6];
      fairMarketValue = [50, 75, 100, 150, 200, 300][(i * 11) % 6];
    }

    const item = {
      item_number: itemNumber,
      item_name: clampString(name, 250),
      item_type_id: ITEM_TYPE_IDS[type],
      status_id: 1,
      starting_bid: startingBid,
      bid_increment: bidIncrement,
      fair_market_value: fairMarketValue,
      reserve_amount: ['donation', 'quantity'].includes(type) ? 0 : Math.round(fairMarketValue * 0.6),
    };
    if (type === 'quantity') {
      item.qty = Math.max(1, Number(config.quantityItemQty) || DEFAULT_CONFIG.items.bulk.quantityItemQty);
      item.limited = true;
      item.quantity_tiers = normalizeQuantityTiers(config.quantityItemTiers);
    }
    return item;
  }

  function itemRecord({ type, itemNumber, sequence, config }) {
    const isDonation = type === 'donation';
    const isQuantity = type === 'quantity';
    const label = type === 'silent' ? 'Silent' : type === 'live' ? 'Live' : type === 'quantity' ? 'Quantity' : 'Donation';
    const item = {
      item_number: itemNumber,
      item_name: clampString(`${config.namePrefix || 'QA Item'} ${label} ${pad(sequence)}`, 250),
      item_type_id: ITEM_TYPE_IDS[type],
      status_id: Number(config.statusId) || 1,
      starting_bid: (isDonation || isQuantity) ? 0 : Number(config.startingBid) || 0,
      bid_increment: (isDonation || isQuantity) ? 0 : Number(config.bidIncrement) || 0,
      fair_market_value: Number(config.fairMarketValue) || 0,
      reserve_amount: isQuantity ? 0 : Math.min(Number(config.reserveAmount) || 0, 99999999),
    };
    if (isQuantity) {
      item.qty = Math.max(1, Number(config.quantityItemQty) || DEFAULT_CONFIG.items.bulk.quantityItemQty);
      item.limited = true;
      item.quantity_tiers = normalizeQuantityTiers(config.quantityItemTiers);
    }
    return item;
  }

  function generateItems(config) {
    if (config.useFaker) {
      _fakeItemIndex = 0;
      const rows = [];
      let itemNumber = Number(config.startNum) || 1;
      let sequence = 1;
      const addType = (type, count) => {
        Array.from({ length: Math.max(0, Number(count) || 0) }).forEach(() => {
          rows.push(fakeItem(type, itemNumber, sequence, config));
          itemNumber += 1;
          sequence += 1;
        });
      };
      addType('silent', config.silentCount);
      addType('live', config.liveCount);
      addType('donation', config.donationCount);
      addType('quantity', config.quantityCount);
      return rows;
    }

    const rows = [];
    let itemNumber = Number(config.startNum) || 1;
    let sequence = 1;
    const addType = (type, count) => {
      Array.from({ length: Math.max(0, Number(count) || 0) }).forEach(() => {
        rows.push(itemRecord({ type, itemNumber, sequence, config }));
        itemNumber += 1;
        sequence += 1;
      });
    };
    addType('silent', config.silentCount);
    addType('live', config.liveCount);
    addType('donation', config.donationCount);
    addType('quantity', config.quantityCount);
    return rows;
  }

  function normalizeExactItemRecords(records) {
    return (Array.isArray(records) ? records : []).flatMap((record) => {
      const itemName = clampString(record?.item_name || '', 250);
      const itemNumber = Number(record?.item_number);
      const type = ITEM_TYPE_IDS[record?.type] ? record.type : 'silent';
      const statusId = Number(record?.status_id) || 1;
      const startingBid = Number(record?.starting_bid) || 0;
      const bidIncrement = Number(record?.bid_increment) || 0;
      const fairMarketValue = Number(record?.fair_market_value) || 0;
      const reserveAmount = Number(record?.reserve_amount) || 0;
      const quantityTiers = normalizeQuantityTiers(record?.quantity_tiers);
      const quantityLimit = Math.max(0, Number(record?.qty) || 0);
      const isQuantity = type === 'quantity';
      const hasAnyValue = itemName || itemNumber || startingBid || bidIncrement || fairMarketValue || reserveAmount || quantityLimit || quantityTiers.length;
      if (!hasAnyValue) return [];
      const normalizedItem = {
        item_number: itemNumber > 0 ? itemNumber : undefined,
        item_name: itemName,
        item_type_id: ITEM_TYPE_IDS[type],
        status_id: statusId,
        starting_bid: ['donation', 'quantity'].includes(type) ? 0 : startingBid,
        bid_increment: ['donation', 'quantity'].includes(type) ? 0 : bidIncrement,
        fair_market_value: fairMarketValue,
        reserve_amount: isQuantity ? 0 : Math.min(reserveAmount, 99999999),
      };

      if (isQuantity) {
        normalizedItem.qty = quantityLimit || quantityTiers.reduce((max, tier) => Math.max(max, Number(tier.quantity) || 0), 0) || 1;
        normalizedItem.limited = true;
        normalizedItem.quantity_tiers = quantityTiers;
      }

      return [normalizedItem];
    });
  }

  // Ticket-page item selections are stored as positional indexes into the bulk/
  // exact item arrays. When the item mix changes, a stored index can stop pointing
  // at an item of the right type (e.g. a quantity selection now lands on a silent
  // item) — that produced "selected … items were not created" warnings at apply
  // time. Prune any index that doesn't resolve to an item of the matching type,
  // and report what was dropped so the engine can log it.
  function pruneTicketPageItemSelections(pages, typed) {
    const validSets = {
      quantityItemBulkIndexes: new Set((typed.bulkQuantityItems || []).map((i) => i.bulkIndex)),
      quantityItemExactIndexes: new Set((typed.exactQuantityItems || []).map((i) => i.exactIndex)),
      donationItemBulkIndexes: new Set((typed.bulkDonationItems || []).map((i) => i.bulkIndex)),
      donationItemExactIndexes: new Set((typed.exactDonationItems || []).map((i) => i.exactIndex)),
    };
    const drops = [];
    const prunedPages = (Array.isArray(pages) ? pages : []).map((page) => {
      const next = { ...page };
      for (const [field, valid] of Object.entries(validSets)) {
        const current = Array.isArray(page[field]) ? page[field] : [];
        const kept = current.filter((index) => valid.has(index));
        const dropped = current.filter((index) => !valid.has(index));
        if (dropped.length > 0) {
          drops.push({ formName: page.formName || 'tix', field, indexes: dropped });
        }
        next[field] = kept;
      }
      return next;
    });
    return { pages: prunedPages, drops };
  }

  function buildRecipe(config) {
    const safeSlug = slugifyForClickBid(config.basics.slug || config.basics.name);
    const eventSchedule = normalizeEventSchedule(config.basics);
    const bidderSection = normalizeBidderSection(config.bidders);
    const itemSection = normalizeItemSection(config.items);
    const bulkBidders = generateBidders(bidderSection.bulk);
    const exactBidders = normalizeExactBidderRecords(bidderSection.exact.records);
    const bulkItems = generateItems(itemSection.bulk);
    const exactItems = normalizeExactItemRecords(itemSection.exact.records);
    const auctionSettings = normalizeAuctionSettings(config.auctionSettings, bidderSection);
    const ticketPages = normalizeTicketPages(config.ticketPages);
    const bulkQuantityItems = bulkItems
      .map((item, bulkIndex) => ({ ...item, bulkIndex }))
      .filter((item) => item.item_type_id === ITEM_TYPE_IDS.quantity);
    const exactQuantityItems = exactItems
      .map((item, exactIndex) => ({ ...item, exactIndex }))
      .filter((item) => item.item_type_id === ITEM_TYPE_IDS.quantity);
    const bulkDonationItems = bulkItems
      .map((item, bulkIndex) => ({ ...item, bulkIndex }))
      .filter((item) => item.item_type_id === ITEM_TYPE_IDS.donation);
    const exactDonationItems = exactItems
      .map((item, exactIndex) => ({ ...item, exactIndex }))
      .filter((item) => item.item_type_id === ITEM_TYPE_IDS.donation);
    // Drop stale ticket-page item selections that no longer point at the right
    // item type (prevents "selected items were not created" warnings at apply time).
    const { pages: prunedTicketPages, drops: itemSelectionDrops } = pruneTicketPageItemSelections(
      ticketPages.pages,
      { bulkQuantityItems, exactQuantityItems, bulkDonationItems, exactDonationItems },
    );
    ticketPages.pages = prunedTicketPages;
    ticketPages.itemSelectionDrops = itemSelectionDrops;
    const postCreateActivity = normalizePostCreateActivity(config.postCreateActivity, ticketPages);
    const envKey = ENVIRONMENTS[config.api.env] ? config.api.env : 'stage';
    const envPreset = ENVIRONMENTS[envKey];
    const baseUrl = envPreset.baseUrl;
    const apiBaseUrl = envPreset.baseUrl ? apiBaseUrlFrom(envPreset.baseUrl) : '';

    return {
      environment: {
        id: envKey,
        label: envPreset.label,
        baseUrl,
        apiBaseUrl,
        adminBaseUrl: baseUrl,
        publicBaseUrl: baseUrl,
        organizationId: config.api.organizationId,
        hasOrgToken: Boolean(config.api.orgToken),
        hasEventToken: Boolean(config.api.eventToken),
      },
      event: {
        name: config.basics.name,
        slug: safeSlug,
        startDate: eventSchedule.startDate,
        startTime: config.basics.startTime,
        endDate: eventSchedule.endDate,
        endTime: config.basics.endTime,
        onCallDate: eventSchedule.onCallDate,
        timezone: config.basics.timezone,
        contactFirstName: config.basics.contactFirstName,
        contactLastName: config.basics.contactLastName,
        contactEmail: config.basics.contactEmail,
        contactPhone: digitsOnly(config.basics.contactPhone),
      },
      bidders: {
        bulk: {
          count: bulkBidders.length,
          records: bulkBidders,
        },
        exact: {
          count: exactBidders.length,
          records: exactBidders,
        },
        count: bulkBidders.length + exactBidders.length,
        records: [...bulkBidders, ...exactBidders],
      },
      items: {
        bulk: {
          count: bulkItems.length,
          records: bulkItems,
        },
        exact: {
          count: exactItems.length,
          records: exactItems,
        },
        count: bulkItems.length + exactItems.length,
        records: [...bulkItems, ...exactItems],
        bulkQuantityItems,
        exactQuantityItems,
        bulkDonationItems,
        exactDonationItems,
      },
      auctionSettings,
      ticketPages,
      postCreateActivity,
      customerFacingPages: ticketPages.enabled ? 'configured-ticket-pages' : 'use-clickbid-defaults',
    };
  }

  function exportRecipeConfig(config) {
    const bidders = normalizeBidderSection(config.bidders);
    const items = normalizeItemSection(config.items);
    const auctionSettings = normalizeAuctionSettings(config.auctionSettings, bidders);
    const ticketPages = normalizeTicketPages(config.ticketPages);
    const postCreateActivity = normalizePostCreateActivity(config.postCreateActivity, ticketPages);
    const eventSchedule = normalizeEventSchedule(config.basics);
    return {
      version: RECIPE_VERSION,
      environment: {
        id: config.api.env,
      },
      event: {
        name: config.basics.name,
        slug: slugifyForClickBid(config.basics.slug || config.basics.name),
        startDate: eventSchedule.startDate,
        startTime: config.basics.startTime,
        endDate: eventSchedule.endDate,
        endTime: config.basics.endTime,
        onCallDate: eventSchedule.onCallDate,
        timezone: config.basics.timezone,
        contactFirstName: config.basics.contactFirstName,
        contactLastName: config.basics.contactLastName,
        contactEmail: config.basics.contactEmail,
        contactPhone: digitsOnly(config.basics.contactPhone),
      },
      bidders,
      items,
      auctionSettings,
      ticketPages,
      postCreateActivity,
    };
  }

  function importRecipeConfig(currentConfig, importedRecipe) {
    const source = importedRecipe || {};
    const envId = source.environment?.id || source.environment || currentConfig.api.env;
    const apiPatch = environmentPatch(envId);
    const importedBasics = {
      ...currentConfig.basics,
      ...(source.event || {}),
      slug: slugifyForClickBid(source.event?.slug || source.event?.name || currentConfig.basics.slug),
      contactPhone: digitsOnly(source.event?.contactPhone || currentConfig.basics.contactPhone),
    };
    const importedSchedule = normalizeEventSchedule(importedBasics);
    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        ...apiPatch,
        organizationId: currentConfig.api.organizationId,
        orgToken: currentConfig.api.orgToken,
        eventToken: currentConfig.api.eventToken,
        browser: currentConfig.api.browser,
        adminEmail: currentConfig.api.adminEmail,
        adminPassword: currentConfig.api.adminPassword,
        savedProfiles: currentConfig.api.savedProfiles,
        selectedProfileId: currentConfig.api.selectedProfileId,
        selectedProfileByEnv: currentConfig.api.selectedProfileByEnv,
        profileLabel: currentConfig.api.profileLabel,
      },
      basics: {
        ...importedBasics,
        ...importedSchedule,
      },
      bidders: normalizeBidderSection(source.bidders || currentConfig.bidders),
      items: normalizeItemSection(source.items || currentConfig.items),
      auctionSettings: normalizeAuctionSettings(source.auctionSettings || currentConfig.auctionSettings, normalizeBidderSection(source.bidders || currentConfig.bidders)),
      ticketPages: normalizeTicketPages(source.ticketPages || currentConfig.ticketPages),
      postCreateActivity: normalizePostCreateActivity(source.postCreateActivity || currentConfig.postCreateActivity, source.ticketPages || currentConfig.ticketPages),
    };
  }

  function exportPresetConfig(config, presetName = '') {
    return {
      version: LOCAL_PRESET_VERSION,
      kind: 'mkEventPreset',
      name: String(presetName || '').trim() || String(config?.basics?.name || 'Preset').trim() || 'Preset',
      recipe: exportRecipeConfig(config),
    };
  }

  function importPresetConfig(currentConfig, importedPreset) {
    const source = importedPreset?.recipe || importedPreset || {};
    const preservedBasics = {
      name: currentConfig?.basics?.name,
      slug: currentConfig?.basics?.slug,
      startDate: currentConfig?.basics?.startDate,
      startTime: currentConfig?.basics?.startTime,
      endDate: currentConfig?.basics?.endDate,
      endTime: currentConfig?.basics?.endTime,
      onCallDate: currentConfig?.basics?.onCallDate,
    };
    const preservedSchedule = normalizeEventSchedule(preservedBasics);
    const imported = importRecipeConfig(currentConfig, source);
    return {
      ...imported,
      basics: {
        ...imported.basics,
        ...preservedBasics,
        ...preservedSchedule,
      },
    };
  }

  function profileIdFor(env, organizationId) {
    const cleanEnv = String(env || '').trim() || 'stage';
    const cleanOrg = String(organizationId || '').trim();
    return cleanOrg ? `${cleanEnv}::${cleanOrg}` : '';
  }

  function normalizeSavedProfiles(source) {
    const input = source && typeof source === 'object' ? source : {};
    return Object.fromEntries(
      Object.entries(input)
        .map(([id, profile]) => {
          const env = ENVIRONMENTS[profile?.env] ? profile.env : null;
          const organizationId = String(profile?.organizationId || '').trim();
          if (!env || !organizationId) return null;
          return [String(id), {
            env,
            organizationId,
            label: String(profile?.label || '').trim(),
            orgToken: String(profile?.orgToken || ''),
            eventToken: String(profile?.eventToken || ''),
          }];
        })
        .filter(Boolean)
    );
  }

  function normalizeSelectedProfileMap(source) {
    const input = source && typeof source === 'object' ? source : {};
    return Object.fromEntries(
      Object.entries(input)
        .filter(([env, profileId]) => ENVIRONMENTS[env] && String(profileId || '').trim())
        .map(([env, profileId]) => [env, String(profileId)])
    );
  }

  function resolveSelectedProfile(profiles, selectedProfileByEnv, env) {
    const selectedId = String(selectedProfileByEnv?.[env] || '');
    const selected = profiles[selectedId];
    if (selected?.env === env) {
      return { selectedProfileId: selectedId, selectedProfile: selected };
    }

    const fallbackEntry = Object.entries(profiles).find(([, profile]) => profile?.env === env);
    if (!fallbackEntry) {
      return { selectedProfileId: '', selectedProfile: null };
    }

    return {
      selectedProfileId: fallbackEntry[0],
      selectedProfile: fallbackEntry[1],
    };
  }

  function exportLocalSettings(config) {
    return {
      version: LOCAL_SETTINGS_VERSION,
      globals: {
        browser: config.api.browser,
        adminEmail: config.api.adminEmail,
        adminPassword: config.api.adminPassword,
        proxyUrl: config.api.proxyUrl,
      },
      profiles: normalizeSavedProfiles(config.api.savedProfiles),
      selectedProfileByEnv: normalizeSelectedProfileMap(config.api.selectedProfileByEnv),
    };
  }

  function importLocalSettings(currentConfig, savedSettings) {
    const source = savedSettings || {};
    const legacyApi = source.api || {};

    if (!source.globals && !source.profiles) {
      const apiPatch = environmentPatch(legacyApi.env || currentConfig.api.env);
      const legacyProfileId = profileIdFor(apiPatch.env, legacyApi.organizationId || '');
      const legacyProfiles = legacyProfileId
        ? {
            [legacyProfileId]: {
              env: apiPatch.env,
              organizationId: String(legacyApi.organizationId || ''),
              label: '',
              orgToken: String(legacyApi.orgToken || ''),
              eventToken: String(legacyApi.eventToken || ''),
            },
          }
        : {};
      const selectedProfileByEnv = legacyProfileId ? { [apiPatch.env]: legacyProfileId } : {};
      return {
        ...currentConfig,
        api: {
          ...currentConfig.api,
          ...apiPatch,
          organizationId: legacyApi.organizationId || '',
          orgToken: legacyApi.orgToken || '',
          eventToken: legacyApi.eventToken || '',
          browser: legacyApi.browser || currentConfig.api.browser,
          adminEmail: legacyApi.adminEmail || '',
          adminPassword: legacyApi.adminPassword || '',
          proxyUrl: legacyApi.proxyUrl || currentConfig.api.proxyUrl,
          savedProfiles: legacyProfiles,
          selectedProfileId: legacyProfileId,
          selectedProfileByEnv,
          profileLabel: '',
        },
      };
    }

    const env = currentConfig.api.env || 'stage';
    const apiPatch = environmentPatch(env);
    const globals = source.globals || {};
    const profiles = normalizeSavedProfiles(source.profiles);
    const selectedProfileByEnv = normalizeSelectedProfileMap(source.selectedProfileByEnv);
    const { selectedProfileId, selectedProfile } = resolveSelectedProfile(profiles, selectedProfileByEnv, env);

    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        ...apiPatch,
        organizationId: selectedProfile?.organizationId || '',
        orgToken: selectedProfile?.orgToken || '',
        eventToken: selectedProfile?.eventToken || '',
        browser: globals.browser || currentConfig.api.browser,
        adminEmail: globals.adminEmail || '',
        adminPassword: globals.adminPassword || '',
        proxyUrl: globals.proxyUrl || currentConfig.api.proxyUrl,
        savedProfiles: profiles,
        selectedProfileId,
        selectedProfileByEnv: {
          ...selectedProfileByEnv,
          ...(selectedProfileId ? { [env]: selectedProfileId } : {}),
        },
        profileLabel: selectedProfile?.label || '',
      },
    };
  }

  function saveApiProfile(currentConfig) {
    const env = currentConfig?.api?.env || 'stage';
    const organizationId = String(currentConfig?.api?.organizationId || '').trim();
    const profileId = profileIdFor(env, organizationId);
    if (!profileId) return currentConfig;

    const nextProfiles = {
      ...normalizeSavedProfiles(currentConfig.api.savedProfiles),
      [profileId]: {
        env,
        organizationId,
        label: String(currentConfig?.api?.profileLabel || '').trim(),
        orgToken: String(currentConfig?.api?.orgToken || ''),
        eventToken: String(currentConfig?.api?.eventToken || ''),
      },
    };

    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        savedProfiles: nextProfiles,
        selectedProfileId: profileId,
        selectedProfileByEnv: {
          ...normalizeSelectedProfileMap(currentConfig.api.selectedProfileByEnv),
          [env]: profileId,
        },
      },
    };
  }

  function applyApiProfile(currentConfig, requestedProfileId) {
    const env = currentConfig?.api?.env || 'stage';
    const profiles = normalizeSavedProfiles(currentConfig.api.savedProfiles);
    const profileId = String(requestedProfileId || '');
    if (!profileId) {
      const nextSelectedByEnv = { ...normalizeSelectedProfileMap(currentConfig.api.selectedProfileByEnv) };
      delete nextSelectedByEnv[env];
      return {
        ...currentConfig,
        api: {
          ...currentConfig.api,
          organizationId: '',
          orgToken: '',
          eventToken: '',
          selectedProfileId: '',
          selectedProfileByEnv: nextSelectedByEnv,
          profileLabel: '',
        },
      };
    }
    const profile = profiles[profileId];
    if (!profile || profile.env !== env) return currentConfig;

    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        organizationId: profile.organizationId,
        orgToken: profile.orgToken,
        eventToken: profile.eventToken,
        selectedProfileId: profileId,
        selectedProfileByEnv: {
          ...normalizeSelectedProfileMap(currentConfig.api.selectedProfileByEnv),
          [env]: profileId,
        },
        profileLabel: profile.label || '',
      },
    };
  }

  function deleteApiProfile(currentConfig, requestedProfileId) {
    const env = currentConfig?.api?.env || 'stage';
    const profileId = String(requestedProfileId || currentConfig?.api?.selectedProfileId || '');
    if (!profileId) return currentConfig;
    const profiles = normalizeSavedProfiles(currentConfig.api.savedProfiles);
    const profile = profiles[profileId];
    if (!profile) return currentConfig;

    const nextProfiles = { ...profiles };
    delete nextProfiles[profileId];
    const nextSelectedByEnv = { ...normalizeSelectedProfileMap(currentConfig.api.selectedProfileByEnv) };
    if (nextSelectedByEnv[profile.env] === profileId) {
      delete nextSelectedByEnv[profile.env];
    }

    const clearingCurrent = currentConfig.api.selectedProfileId === profileId || currentConfig.api.organizationId === profile.organizationId;
    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        organizationId: clearingCurrent && profile.env === env ? '' : currentConfig.api.organizationId,
        orgToken: clearingCurrent && profile.env === env ? '' : currentConfig.api.orgToken,
        eventToken: clearingCurrent && profile.env === env ? '' : currentConfig.api.eventToken,
        selectedProfileId: clearingCurrent && profile.env === env ? '' : currentConfig.api.selectedProfileId,
        selectedProfileByEnv: nextSelectedByEnv,
        savedProfiles: nextProfiles,
        profileLabel: clearingCurrent && profile.env === env ? '' : currentConfig.api.profileLabel,
      },
    };
  }

  function summarizeRecipe(recipe) {
    const silent = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.silent).length;
    const live = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.live).length;
    const donation = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.donation).length;
    const quantity = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.quantity).length;
    const ticketPages = recipe.ticketPages || normalizeTicketPages();
    const postCreateActivity = recipe.postCreateActivity || normalizePostCreateActivity({}, ticketPages);
    const ticketSummary = ticketPages.pages.reduce((totals, page) => {
      totals.individualTickets += page.individualTickets.length;
      totals.sponsors += page.sponsors.length;
      totals.underwriting += page.underwriting.length;
      totals.selections += page.selections.length;
      const individualQuestions = page.individualTickets.reduce((count, ticket) => count + (ticket.customQuestions?.length || 0), 0);
      const sponsorQuestions = page.sponsors.reduce((count, sponsor) => count + (sponsor.customQuestions?.length || 0), 0);
      const underwritingQuestions = page.underwriting.reduce((count, item) => count + (item.customQuestions?.length || 0), 0);
      totals.customQuestions += individualQuestions + sponsorQuestions + underwritingQuestions + (page.pageCustomQuestions?.length || 0);
      return totals;
    }, { individualTickets: 0, sponsors: 0, underwriting: 0, selections: 0, customQuestions: 0 });
    return {
      eventName: recipe.event.name || 'Untitled event',
      environment: recipe.environment.id,
      bidderCount: recipe.bidders.count,
      itemCount: recipe.items.count,
      itemBreakdown: { silent, live, donation, quantity },
      ticketPages: {
        enabled: ticketPages.enabled,
        preset: ticketPages.preset,
        pageCount: ticketPages.enabled ? ticketPages.pages.length : 0,
        ...ticketSummary,
      },
      postCreateActivity: {
        enabled: postCreateActivity.enabled,
        ticketPurchasesEnabled: postCreateActivity.ticketPurchases.enabled,
        purchaseCount: postCreateActivity.enabled && postCreateActivity.ticketPurchases.enabled ? postCreateActivity.ticketPurchases.purchaseCount : 0,
        donationEnabled: postCreateActivity.enabled && postCreateActivity.ticketPurchases.addDonation,
        auctionBids: postCreateActivity.enabled && postCreateActivity.auctionActivity.enabled
          ? (postCreateActivity.auctionActivity.bidCount + postCreateActivity.auctionActivity.maxBidCount)
          : 0,
        directDonations: postCreateActivity.enabled && postCreateActivity.donationActivity.enabled
          ? postCreateActivity.donationActivity.donationCount
          : 0,
      },
      adminUrl: `${trimTrailingSlash(recipe.environment.baseUrl || recipe.environment.adminBaseUrl)}/events/${recipe.event.slug}`,
      publicUrl: buildPublicEventUrl(recipe.environment.baseUrl || recipe.environment.publicBaseUrl, recipe.event.slug),
    };
  }

  function apiProxyCall(proxyUrl, targetUrl, method, headers, body) {
    const payload = { url: targetUrl, method: method || 'GET', headers: headers || {} };
    if (body !== undefined && body !== null) {
      payload.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async resp => {
      let data;
      try {
        data = await resp.json();
      } catch (_) {
        data = { error: 'proxy_invalid_json', message: await resp.text().catch(() => '') };
      }

      if (data && typeof data === 'object' && Object.hasOwn(data, 'status') && Object.hasOwn(data, 'body')) {
        return data;
      }

      return {
        status: resp.status,
        headers: {},
        body: typeof data === 'string' ? data : JSON.stringify(data || {}),
      };
    });
  }

  async function validateEventSlugAvailability(apiConfig, slug) {
    const candidateSlug = String(slug || '').trim();
    const syntaxErrors = validateSlug(candidateSlug);
    if (syntaxErrors.length > 0) {
      return {
        ok: false,
        slug: candidateSlug,
        isValid: false,
        reason: syntaxErrors.join(' '),
        source: 'local',
      };
    }

    const apiBaseUrl = apiConfig?.apiBaseUrl || apiBaseUrlFrom(apiConfig?.baseUrl);
    const targetUrl = `${String(apiBaseUrl || '').replace(/\/$/, '')}/organizations/${apiConfig?.organizationId}/validate-event-slug`;
    const result = await apiProxyCall(
      apiConfig?.proxyUrl,
      targetUrl,
      'POST',
      {
        Authorization: `Bearer ${apiConfig?.orgToken || ''}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      { slug: candidateSlug },
    );

    let body = {};
    try {
      body = JSON.parse(result.body || '{}');
    } catch (_) {
      body = {};
    }

    if (result.status >= 200 && result.status < 300) {
      return {
        ok: true,
        slug: candidateSlug,
        isValid: Boolean(body?.is_valid),
        reason: body?.is_valid ? '' : 'Keyword is already in use.',
        source: 'remote',
        raw: body,
      };
    }

    throw new Error(body?.message || body?.error || `HTTP ${result.status}`);
  }

  function proxyToolUrl(proxyUrl, suffix) {
    const base = String(proxyUrl || '').replace(/\/proxy\/?$/, '');
    return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  }

  async function browserFallbackCreateEvent(proxyUrl, payload) {
    const response = await fetch(proxyToolUrl(proxyUrl, '/fallback/create-event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    let data;
    try {
      data = await response.json();
    } catch (_) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Browser fallback failed with HTTP ${response.status}`);
    }

    if (response.ok && data?.ok) {
      return data;
    }

    throw new Error(data?.message || data?.error || `Browser fallback failed with HTTP ${response.status}`);
  }

  async function browserFallbackApplyPostItemConfig(proxyUrl, payload) {
    const response = await fetch(proxyToolUrl(proxyUrl, '/fallback/post-item-config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    let data;
    try {
      data = await response.json();
    } catch (_) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Browser fallback post-item config failed with HTTP ${response.status}`);
    }

    if (response.ok && data?.ok) {
      return data;
    }

    throw new Error(data?.message || data?.error || `Browser fallback post-item config failed with HTTP ${response.status}`);
  }

  async function browserFallbackApplyPostCreateActivity(proxyUrl, payload) {
    const response = await fetch(proxyToolUrl(proxyUrl, '/fallback/post-create-activity'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    let data;
    try {
      data = await response.json();
    } catch (_) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Browser fallback post-create activity failed with HTTP ${response.status}`);
    }

    if (response.ok && data?.ok) {
      return data;
    }

    throw new Error(data?.message || data?.error || `Browser fallback post-create activity failed with HTTP ${response.status}`);
  }

  return {
    DEFAULT_CONFIG,
    ENVIRONMENTS,
    ITEM_TYPE_IDS,
    ITEM_TYPE_OPTIONS,
    LOCAL_SETTINGS_KEY_PREFIX,
    LOCAL_SETTINGS_VERSION,
    LOCAL_PRESET_LIBRARY_KEY,
    LOCAL_PRESET_VERSION,
    RECIPE_VERSION,
    apiBaseUrlFrom,
    apiProxyCall,
    browserFallbackApplyPostItemConfig,
    browserFallbackApplyPostCreateActivity,
    browserFallbackCreateEvent,
    buildPublicEventUrl,
    buildRecipe,
    environmentPatch,
    applyApiProfile,
    deleteApiProfile,
    exportLocalSettings,
    exportPresetConfig,
    exportRecipeConfig,
    generateBidders,
    generateItems,
    importLocalSettings,
    importPresetConfig,
    importRecipeConfig,
    normalizeAuctionSettings,
    normalizeItemSection,
    normalizePostCreateActivity,
    normalizeTicketPages,
    pruneTicketPageItemSelections,
    findUnsupportedTicketPurchasePayments,
    proxyToolUrl,
    randomEventName,
    resolveTicketPurchasePaymentSupport,
    serializeQuantityTiers,
    saveApiProfile,
    slugifyForClickBid,
    summarizeRecipe,
    todayDateOnly,
    validateEventSlugAvailability,
    validateSlug,
  };
});
