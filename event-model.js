(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EventModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ITEM_TYPE_IDS = Object.freeze({
    silent: 10,
    live: 20,
    donation: 30,
  });

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

  function environmentPatch(env) {
    const key = ENVIRONMENTS[env] ? env : 'dev2';
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
  const LOCAL_SETTINGS_VERSION = 1;
  const LOCAL_SETTINGS_STORAGE_KEY = 'mkEvent.localSettings.v1';

  const DEFAULT_CONFIG = Object.freeze({
    api: {
      env: 'dev2',
      environmentLabel: 'Dev 2',
      baseUrl: 'https://cbodev2.com',
      apiBaseUrl: 'https://cbodev2.com/api/v4',
      adminBaseUrl: 'https://cbodev2.com',
      publicBaseUrl: 'https://cbodev2.com',
      organizationId: '',
      orgToken: '',
      eventToken: '',
      browser: 'chromium',
      proxyUrl: 'http://localhost:9999/proxy',
    },
    basics: {
      name: 'QA Event',
      slug: 'qa-event',
      startDate: '',
      startTime: '09:00',
      endDate: '',
      endTime: '17:00',
      timezone: 'America/New_York',
    },
    bidders: {
      count: 5,
      startNum: 100,
      firstNamePrefix: 'QA',
      lastNamePrefix: 'Bidder',
      emailPrefix: 'qa-bidder',
      emailDomain: 'example.test',
      acceptTexts: false,
      addPhones: false,
    },
    items: {
      silentCount: 5,
      liveCount: 0,
      donationCount: 0,
      startNum: 1,
      namePrefix: 'QA Item',
      startingBid: 25,
      bidIncrement: 5,
      fairMarketValue: 100,
      reserveAmount: 0,
      statusId: 1,
    },
  });

  function pad(num, width = 3) {
    return String(num).padStart(width, '0');
  }

  function clampString(value, max) {
    return String(value || '').slice(0, max);
  }

  function slugifyForClickBid(value) {
    let slug = String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!/[a-z]/.test(slug)) slug = `event-${slug || 'qa'}`;
    if (slug.length < 3) slug = `${slug}-event`;
    return slug.slice(0, 50).replace(/-$/g, '');
  }

  function validateSlug(slug) {
    const errors = [];
    const value = String(slug || '');
    if (value.length < 3) errors.push('Keyword must be at least 3 characters.');
    if (value.length > 50) errors.push('Keyword must be 50 characters or less.');
    if (!/[a-zA-Z]/.test(value)) errors.push('Keyword must contain at least one letter.');
    if (!/^[a-z0-9-]+$/.test(value)) errors.push('Keyword may contain only lowercase letters, numbers, and dashes.');
    return errors;
  }

  function generateBidders(config) {
    const count = Math.max(0, Number(config.count) || 0);
    const startNum = Number(config.startNum) || 1;
    const firstNamePrefix = clampString(config.firstNamePrefix || 'QA', 20);
    const lastNamePrefix = clampString(config.lastNamePrefix || 'Bidder', 28);
    const emailPrefix = String(config.emailPrefix || 'qa-bidder').toLowerCase();
    const emailDomain = String(config.emailDomain || 'example.test').toLowerCase();

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

  function itemRecord({ type, itemNumber, sequence, config }) {
    const isDonation = type === 'donation';
    const label = type === 'silent' ? 'Silent' : type === 'live' ? 'Live' : 'Donation';
    return {
      item_number: itemNumber,
      item_name: clampString(`${config.namePrefix || 'QA Item'} ${label} ${pad(sequence)}`, 250),
      item_type_id: ITEM_TYPE_IDS[type],
      status_id: Number(config.statusId) || 1,
      starting_bid: isDonation ? 0 : Number(config.startingBid) || 0,
      bid_increment: isDonation ? 0 : Number(config.bidIncrement) || 0,
      fair_market_value: Number(config.fairMarketValue) || 0,
      reserve_amount: Math.min(Number(config.reserveAmount) || 0, 99999999),
    };
  }

  function generateItems(config) {
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
    return rows;
  }

  function buildRecipe(config) {
    const safeSlug = slugifyForClickBid(config.basics.slug || config.basics.name);
    const bidders = generateBidders(config.bidders);
    const items = generateItems(config.items);
    const envKey = ENVIRONMENTS[config.api.env] ? config.api.env : 'dev2';
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
        startDate: config.basics.startDate,
        startTime: config.basics.startTime,
        endDate: config.basics.endDate,
        endTime: config.basics.endTime,
        timezone: config.basics.timezone,
      },
      bidders: {
        count: bidders.length,
        records: bidders,
      },
      items: {
        count: items.length,
        records: items,
      },
      customerFacingPages: 'use-clickbid-defaults',
    };
  }

  function exportRecipeConfig(config) {
    return {
      version: RECIPE_VERSION,
      environment: {
        id: config.api.env,
      },
      event: {
        name: config.basics.name,
        slug: slugifyForClickBid(config.basics.slug || config.basics.name),
        startDate: config.basics.startDate,
        startTime: config.basics.startTime,
        endDate: config.basics.endDate,
        endTime: config.basics.endTime,
        timezone: config.basics.timezone,
      },
      bidders: { ...config.bidders },
      items: { ...config.items },
    };
  }

  function importRecipeConfig(currentConfig, importedRecipe) {
    const source = importedRecipe || {};
    const envId = source.environment?.id || source.environment || currentConfig.api.env;
    const apiPatch = environmentPatch(envId);
    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        ...apiPatch,
        organizationId: currentConfig.api.organizationId,
        orgToken: currentConfig.api.orgToken,
        eventToken: currentConfig.api.eventToken,
        browser: currentConfig.api.browser,
      },
      basics: {
        ...currentConfig.basics,
        ...(source.event || {}),
        slug: slugifyForClickBid(source.event?.slug || source.event?.name || currentConfig.basics.slug),
      },
      bidders: {
        ...currentConfig.bidders,
        ...(source.bidders || {}),
      },
      items: {
        ...currentConfig.items,
        ...(source.items || {}),
      },
    };
  }

  function exportLocalSettings(config) {
    return {
      version: LOCAL_SETTINGS_VERSION,
      api: {
        env: config.api.env,
        organizationId: config.api.organizationId,
        orgToken: config.api.orgToken,
        eventToken: config.api.eventToken,
        browser: config.api.browser,
        proxyUrl: config.api.proxyUrl,
      },
    };
  }

  function importLocalSettings(currentConfig, savedSettings) {
    const source = savedSettings || {};
    const savedApi = source.api || {};
    const apiPatch = environmentPatch(savedApi.env || currentConfig.api.env);
    return {
      ...currentConfig,
      api: {
        ...currentConfig.api,
        ...apiPatch,
        organizationId: savedApi.organizationId || '',
        orgToken: savedApi.orgToken || '',
        eventToken: savedApi.eventToken || '',
        browser: savedApi.browser || currentConfig.api.browser,
        proxyUrl: savedApi.proxyUrl || currentConfig.api.proxyUrl,
      },
    };
  }

  function summarizeRecipe(recipe) {
    const silent = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.silent).length;
    const live = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.live).length;
    const donation = recipe.items.records.filter((item) => item.item_type_id === ITEM_TYPE_IDS.donation).length;
    return {
      eventName: recipe.event.name || 'Untitled event',
      environment: recipe.environment.id,
      bidderCount: recipe.bidders.count,
      itemCount: recipe.items.count,
      itemBreakdown: { silent, live, donation },
      adminUrl: `${trimTrailingSlash(recipe.environment.baseUrl || recipe.environment.adminBaseUrl)}/events/${recipe.event.slug}`,
      publicUrl: `${trimTrailingSlash(recipe.environment.baseUrl || recipe.environment.publicBaseUrl)}/${recipe.event.slug}`,
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
    }).then(resp => resp.json());
  }

  return {
    DEFAULT_CONFIG,
    ENVIRONMENTS,
    ITEM_TYPE_IDS,
    LOCAL_SETTINGS_STORAGE_KEY,
    LOCAL_SETTINGS_VERSION,
    RECIPE_VERSION,
    apiBaseUrlFrom,
    apiProxyCall,
    buildRecipe,
    environmentPatch,
    exportLocalSettings,
    exportRecipeConfig,
    importLocalSettings,
    importRecipeConfig,
    generateBidders,
    generateItems,
    slugifyForClickBid,
    summarizeRecipe,
    validateSlug,
  };
});
