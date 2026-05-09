// Creation Engine — API-first ClickBid V4 adapters for the QA event creator.
// Each adapter wraps the ApiClient and reports progress through structured callbacks.
// Works in browser (window.CreationEngine) and Node (module.exports).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CreationEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MODEL = (typeof window !== 'undefined' ? window : globalThis).EventModel;

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

      let message;
      try {
        const errBody = JSON.parse(result.body);
        message = errBody.message || errBody.error || `HTTP ${result.status}`;
      } catch (_) {
        message = String(result.body || `HTTP ${result.status}`).slice(0, 200);
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
    info(tag, msg) { this.log('info', tag, msg); }
    run(tag, msg)  { this.log('run', tag, msg); }
    ok(tag, msg)   { this.log('ok', tag, msg); }
    error(tag, msg) { this.log('error', tag, msg); }
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
     * Create an event through the organization-scoped endpoint.
     * @param {object} recipe   recipe.environment, recipe.event
     * @returns {Promise<object>} created event response
     */
    async create(recipe) {
      const org = recipe.environment.organizationId;
      const { event } = recipe;

      this.progress.run('event', `Creating event "${event.name}"…`);

      const payload = {
        name: event.name,
        slug: event.slug,
        organization_id: org,
      };

      if (event.startDate) payload.start_date = `${event.startDate} ${event.startTime || '00:00'}`;
      if (event.endDate) payload.end_date = `${event.endDate} ${event.endTime || '00:00'}`;
      if (event.timezone) payload.timezone = event.timezone;

      const created = await this.client.post(`/organizations/${org}/events`, payload);

      const id = created.id || created.data?.id;
      this.progress.ok('event', `Created: event.id=${id}, keyword=${event.slug}`);

      return { created, id };
    }
  }

  // ── BidderAdapter ────────────────────────────────────────────────────

  class BidderAdapter {
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    /**
     * Bulk-create bidders for an event.
     * @param {string} eventId
     * @param {Array<object>} bidders   array of bidder records from EventModel.generateBidders
     * @returns {Promise<object>}
     */
    async createAll(eventId, bidders) {
      const count = bidders.length;
      this.progress.run('bidders', `Creating ${count} bidders…`);

      const created = await this.client.post(`/events/${eventId}/bidders`, { bidders });

      this.progress.ok('bidders', `${count} bidders created`);
      return created;
    }
  }

  // ── ItemAdapter ──────────────────────────────────────────────────────

  class ItemAdapter {
    constructor(client, progress) {
      this.client = client;
      this.progress = progress;
    }

    /**
     * Bulk-create items for an event.
     * @param {string} eventId
     * @param {Array<object>} items    array of item records from EventModel.generateItems
     * @returns {Promise<object>}
     */
    async createAll(eventId, items) {
      const count = items.length;
      this.progress.run('items', `Creating ${count} items…`);

      const created = await this.client.post(`/events/${eventId}/items`, { items });

      this.progress.ok('items', `${count} items created`);
      return created;
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

    // 1. Create event
    const { created: eventResponse, id: eventId } = await new EventAdapter(client, progress).create(recipe);
    progress.progress(30);

    // 2. Create bidders
    if (recipe.bidders.records.length > 0) {
      await new BidderAdapter(client, progress).createAll(eventId, recipe.bidders.records);
    } else {
      progress.info('bidders', 'No bidders to create');
    }
    progress.progress(60);

    // 3. Create items
    if (recipe.items.records.length > 0) {
      await new ItemAdapter(client, progress).createAll(eventId, recipe.items.records);
    } else {
      progress.info('items', 'No items to create');
    }
    progress.progress(80);

    // 4. Post-create verification
    progress.run('verify', 'Verifying created resources…');
    let verification;
    try {
      verification = await client.get(`/events/${eventId}?with=bidders,items`);
      const bidderCount = verification.bidders?.length ?? verification.data?.bidders?.length ?? 0;
      const itemCount = verification.items?.length ?? verification.data?.items?.length ?? 0;
      progress.ok('verify', `Verified: ${bidderCount} bidders, ${itemCount} items in ${recipe.environment.id}`);
    } catch (err) {
      progress.error('verify', `Verification failed: ${err.message}`);
      verification = { error: err.message };
    }

    progress.info('defaults', 'Landing page and customer-facing pages use ClickBid defaults.');
    progress.progress(100);
    progress.ok('done', `Event ready: ${recipe.environment.id}/${recipe.event.slug}`);

    return {
      eventId,
      event: eventResponse,
      verification,
      adminUrl: `${recipe.environment.baseUrl}/events/${recipe.event.slug}`,
      publicUrl: `${recipe.environment.baseUrl}/${recipe.event.slug}`,
    };
  }

  return {
    ClickBidApiClient,
    ProgressReporter,
    EventAdapter,
    BidderAdapter,
    ItemAdapter,
    createEvent,
  };
});
