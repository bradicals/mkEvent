// Creation Engine — API-first ClickBid V4 adapters for the QA event creator.
// Each adapter wraps the ApiClient and reports progress through structured callbacks.
// Works in browser (window.CreationEngine) and Node (module.exports).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CreationEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MODEL = (typeof window !== 'undefined' ? window : globalThis).EventModel;
  const DEFAULT_EVENT_BIDDER_COUNT = 1;
  const DEFAULT_EVENT_ITEM_COUNT = 7;
  const HOSTED_EVENT_ROUTE_CACHE_PREFIX = 'mkEvent.hostedEventCreateRoute.';
  const hostedEventRouteCache = new Map();

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function countCollection(value) {
    return Array.isArray(value) ? value.length : 0;
  }

  function hostedEventRouteCacheKey(recipe) {
    return [
      HOSTED_EVENT_ROUTE_CACHE_PREFIX,
      recipe?.environment?.id || '',
      recipe?.environment?.apiBaseUrl || '',
      recipe?.environment?.organizationId || '',
    ].join('|');
  }

  function getStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {
      return null;
    }
    return null;
  }

  function getHostedEventRouteStatus(recipe) {
    const key = hostedEventRouteCacheKey(recipe);
    if (hostedEventRouteCache.has(key)) return hostedEventRouteCache.get(key);
    const storage = getStorage();
    if (!storage) return null;
    const value = storage.getItem(key);
    if (!value) return null;
    hostedEventRouteCache.set(key, value);
    return value;
  }

  function setHostedEventRouteStatus(recipe, status) {
    const key = hostedEventRouteCacheKey(recipe);
    if (!status) {
      hostedEventRouteCache.delete(key);
      const storage = getStorage();
      if (storage) storage.removeItem(key);
      return;
    }
    hostedEventRouteCache.set(key, status);
    const storage = getStorage();
    if (storage) storage.setItem(key, status);
  }

  // ── ApiClient ────────────────────────────────────────────────────────

  class ClickBidApiClient {
    /**
     * @param {object} opts
     * @param {string} opts.apiBaseUrl   e.g. https://cbodev2.com/api/v4
     * @param {string} opts.orgToken     Bearer token (organization scope)
     * @param {string} opts.proxyUrl     local proxy for CORS
     */
    constructor(opts) {
      this.apiBaseUrl = String(opts.apiBaseUrl || '').replace(/\/$/, '');
      this.orgToken = opts.orgToken || '';
      this.proxyUrl = opts.proxyUrl || 'http://localhost:9999/proxy';
    }

    /**
     * Make an API call through the local CORS proxy.
     * @returns {Promise<object>} parsed JSON response body
     * @throws {Error} on non-2xx status or proxy failure
     */
    async request(method, path, body) {
      const url = `${this.apiBaseUrl}${path}`;
      const headers = {
        Authorization: `Bearer ${this.orgToken}`,
        Accept: 'application/json',
      };
      if (body !== undefined && body !== null) {
        headers['Content-Type'] = 'application/json';
      }

      const result = await MODEL.apiProxyCall(
        this.proxyUrl,
        url,
        method,
        headers,
        body,
      );

      if (result.status >= 200 && result.status < 300) {
        try {
          return JSON.parse(result.body);
        } catch (_) {
          return result.body;
        }
      }

      const responseHeaders = result.headers && typeof result.headers === 'object' ? result.headers : {};
      const headerRedirectLocation =
        responseHeaders.location ||
        responseHeaders.Location ||
        responseHeaders.LOCATION ||
        null;

      const bodyText = String(result.body || '');
      const htmlRedirectMatch = bodyText.match(/href=["']([^"']+)["']/i);
      const redirectLocation = headerRedirectLocation || htmlRedirectMatch?.[1] || null;

      let message;
      try {
        const errBody = JSON.parse(bodyText);
        message = errBody.message || errBody.error || `HTTP ${result.status}`;
      } catch (_) {
        if (redirectLocation && result.status >= 300 && result.status < 400) {
          message = `HTTP ${result.status} redirect`;
        } else {
          message = bodyText.slice(0, 200) || `HTTP ${result.status}`;
        }
      }

      if (redirectLocation) {
        message = `${message} (redirect location: ${redirectLocation})`;
      }

      throw new Error(message);
    }

    get(path) { return this.request('GET', path); }
    post(path, body) { return this.request('POST', path, body); }
  }

  // ── ProgressReporter ──────────────────────────────────────────────────

  class ProgressReporter {
    /**
     * @param {object} callbacks
     * @param {function} callbacks.onLog      ({ kind, tag, msg }) => void
     * @param {function} callbacks.onProgress (percent: number) => void
     */
    constructor(callbacks) {
      this.cb = callbacks || {};
    }

    log(kind, tag, msg) {
      if (typeof this.cb.onLog === 'function') this.cb.onLog({ kind, tag, msg });
    }
    info(tag, msg) {
      this.log('info', tag, msg);
    }
    run(tag, msg) {
      this.log('run', tag, msg);
    }
    ok(tag, msg) {
      this.log('ok', tag, msg);
    }
    error(tag, msg) {
      this.log('error', tag, msg);
    }
    warn(tag, msg) {
      this.log('warn', tag, msg);
    }
    progress(pct) {
      if (typeof this.cb.onProgress === 'function') this.cb.onProgress(pct);
    }
  }

  // ── EventAdapter ─────────────────────────────────────────────────────

  class EventAdapter {
    /**
     * @param {ClickBidApiClient} client
     * @param {ProgressReporter} progress
     */
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    /**
     * Create an event through the organization-scoped events endpoint.
     * @param {object} recipe   recipe.environment, recipe.event
     * @returns {Promise<object>} created event response
     */
    async create(recipe) {
      const org = recipe.environment.organizationId;
      const { event } = recipe;

      this.progress.run('event', `Creating event "${event.name}"…`);

      const payload = {
        slug: event.slug,
        auction_start: event.startDate,
        event_closing: event.endDate,
        on_call: event.onCallDate || event.endDate || event.startDate,
        timezone: event.timezone,
        event_name: event.name,
        first_name: event.contactFirstName,
        last_name: event.contactLastName,
        email: event.contactEmail,
        phone: digitsOnly(event.contactPhone),
      };

      const created = await this.client.post(`/organizations/${org}/events`, payload);

      const id = created.id || created.data?.id;
      if (!id) {
        throw new Error('Event creation response did not include an event ID.');
      }
      this.progress.ok('event', `Created: event.id=${id}, keyword=${event.slug}`);

      return { created, id };
    }
  }

  class BrowserFallbackAdapter {
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    async create(config, recipe, originalError) {
      const missing = [];
      if (!config.api.adminEmail) missing.push('admin login email');
      if (!config.api.adminPassword) missing.push('admin password');
      this.progress.info('event', `Hosted API rejected org-scoped event creation for org ${recipe.environment.organizationId}: ${originalError.message}`);

      if (missing.length) {
        this.progress.error('event', `Browser fallback blocked before launch: missing ${missing.join(' and ')} in Settings.`);
        this.progress.info('event', 'No browser session was launched. Fill the admin credential fields in Settings to allow fallback.');
        throw new Error(`${originalError.message} Browser fallback requires admin login email and password in Settings.`);
      }

      this.progress.info('event', `Browser fallback preflight OK: proxy=${config.api.proxyUrl}, browser=${config.api.browser}, target=${recipe.environment.baseUrl}`);
      this.progress.info('event', `Hosted API create route is unavailable; switching to ${config.api.browser} admin UI fallback…`);
      const fallbackResult = await MODEL.browserFallbackCreateEvent(config.api.proxyUrl, {
        baseUrl: recipe.environment.baseUrl,
        organizationId: recipe.environment.organizationId,
        browser: config.api.browser,
        adminEmail: config.api.adminEmail,
        adminPassword: config.api.adminPassword,
        event: {
          slug: recipe.event.slug,
          name: recipe.event.name,
          startDate: recipe.event.startDate,
          endDate: recipe.event.endDate,
          onCallDate: recipe.event.onCallDate || recipe.event.endDate || recipe.event.startDate,
          timezone: recipe.event.timezone,
          contactFirstName: recipe.event.contactFirstName,
          contactLastName: recipe.event.contactLastName,
          contactEmail: recipe.event.contactEmail,
          contactPhone: digitsOnly(recipe.event.contactPhone),
        },
        auctionSettings: recipe.auctionSettings,
        ticketPages: recipe.ticketPages,
        postCreateActivity: recipe.postCreateActivity,
      });

      if (fallbackResult.auctionSettings) {
        const appliedCount = fallbackResult.auctionSettings.applied?.length || 0;
        const skippedCount = fallbackResult.auctionSettings.skipped?.length || 0;
        const warningCount = fallbackResult.auctionSettings.warnings?.length || 0;
        this.progress.info('settings', `Browser fallback auction settings: ${appliedCount} applied, ${skippedCount} skipped, ${warningCount} warnings.`);
      }
      if (fallbackResult.ticketPages) {
        const appliedCount = fallbackResult.ticketPages.applied?.length || 0;
        const skippedCount = fallbackResult.ticketPages.skipped?.length || 0;
        const warningCount = fallbackResult.ticketPages.warnings?.length || 0;
        this.progress.info('ticket-pages', `Browser fallback ticket pages: ${appliedCount} applied, ${skippedCount} skipped, ${warningCount} warnings.`);
      }
      // The AJAX fallback returns eventId directly — use it.
      // Fall back to slug resolution only if the AJAX didn't return an ID.
      let eventId = fallbackResult.eventId;
      if (!eventId) {
        this.progress.info('event', 'Fallback did not return an event ID — resolving from organization events list…');
        const resolved = await this.resolveEventBySlug(recipe.environment.organizationId, recipe.event.slug);
        eventId = resolved.id;
      }
      this.progress.ok('event', `Browser fallback created event.id=${eventId}, keyword=${recipe.event.slug}`);
      return {
        created: fallbackResult,
        id: eventId,
        adminUrl: fallbackResult.adminUrl || `${recipe.environment.baseUrl}/events/${recipe.event.slug}`,
        publicUrl: fallbackResult.publicUrl || MODEL.buildPublicEventUrl(recipe.environment.baseUrl, recipe.event.slug),
      };
    }

    async resolveEventBySlug(orgId, slug) {
      this.progress.run('event', 'Resolving browser-created event ID from organization events list…');
      const response = await this.client.get(`/organizations/${orgId}/events?per_page=100`);
      const items = extractResourceItems(response);
      const match = items.find((item) => String(item.slug || '').toLowerCase() === String(slug || '').toLowerCase());
      if (!match?.id) {
        throw new Error(`Browser fallback created the event, but mkEvent could not resolve event ID for slug ${slug}.`);
      }
      return match;
    }
  }

  function extractResourceItems(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.data?.data)) return response.data.data;
    if (Array.isArray(response?.items)) return response.items;
    return [];
  }

  function shouldUseBrowserFallback(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('unrecognized endpoint of organizations/') && message.includes('/events');
  }

  function shouldPreferBrowserFallback(recipe) {
    return recipe?.environment?.id === 'stage';
  }

  async function tryHttpCreate(config, recipe, progress) {
    if (recipe.auctionSettings?.enabled || recipe.ticketPages?.enabled) return null; // browser bundles those
    if (!config.api.adminEmail || !config.api.adminPassword) return null;
    progress.info('event', 'Trying HTTP admin create (no browser)…');
    const r = await MODEL.httpCreateEvent(config.api.proxyUrl, {
      baseUrl: recipe.environment.baseUrl, organizationId: recipe.environment.organizationId,
      adminEmail: config.api.adminEmail, adminPassword: config.api.adminPassword,
      event: { slug: recipe.event.slug, name: recipe.event.name, startDate: recipe.event.startDate, endDate: recipe.event.endDate, onCallDate: recipe.event.onCallDate || recipe.event.endDate || recipe.event.startDate, timezone: recipe.event.timezone, contactFirstName: recipe.event.contactFirstName, contactLastName: recipe.event.contactLastName, contactEmail: recipe.event.contactEmail, contactPhone: digitsOnly(recipe.event.contactPhone) },
    });
    progress.ok('event', `HTTP admin created event.id=${r.eventId}, keyword=${recipe.event.slug}`);
    return { created: r, id: r.eventId, adminUrl: r.adminUrl, publicUrl: MODEL.buildPublicEventUrl(recipe.environment.baseUrl, recipe.event.slug) };
  }

  function extractCreatedResourceId(response) {
    if (!response || typeof response !== 'object') return null;
    return response.id || response.data?.id || response.item?.id || response.item_id || null;
  }

  // Pull the single created record object out of a create-endpoint response, so
  // we can reuse what the POST already returned instead of re-fetching the list.
  function extractCreatedRecord(response) {
    if (!response || typeof response !== 'object') return null;
    if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) return response.data;
    if (response.item && typeof response.item === 'object') return response.item;
    return extractCreatedResourceId(response) ? response : null;
  }

  function hasTicketPageItemAttachments(ticketPages) {
    const pages = Array.isArray(ticketPages?.pages) ? ticketPages.pages : [];
    return pages.some((page) =>
      (Array.isArray(page?.quantityItemBulkIndexes) && page.quantityItemBulkIndexes.length > 0)
      || (Array.isArray(page?.quantityItemExactIndexes) && page.quantityItemExactIndexes.length > 0)
      || (Array.isArray(page?.donationItemBulkIndexes) && page.donationItemBulkIndexes.length > 0)
      || (Array.isArray(page?.donationItemExactIndexes) && page.donationItemExactIndexes.length > 0)
    );
  }

  function buildCreatedTypedItems(recipe, exactItemResults, createdItemsByNumber = new Map(), bulkKey, exactKey) {
    const bulkItems = Array.isArray(recipe?.items?.[bulkKey]) ? recipe.items[bulkKey] : [];
    const exactItems = Array.isArray(recipe?.items?.[exactKey]) ? recipe.items[exactKey] : [];
    return [
      ...bulkItems.flatMap((item) => {
        const created = createdItemsByNumber.get(String(item.item_number || ''));
        const createdId = extractCreatedResourceId(created);
        if (!createdId) return [];
        return [{
          source: 'bulk',
          bulkIndex: item.bulkIndex,
          id: String(createdId),
          item_number: item.item_number,
          item_name: item.item_name,
          qty: item.qty,
          quantity_tiers: Array.isArray(item.quantity_tiers) ? item.quantity_tiers : [],
        }];
      }),
      ...exactItems.flatMap((item) => {
      const created = exactItemResults[item.exactIndex];
      const createdId = extractCreatedResourceId(created);
      if (!createdId) return [];
      return [{
        source: 'exact',
        exactIndex: item.exactIndex,
        id: String(createdId),
        item_number: item.item_number,
        item_name: item.item_name,
        qty: item.qty,
        quantity_tiers: Array.isArray(item.quantity_tiers) ? item.quantity_tiers : [],
      }];
      }),
    ];
  }

  function buildCreatedQuantityItems(recipe, exactItemResults, createdItemsByNumber = new Map()) {
    return buildCreatedTypedItems(recipe, exactItemResults, createdItemsByNumber, 'bulkQuantityItems', 'exactQuantityItems');
  }

  function buildCreatedDonationItems(recipe, exactItemResults, createdItemsByNumber = new Map()) {
    return buildCreatedTypedItems(recipe, exactItemResults, createdItemsByNumber, 'bulkDonationItems', 'exactDonationItems');
  }

  class BrowserPostItemConfigAdapter {
    constructor(progress) {
      this.progress = progress;
    }

    async apply(config, recipe, eventId, createdQuantityItems, createdDonationItems) {
      const fallbackResult = await MODEL.browserFallbackApplyPostItemConfig(config.api.proxyUrl, {
        baseUrl: recipe.environment.baseUrl,
        organizationId: recipe.environment.organizationId,
        browser: config.api.browser,
        adminEmail: config.api.adminEmail,
        adminPassword: config.api.adminPassword,
        eventId,
        quantityItems: createdQuantityItems,
        donationItems: createdDonationItems,
        ticketPages: recipe.ticketPages,
      });

      const result = fallbackResult.postItemConfig || fallbackResult;
      const appliedCount = result.applied?.length || 0;
      const skippedCount = result.skipped?.length || 0;
      const warningCount = result.warnings?.length || 0;
      this.progress.info('ticket-pages', `Browser post-item ticket-page item config: ${appliedCount} applied, ${skippedCount} skipped, ${warningCount} warnings.`);
      const pciLabel = (e) => [e.section, e.formName, e.target, e.feature, e.name].filter(Boolean).join(' · ');
      (result.warnings || []).forEach((w) => this.progress.warn('ticket-pages', `⚠ ${pciLabel(w)}${pciLabel(w) ? ': ' : ''}${w.message || 'unspecified warning'}`));
      return result;
    }
  }

  class BrowserPostCreateActivityAdapter {
    constructor(progress) {
      this.progress = progress;
    }

    async apply(config, recipe, eventId, bidders, items) {
      const fallbackResult = await MODEL.browserFallbackApplyPostCreateActivity(config.api.proxyUrl, {
        baseUrl: recipe.environment.baseUrl,
        organizationId: recipe.environment.organizationId,
        browser: config.api.browser,
        adminEmail: config.api.adminEmail,
        adminPassword: config.api.adminPassword,
        eventId,
        eventSlug: recipe.event.slug,
        ticketPages: recipe.ticketPages,
        postCreateActivity: recipe.postCreateActivity,
        bidders,
        items,
      });

      const result = fallbackResult.postCreateActivity || fallbackResult;
      const appliedCount = result.applied?.length || 0;
      const skippedCount = result.skipped?.length || 0;
      const warningCount = result.warnings?.length || 0;
      this.progress.info('post-create', `Browser post-create activity: ${appliedCount} applied, ${skippedCount} skipped, ${warningCount} warnings.`);
      const pcaLabel = (e) => [e.section, e.formName, e.target, e.bidder, e.item, e.name].filter(Boolean).join(' · ');
      (result.warnings || []).forEach((w) => this.progress.warn('post-create', `⚠ ${pcaLabel(w)}${pcaLabel(w) ? ': ' : ''}${w.message || 'unspecified warning'}`));
      (result.skipped || []).forEach((s) => this.progress.info('post-create', `↷ skipped ${pcaLabel(s)}${pcaLabel(s) ? ': ' : ''}${s.reason || ''}`));
      return result;
    }
  }

  // ── BidderAdapter ────────────────────────────────────────────────────

  class BidderAdapter {
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    async createBulk(eventId, bidders) {
      const count = bidders.length;
      this.progress.run('bidders', `Creating ${count} bulk bidders…`);
      const created = await this.client.post(`/events/${eventId}/bidders/bulk`, { bidders });
      this.progress.ok('bidders', `${count} bulk bidders created`);
      return created;
    }

    async createOne(eventId, bidder, index, total) {
      const originalNumber = bidder.bidder_number;
      const label = originalNumber || `${index + 1}/${total}`;
      this.progress.run('bidders', `Creating exact bidder ${label}…`);
      try {
        const created = await this.client.post(`/events/${eventId}/bidders`, bidder);
        this.progress.ok('bidders', `Exact bidder created (${label})`);
        return created;
      } catch (err) {
        if (!err.message.includes('bidder number has already been taken')) throw err;
        // Bidder number collision — try the next few numbers before giving up
        const maxAttempts = 20;
        for (let offset = 1; offset <= maxAttempts; offset++) {
          const nextNumber = Number(originalNumber) + offset;
          this.progress.info('bidders', `Bidder number ${originalNumber} taken — trying ${nextNumber}…`);
          try {
            const created = await this.client.post(`/events/${eventId}/bidders`, {
              ...bidder,
              bidder_number: nextNumber,
            });
            this.progress.warn('bidders', `Exact bidder created with adjusted number: ${originalNumber} → ${nextNumber}`);
            return created;
          } catch (retryErr) {
            if (!retryErr.message.includes('bidder number has already been taken')) throw retryErr;
            // still taken, keep trying
          }
        }
        throw new Error(`Bidder number ${originalNumber} and the next ${maxAttempts} numbers are all taken.`);
      }
    }
  }

  // ── ItemAdapter ──────────────────────────────────────────────────────

  class ItemAdapter {
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    async createBulk(eventId, items) {
      const count = items.length;
      this.progress.run('items', `Creating ${count} bulk items…`);
      const created = await this.client.post(`/events/${eventId}/items/bulk`, { items });
      this.progress.ok('items', `${count} bulk items created`);
      return created;
    }

    async createOne(eventId, item, index, total) {
      const originalNumber = item.item_number;
      const label = originalNumber || `${index + 1}/${total}`;
      this.progress.run('items', `Creating exact item ${label}…`);
      try {
        const created = await this.client.post(`/events/${eventId}/items`, item);
        this.progress.ok('items', `Exact item created (${label})`);
        return created;
      } catch (err) {
        if (!err.message.includes('item number has already been taken')) throw err;
        const maxAttempts = 20;
        for (let offset = 1; offset <= maxAttempts; offset++) {
          const nextNumber = Number(originalNumber) + offset;
          this.progress.info('items', `Item number ${originalNumber} taken — trying ${nextNumber}…`);
          try {
            const created = await this.client.post(`/events/${eventId}/items`, {
              ...item,
              item_number: nextNumber,
            });
            this.progress.warn('items', `Exact item created with adjusted number: ${originalNumber} → ${nextNumber}`);
            return created;
          } catch (retryErr) {
            if (!retryErr.message.includes('item number has already been taken')) throw retryErr;
          }
        }
        throw new Error(`Item number ${originalNumber} and the next ${maxAttempts} numbers are all taken.`);
      }
    }
  }

  // ── Orchestrator ─────────────────────────────────────────────────────

  /**
   * Full event-creation pipeline: event → bidders → items → verify.
   * @param {object} config     full mkEvent config (config.api has credentials)
   * @param {object} recipe     output of EventModel.buildRecipe(config)
   * @param {object} callbacks  { onLog, onProgress }
   * @returns {Promise<object>} { eventId, adminUrl, publicUrl, ... }
   */
  async function createEvent(config, recipe, callbacks) {
    const progress = new ProgressReporter(callbacks);
    const client = new ClickBidApiClient({
      apiBaseUrl: recipe.environment.apiBaseUrl,
      orgToken: config.api.orgToken,
      proxyUrl: config.api.proxyUrl,
    });

    progress.info('init', `Environment: ${recipe.environment.id} (${recipe.environment.apiBaseUrl})`);
    progress.info('init', `Organization: ${recipe.environment.organizationId}`);
    progress.progress(5);

    const bidderAdapter = new BidderAdapter(client, progress);
    const itemAdapter = new ItemAdapter(client, progress);

    progress.run('event', `Validating keyword "${recipe.event.slug}"…`);
    const slugAvailability = await MODEL.validateEventSlugAvailability(config.api, recipe.event.slug);
    if (!slugAvailability.isValid) {
      const reason = slugAvailability.reason || `Event keyword already in use: ${recipe.event.slug}`;
      progress.error('event', `Keyword unavailable: ${reason}`);
      throw new Error(reason);
    }
    progress.ok('event', `Keyword available: ${recipe.event.slug}`);

    // 1. Create event
    let eventCreation = null;
    try { eventCreation = await tryHttpCreate(config, recipe, progress); }
    catch (httpErr) { progress.info('event', `HTTP admin create failed (${httpErr.message}); using browser/API path…`); }
    if (!eventCreation) {
      const hostedRouteKnownUnavailable = getHostedEventRouteStatus(recipe) === 'unavailable';
      if (shouldPreferBrowserFallback(recipe)) {
        setHostedEventRouteStatus(recipe, 'unavailable');
        progress.info('event', `Stage environment uses browser/admin event creation directly; skipping hosted API probe for org ${recipe.environment.organizationId}…`);
        eventCreation = await new BrowserFallbackAdapter(client, progress).create(
          config,
          recipe,
          new Error(`Unrecognized endpoint of organizations/${recipe.environment.organizationId}/events`),
        );
      } else if (hostedRouteKnownUnavailable) {
        progress.info('event', `Hosted API create route previously marked unavailable for org ${recipe.environment.organizationId}; skipping probe and using browser fallback…`);
        eventCreation = await new BrowserFallbackAdapter(client, progress).create(
          config,
          recipe,
          new Error(`Unrecognized endpoint of organizations/${recipe.environment.organizationId}/events`),
        );
      } else {
        try {
          eventCreation = await new EventAdapter(client, progress).create(recipe);
          setHostedEventRouteStatus(recipe, 'available');
        } catch (error) {
          if (!shouldUseBrowserFallback(error)) throw error;
          setHostedEventRouteStatus(recipe, 'unavailable');
          progress.info('event', 'API-first event creation hit a known hosted-route gap; evaluating browser fallback…');
          eventCreation = await new BrowserFallbackAdapter(client, progress).create(config, recipe, error);
        }
      }
    }
    const { created: eventResponse, id: eventId } = eventCreation;
    progress.progress(25);

    // 2. Create bidders — reuse the records the create endpoints return rather
    //    than re-fetching the full list (the GET /bidders list call is slow and
    //    routes through the single-threaded proxy; the bulk POST already returns
    //    the created records with id/bidder_number).
    const bulkBidderRecords = recipe.bidders.bulk?.records || [];
    const exactBidderRecords = recipe.bidders.exact?.records || [];
    let createdBidders = [];
    if (bulkBidderRecords.length > 0) {
      const bulkResp = await bidderAdapter.createBulk(eventId, bulkBidderRecords);
      createdBidders = createdBidders.concat(extractResourceItems(bulkResp));
    }
    for (let index = 0; index < exactBidderRecords.length; index += 1) {
      const oneResp = await bidderAdapter.createOne(eventId, exactBidderRecords[index], index, exactBidderRecords.length);
      const record = extractCreatedRecord(oneResp);
      if (record) createdBidders.push(record);
    }
    if (bulkBidderRecords.length === 0 && exactBidderRecords.length === 0) {
      progress.info('bidders', 'No bidders to create');
    }
    progress.progress(55);

    // 3. Create items — same reuse strategy. exactItemResults keeps per-index
    //    responses (used to resolve quantity/donation item ids for attachment).
    const bulkItemRecords = recipe.items.bulk?.records || [];
    const exactItemRecords = recipe.items.exact?.records || [];
    let createdItems = [];
    if (bulkItemRecords.length > 0) {
      const bulkResp = await itemAdapter.createBulk(eventId, bulkItemRecords);
      createdItems = createdItems.concat(extractResourceItems(bulkResp));
    }
    const exactItemResults = [];
    for (let index = 0; index < exactItemRecords.length; index += 1) {
      exactItemResults[index] = await itemAdapter.createOne(eventId, exactItemRecords[index], index, exactItemRecords.length);
      const record = extractCreatedRecord(exactItemResults[index]);
      if (record) createdItems.push(record);
    }
    if (bulkItemRecords.length === 0 && exactItemRecords.length === 0) {
      progress.info('items', 'No items to create');
    }
    progress.progress(80);

    // Map created items by their item_number for ticket-page quantity/donation
    // attachment. Bulk-created records carry item_number; exact ids come from
    // exactItemResults via buildCreated*Items below.
    let createdItemsByNumber = new Map();
    if ((recipe.items.bulkQuantityItems?.length || 0) > 0 || (recipe.items.bulkDonationItems?.length || 0) > 0) {
      createdItemsByNumber = new Map(createdItems.map((item) => [String(item.item_number || ''), item]));
    }
    const createdQuantityItems = buildCreatedQuantityItems(recipe, exactItemResults, createdItemsByNumber);
    const createdDonationItems = buildCreatedDonationItems(recipe, exactItemResults, createdItemsByNumber);
    // Surface any ticket-page item selections that were pruned at build time
    // because they no longer pointed at an item of the matching type.
    const itemSelectionDrops = recipe.ticketPages?.itemSelectionDrops || [];
    for (const drop of itemSelectionDrops) {
      const kind = drop.field.replace('ItemBulkIndexes', ' (bulk)').replace('ItemExactIndexes', ' (exact)');
      progress.info('ticket-pages', `Ignored ${drop.indexes.length} stale ${kind} selection(s) on ${drop.formName}: ${drop.indexes.join(', ')} (no longer that item type).`);
    }
    const needsPostItemConfig = createdQuantityItems.length > 0 || createdDonationItems.length > 0 || hasTicketPageItemAttachments(recipe.ticketPages);
    if (needsPostItemConfig) {
      if (!config.api.adminEmail || !config.api.adminPassword) {
        progress.warn('ticket-pages', 'Skipping ticket-page item config because admin credentials are missing in Settings.');
      } else {
        progress.run('ticket-pages', 'Applying ticket-page item attachments and quantity tiers…');
        try {
          await MODEL.httpApplyPostItemConfig(config.api.proxyUrl, {
            baseUrl: recipe.environment.baseUrl, organizationId: recipe.environment.organizationId,
            adminEmail: config.api.adminEmail, adminPassword: config.api.adminPassword,
            eventId, quantityItems: createdQuantityItems, donationItems: createdDonationItems, ticketPages: recipe.ticketPages,
          });
        } catch (httpErr) {
          progress.info('ticket-pages', `HTTP post-item config failed (${httpErr.message}); using browser fallback…`);
          await new BrowserPostItemConfigAdapter(progress).apply(config, recipe, eventId, createdQuantityItems, createdDonationItems);
        }
      }
    }

    // 4. Post-create verification — confirm the backend acknowledged creating
    //    our SEEDED resources by counting the records the create endpoints
    //    returned. (We no longer re-fetch the full list, so event-default
    //    bidders/items are not re-counted here.)
    progress.run('verify', 'Verifying created resources…');
    let verification;
    try {
      const seededBidderCount = countCollection(createdBidders);
      const seededItemCount = countCollection(createdItems);
      const expectedSeededBidderCount = recipe.bidders.count;
      const expectedSeededItemCount = recipe.items.count;
      const mismatches = [];
      if (seededBidderCount !== expectedSeededBidderCount) {
        mismatches.push(`expected ${expectedSeededBidderCount} seeded bidders, created ${seededBidderCount}`);
      }
      if (seededItemCount !== expectedSeededItemCount) {
        mismatches.push(`expected ${expectedSeededItemCount} seeded items, created ${seededItemCount}`);
      }
      if (mismatches.length) {
        throw new Error(`Verification mismatch: ${mismatches.join('; ')}`);
      }
      verification = {
        bidders: { seeded: expectedSeededBidderCount, created: seededBidderCount },
        items: { seeded: expectedSeededItemCount, created: seededItemCount },
      };
      progress.ok('verify', `Verified: ${seededBidderCount}/${expectedSeededBidderCount} seeded bidders, ${seededItemCount}/${expectedSeededItemCount} seeded items created in ${recipe.environment.id}`);
    } catch (err) {
      progress.error('verify', `Verification failed: ${err.message}`);
      verification = { error: err.message };
    }

    if (recipe.postCreateActivity?.enabled) {
      if (!config.api.adminEmail || !config.api.adminPassword) {
        progress.warn('post-create', 'Skipping post-create activity because admin credentials are missing in Settings.');
      } else {
        progress.run('post-create', 'Applying post-create activity…');
        await new BrowserPostCreateActivityAdapter(progress).apply(config, recipe, eventId, createdBidders, createdItems);
      }
    }

    progress.info('defaults', 'Landing page and customer-facing pages use ClickBid defaults.');
    progress.progress(100);
    progress.ok('done', `Event ready: ${recipe.environment.id}/${recipe.event.slug}`);

    return {
      eventId,
      event: eventResponse,
      verification,
      adminUrl: eventCreation.adminUrl || `${recipe.environment.baseUrl}/events/${recipe.event.slug}`,
      publicUrl: eventCreation.publicUrl || MODEL.buildPublicEventUrl(recipe.environment.baseUrl, recipe.event.slug),
    };
  }

  return {
    ClickBidApiClient,
    ProgressReporter,
    EventAdapter,
    BidderAdapter,
    ItemAdapter,
    BrowserFallbackAdapter,
    createEvent,
    getHostedEventRouteStatus,
    setHostedEventRouteStatus,
  };
});
