// Sections - reusable section card plus QA-focused settings bodies.
// Loaded after event-model.js and React.

const { useState, useRef } = React;
const MODEL = window.EventModel;

window.Section = function Section({ id, icon, title, sub, summary, defaultOpen = false, forceOpen = false, error = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <section className={`section ${isOpen ? 'is-open' : ''} ${error ? 'has-error' : ''}`} id={id}>
      <header className="section-head" onClick={() => !forceOpen && setOpen(o => !o)}>
        <div className="section-icon"><i className={`fa-solid ${icon}`}></i></div>
        <div className="section-titles">
          <h3 className="section-title">{title}</h3>
          {sub && <p className="section-sub">{sub}</p>}
        </div>
        <div className="section-meta">{summary}</div>
        {!forceOpen && <i className="fa-solid fa-chevron-down section-chev"></i>}
      </header>
      {isOpen && (
        <div className="section-body">
          <div className="section-body-inner">{children}</div>
        </div>
      )}
    </section>
  );
};

window.Switch = function Switch({ on, onClick }) {
  return <div className={`switch ${on ? 'on' : ''}`} onClick={onClick} role="switch" aria-checked={on}></div>;
};

window.EnvironmentBody = function EnvironmentBody({ data, set }) {
  const allowedEnvironments = Object.entries(MODEL.ENVIRONMENTS).map(([value, preset]) => ({ value, label: preset.label }));
  const isSafe = allowedEnvironments.some(env => env.value === data.env);
  const setPreset = (env) => set(MODEL.environmentPatch(env));

  return (
    <div className="form-grid">
      <div className="field">
        <label>Environment <span className="req">*</span></label>
        <select value={data.env} onChange={e => setPreset(e.target.value)}>
          {allowedEnvironments.map(env => <option key={env.value} value={env.value}>{env.label}</option>)}
        </select>
        <div className="help">Only QA environments are listed. Production and local are intentionally excluded.</div>
      </div>
      <div className="field">
        <label>Organization ID <span className="req">*</span></label>
        <input type="text" value={data.organizationId} onChange={e => set({ organizationId: e.target.value })} placeholder="Org ID or organization slug" />
        <div className="help">Used for org-scoped event endpoints.</div>
      </div>
      <div className="field span-full">
        <div className={`callout ${isSafe ? '' : 'warn'}`}>
          <i className={`fa-solid ${isSafe ? 'fa-shield-check' : 'fa-triangle-exclamation'}`}></i>
          <div>
            <strong>{isSafe ? 'QA-safe default' : 'Use caution'}</strong> — mkEvent creates fresh test data in the selected environment. Landing page and bidder-facing pages use ClickBid defaults unless a specific API-supported setting is added later.
          </div>
        </div>
      </div>
    </div>
  );
};

window.BasicsBody = function BasicsBody({ data, set }) {
  const slugAuto = useRef(true);
  const slugErrors = MODEL.validateSlug(data.slug);
  return (
    <div className="form-grid">
      <div className="field span-2">
        <label>Event name <span className="req">*</span></label>
        <input type="text" value={data.name} onChange={e => {
          const v = e.target.value;
          set({ name: v, ...(slugAuto.current ? { slug: MODEL.slugifyForClickBid(v) } : {}) });
        }} placeholder="QA Silent Auction Bug Repro" />
        <div className="help">Use a bug/ticket-specific name so the event is easy to find later.</div>
      </div>
      <div className="field">
        <label>URL slug <span className="req">*</span></label>
        <div className="with-prefix">
          <span className="prefix">cbo.io/</span>
          <input type="text" value={data.slug} onChange={e => { slugAuto.current = false; set({ slug: MODEL.slugifyForClickBid(e.target.value) }); }} placeholder="qa-silent-auction-bug" />
        </div>
        <div className="help">3–50 chars, at least one letter, lowercase letters/numbers/dashes.</div>
        {slugErrors.length > 0 && <div className="help" style={{ color: '#b91c1c' }}>{slugErrors.join(' ')}</div>}
      </div>
      <div className="field">
        <label>Time zone</label>
        <select value={data.timezone} onChange={e => set({ timezone: e.target.value })}>
          <option>America/New_York</option>
          <option>America/Chicago</option>
          <option>America/Denver</option>
          <option>America/Los_Angeles</option>
          <option>America/Phoenix</option>
        </select>
      </div>
      <div className="field">
        <label>Start date</label>
        <input type="date" value={data.startDate} onChange={e => set({ startDate: e.target.value })} />
      </div>
      <div className="field">
        <label>Start time</label>
        <input type="time" value={data.startTime} onChange={e => set({ startTime: e.target.value })} />
      </div>
      <div className="field">
        <label>End date</label>
        <input type="date" value={data.endDate} onChange={e => set({ endDate: e.target.value })} />
      </div>
      <div className="field">
        <label>End time</label>
        <input type="time" value={data.endTime} onChange={e => set({ endTime: e.target.value })} />
      </div>
    </div>
  );
};

window.BiddersBody = function BiddersBody({ data, set }) {
  const sample = MODEL.generateBidders({ ...data, count: Math.min(2, data.count) });
  return (
    <div className="form-grid cols-3">
      <div className="field">
        <label>Bidders to create</label>
        <input type="number" min="0" value={data.count} onChange={e => set({ count: +e.target.value })} />
        <div className="help">Bulk created through the bidder API.</div>
      </div>
      <div className="field">
        <label>Starting bidder number</label>
        <input type="number" min="1" value={data.startNum} onChange={e => set({ startNum: +e.target.value })} />
      </div>
      <div className="field">
        <label>Accept texts</label>
        <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
          <div className="sub">Default: off for generated QA bidders.</div>
          <window.Switch on={data.acceptTexts} onClick={() => set({ acceptTexts: !data.acceptTexts })} />
        </div>
      </div>
      <div className="field">
        <label>First name prefix</label>
        <input type="text" value={data.firstNamePrefix} onChange={e => set({ firstNamePrefix: e.target.value })} />
        <div className="help">API max: 25 chars after suffix.</div>
      </div>
      <div className="field">
        <label>Last name prefix</label>
        <input type="text" value={data.lastNamePrefix} onChange={e => set({ lastNamePrefix: e.target.value })} />
        <div className="help">API max: 35 chars after suffix.</div>
      </div>
      <div className="field">
        <label>Email domain</label>
        <input type="text" value={data.emailDomain} onChange={e => set({ emailDomain: e.target.value })} />
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-users"></i>
          <div><strong>Sample records</strong> — {sample.map(b => `${b.bidder_number}: ${b.first_name} ${b.last_name} (${b.emails[0].email})`).join(' · ') || 'No bidders will be created.'}</div>
        </div>
      </div>
    </div>
  );
};

window.ItemsBody = function ItemsBody({ data, set }) {
  const itemTotal = (Number(data.silentCount) || 0) + (Number(data.liveCount) || 0) + (Number(data.donationCount) || 0);
  return (
    <div className="form-grid cols-3">
      <div className="field">
        <label>Silent items</label>
        <input type="number" min="0" value={data.silentCount} onChange={e => set({ silentCount: +e.target.value })} />
        <div className="help">API item_type_id 10.</div>
      </div>
      <div className="field">
        <label>Live items</label>
        <input type="number" min="0" value={data.liveCount} onChange={e => set({ liveCount: +e.target.value })} />
        <div className="help">Auctioneer/Butler winner entry.</div>
      </div>
      <div className="field">
        <label>Donation items</label>
        <input type="number" min="0" value={data.donationCount} onChange={e => set({ donationCount: +e.target.value })} />
        <div className="help">API item_type_id 30.</div>
      </div>
      <div className="field">
        <label>Starting item number</label>
        <input type="number" min="1" value={data.startNum} onChange={e => set({ startNum: +e.target.value })} />
      </div>
      <div className="field">
        <label>Item name prefix</label>
        <input type="text" value={data.namePrefix} onChange={e => set({ namePrefix: e.target.value })} />
      </div>
      <div className="field">
        <label>Status ID</label>
        <input type="number" min="1" value={data.statusId} onChange={e => set({ statusId: +e.target.value })} />
      </div>
      <div className="field">
        <label>Starting bid</label>
        <input type="number" min="0" value={data.startingBid} onChange={e => set({ startingBid: +e.target.value })} />
      </div>
      <div className="field">
        <label>Bid increment</label>
        <input type="number" min="0" value={data.bidIncrement} onChange={e => set({ bidIncrement: +e.target.value })} />
      </div>
      <div className="field">
        <label>FMV</label>
        <input type="number" min="0" value={data.fairMarketValue} onChange={e => set({ fairMarketValue: +e.target.value })} />
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-gavel"></i>
          <div><strong>{itemTotal} items</strong> will be generated with deterministic numbers and names. Landing/customer-facing pages will use ClickBid defaults.</div>
        </div>
      </div>
    </div>
  );
};

window.SettingsBody = function SettingsBody({ data, set }) {
  const [showOrg, setShowOrg] = useState(false);
  const [showEvent, setShowEvent] = useState(false);
  const setBaseUrl = (baseUrl) => {
    const cleanBaseUrl = String(baseUrl || '').replace(/\/$/, '');
    set({
      baseUrl: cleanBaseUrl,
      apiBaseUrl: MODEL.apiBaseUrlFrom(cleanBaseUrl),
      adminBaseUrl: cleanBaseUrl,
      publicBaseUrl: cleanBaseUrl,
    });
  };
  return (
    <div className="form-grid">
      <div className="field span-2">
        <label>Base URL <span className="req">*</span></label>
        <input type="text" value={data.baseUrl || ''} onChange={e => setBaseUrl(e.target.value)} placeholder="https://cbodev4.com" />
        <div className="help">Admin and public URLs are derived from this same base URL.</div>
      </div>
      <div className="field span-2">
        <label>API base URL</label>
        <input type="text" value={data.apiBaseUrl || MODEL.apiBaseUrlFrom(data.baseUrl)} readOnly />
        <div className="help">Derived as base URL + /api/v4.</div>
      </div>
      <div className="field">
        <label>Org bearer token <span className="req">*</span></label>
        <div style={{ position: 'relative' }}>
          <input type={showOrg ? 'text' : 'password'} value={data.orgToken} onChange={e => set({ orgToken: e.target.value })} placeholder="Organization-scoped token" />
          <button onClick={() => setShowOrg(s => !s)} style={{ position: 'absolute', right: 8, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b', padding: 6 }}>
            <i className={`fa-regular ${showOrg ? 'fa-eye-slash' : 'fa-eye'}`}></i>
          </button>
        </div>
      </div>
      <div className="field">
        <label>Event bearer token</label>
        <div style={{ position: 'relative' }}>
          <input type={showEvent ? 'text' : 'password'} value={data.eventToken} onChange={e => set({ eventToken: e.target.value })} placeholder="Optional after event creation" />
          <button onClick={() => setShowEvent(s => !s)} style={{ position: 'absolute', right: 8, top: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b', padding: 6 }}>
            <i className={`fa-regular ${showEvent ? 'fa-eye-slash' : 'fa-eye'}`}></i>
          </button>
        </div>
      </div>
      <div className="field">
        <label>UI fallback browser</label>
        <select value={data.browser} onChange={e => set({ browser: e.target.value })}>
          <option value="chromium">Playwright Chromium</option>
          <option value="firefox">Playwright Firefox</option>
          <option value="webkit">Playwright WebKit</option>
        </select>
        <div className="help">Only used for gaps the API cannot cover.</div>
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-key"></i>
          <div>Environment, organization ID, tokens, and fallback browser are saved locally for this workstation. Exported event recipes still exclude tokens.</div>
        </div>
      </div>
    </div>
  );
};
