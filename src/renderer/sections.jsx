// Sections - reusable section card plus QA-focused settings bodies.

import React, { useRef, useState } from 'react';
import MODEL from '../shared/event-model.js';

export function Section({ icon, title, sub, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? 'is-open' : ''}`}>
      <header
        className="section-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(o => !o);
          }
        }}
      >
        <div className="section-icon"><i className={`fa-solid ${icon}`}></i></div>
        <div className="section-titles">
          <h3 className="section-title">{title}</h3>
          {sub && <p className="section-sub">{sub}</p>}
        </div>
        <div className="section-meta">{summary}</div>
        <i className="fa-solid fa-chevron-down section-chev"></i>
      </header>
      {open && (
        <div className="section-body">
          <div className="section-body-inner">{children}</div>
        </div>
      )}
    </section>
  );
}

export function Switch({ on, onClick }) {
  return <div className={`switch ${on ? 'on' : ''}`} onClick={onClick} role="switch" aria-checked={on}></div>;
}

export function SectionTabs({ value, tabs, onChange }) {
  return (
    <div className="section-tabs" role="tablist" aria-label="Section mode tabs">
      {tabs.map((tab) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            className={`section-tab ${active ? 'is-active' : ''}`}
            onClick={() => onChange(tab.value)}
            role="tab"
            aria-selected={active}
          >
            <span>{tab.label}</span>
            {tab.badge != null && <span className="section-tab-badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function EnvironmentBody({ data, set, onSwitchEnv }) {
  const allowedEnvironments = Object.entries(MODEL.ENVIRONMENTS).map(([value, preset]) => ({ value, label: preset.label }));
  const isSafe = allowedEnvironments.some(env => env.value === data.env);

  return (
    <div className="form-grid">
      <div className="field">
        <label>Environment <span className="req">*</span></label>
        <select value={data.env} onChange={e => onSwitchEnv(e.target.value)}>
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
}

export function BasicsBody({ data, set, slugCheck, onCheckSlug }) {
  const slugAuto = useRef(true);
  const today = MODEL.todayDateOnly();
  const startMin = today;
  const endMin = data.startDate && data.startDate >= today ? data.startDate : today;
  const onCallMin = endMin;
  const onCallMax = data.endDate && data.endDate >= endMin ? data.endDate : undefined;
  const slugErrors = MODEL.validateSlug(data.slug);
  const slugStatus = slugCheck?.slug === data.slug ? slugCheck : { state: 'idle', slug: data.slug, message: '' };
  const slugStatusColor = slugStatus.state === 'ok'
    ? '#166534'
    : slugStatus.state === 'checking'
      ? '#1d4ed8'
      : ['taken', 'invalid', 'error'].includes(slugStatus.state)
        ? '#b91c1c'
        : '#475569';
  return (
    <div className="form-grid">
      <div className="field span-2">
        <label>Event name <span className="req">*</span></label>
        <div className="with-suffix">
          <input type="text" value={data.name} onChange={e => {
            const v = e.target.value;
            set({ name: v, ...(slugAuto.current ? { slug: MODEL.slugifyForClickBid(v) } : {}) });
          }} placeholder="QA Silent Auction Bug Repro" />
          <button type="button" className="suffix-btn" title="Random event name" onClick={() => {
            const v = MODEL.randomEventName();
            set({ name: v, slug: MODEL.slugifyForClickBid(v) });
          }}><i className="fa-solid fa-dice"></i></button>
        </div>
        <div className="help">Use a bug/ticket-specific name so the event is easy to find later.</div>
      </div>
      <div className="field">
        <label>Event keyword <span className="req">*</span></label>
        <div className="with-prefix">
          <span className="prefix">cbo.io/</span>
          <input
            type="text"
            value={data.slug}
            onChange={e => { slugAuto.current = false; set({ slug: MODEL.slugifyForClickBid(e.target.value) }); }}
            onBlur={() => onCheckSlug?.(data.slug)}
            placeholder="qa-silent-auction-bug"
          />
        </div>
        <div className="help" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <span>3–50 chars, at least one letter, lowercase letters/numbers only. Used as the event URL keyword.</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => onCheckSlug?.(data.slug)}>
            <i className="fa-solid fa-magnifying-glass"></i> Check keyword
          </button>
        </div>
        {slugErrors.length > 0 && <div className="help" style={{ color: '#b91c1c' }}>{slugErrors.join(' ')}</div>}
        {slugStatus.state !== 'idle' && slugStatus.message && <div className="help" style={{ color: slugStatusColor }}>{slugStatus.message}</div>}
      </div>
      <div className="field">
        <label>Time zone <span className="req">*</span></label>
        <select value={data.timezone} onChange={e => set({ timezone: e.target.value })}>
          <option>America/New_York</option>
          <option>America/Chicago</option>
          <option>America/Denver</option>
          <option>America/Los_Angeles</option>
          <option>America/Phoenix</option>
        </select>
      </div>
      <div className="field">
        <label>Start date <span className="req">*</span></label>
        <input type="date" min={startMin} value={data.startDate} onChange={e => set({ startDate: e.target.value })} />
      </div>
      <div className="field">
        <label>Start time</label>
        <input type="time" value={data.startTime} onChange={e => set({ startTime: e.target.value })} />
      </div>
      <div className="field">
        <label>End date <span className="req">*</span></label>
        <input type="date" min={endMin} value={data.endDate} onChange={e => set({ endDate: e.target.value, ...(data.onCallDate ? {} : { onCallDate: e.target.value }) })} />
      </div>
      <div className="field">
        <label>End time</label>
        <input type="time" value={data.endTime} onChange={e => set({ endTime: e.target.value })} />
      </div>
      <div className="field">
        <label>On-call date <span className="req">*</span></label>
        <input type="date" min={onCallMin} max={onCallMax} value={data.onCallDate} onChange={e => set({ onCallDate: e.target.value })} />
        <div className="help">Sent to the event create API as <code>on_call</code>.</div>
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-address-card"></i>
          <div><strong>Primary contact</strong> — ClickBid requires a contact record when creating the event. This contact is also used for the first seeded bidder the API creates automatically.</div>
        </div>
      </div>
      <div className="field">
        <label>Contact first name <span className="req">*</span></label>
        <input type="text" value={data.contactFirstName} onChange={e => set({ contactFirstName: e.target.value })} />
      </div>
      <div className="field">
        <label>Contact last name <span className="req">*</span></label>
        <input type="text" value={data.contactLastName} onChange={e => set({ contactLastName: e.target.value })} />
      </div>
      <div className="field">
        <label>Contact email <span className="req">*</span></label>
        <input type="email" value={data.contactEmail} onChange={e => set({ contactEmail: e.target.value })} placeholder="qa-event@example.com" />
      </div>
      <div className="field">
        <label>Contact phone <span className="req">*</span></label>
        <input type="text" value={data.contactPhone} onChange={e => set({ contactPhone: e.target.value })} placeholder="5550000000" />
        <div className="help">Digits only works best with the hosted validator.</div>
      </div>
    </div>
  );
}

export function BiddersBody({ data, set }) {
  const bulk = { ...MODEL.DEFAULT_CONFIG.bidders.bulk, ...(data.bulk || {}) };
  const exactRecords = Array.isArray(data.exact?.records) ? data.exact.records : [];
  const activeTab = data.activeTab === 'exact' ? 'exact' : 'bulk';
  const sample = MODEL.generateBidders({ ...bulk, count: Math.min(2, bulk.count) });

  const setBulk = (patch) => set({ bulk: { ...bulk, ...patch } });
  const setExactRecords = (records) => set({ exact: { records } });
  const updateExactRecord = (index, patch) => {
    const next = exactRecords.map((record, i) => i === index ? { ...record, ...patch } : record);
    setExactRecords(next);
  };
  const removeExactRecord = (index) => setExactRecords(exactRecords.filter((_, i) => i !== index));
  const addExactRecord = () => {
    const maxBidderNumber = exactRecords.reduce((max, record) => Math.max(max, Number(record.bidder_number) || 0), bulk.startNum - 1);
    setExactRecords([
      ...exactRecords,
      {
        bidder_number: maxBidderNumber + 1,
        first_name: 'QA',
        last_name: `Exact ${String(exactRecords.length + 1).padStart(3, '0')}`,
        email: `qa-exact-${String(exactRecords.length + 1).padStart(3, '0')}@${bulk.emailDomain || 'example.com'}`,
        phone: '',
        accept_texts: false,
      },
    ]);
  };

  return (
    <div className="section-pane-stack">
      <SectionTabs
        value={activeTab}
        onChange={(tab) => set({ activeTab: tab })}
        tabs={[
          { value: 'bulk', label: 'Bulk', badge: bulk.count || 0 },
          { value: 'exact', label: 'Exact', badge: exactRecords.length },
        ]}
      />

      {activeTab === 'bulk' ? (
        <div className="form-grid cols-3">
          <div className="field">
            <label>Bidders to create</label>
            <input type="number" min="0" value={bulk.count} onChange={e => setBulk({ count: +e.target.value })} />
            <div className="help">Generated through the bulk bidder endpoint.</div>
          </div>
          <div className="field">
            <label>Starting bidder number</label>
            <input type="number" min="1" value={bulk.startNum} onChange={e => setBulk({ startNum: +e.target.value })} />
          </div>
          <div className="field">
            <label>Accept texts</label>
            <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
              <div className="sub">Default: off for generated QA bidders.</div>
              <Switch on={bulk.acceptTexts} onClick={() => setBulk({ acceptTexts: !bulk.acceptTexts })} />
            </div>
          </div>
          <div className="field span-full">
            <div className="toggle-row" style={{ padding: '10px 14px', borderRadius: 8, background: bulk.useFaker ? '#f0fdf4' : 'transparent', border: bulk.useFaker ? '1px solid #bbf7d0' : '1px solid transparent' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                  <i className="fa-solid fa-wand-magic-sparkles" style={{ color: bulk.useFaker ? '#16a34a' : '#94a3b8', marginRight: 6 }}></i>
                  Realistic data (faker)
                </div>
                <div className="sub">Generate realistic names, emails, phones, and addresses instead of QA prefixes. Email domain still applies.</div>
              </div>
              <Switch on={bulk.useFaker} onClick={() => setBulk({ useFaker: !bulk.useFaker })} />
            </div>
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>First name prefix</label>
            <input type="text" value={bulk.firstNamePrefix} onChange={e => setBulk({ firstNamePrefix: e.target.value })} />
            <div className="help">API max: 25 chars after suffix.</div>
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Last name prefix</label>
            <input type="text" value={bulk.lastNamePrefix} onChange={e => setBulk({ lastNamePrefix: e.target.value })} />
            <div className="help">API max: 35 chars after suffix.</div>
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Email prefix</label>
            <input type="text" value={bulk.emailPrefix} onChange={e => setBulk({ emailPrefix: e.target.value })} />
          </div>
          <div className="field">
            <label>Email domain</label>
            <input type="text" value={bulk.emailDomain} onChange={e => setBulk({ emailDomain: e.target.value })} />
            <div className="help">{bulk.useFaker ? 'Faker-generated emails use this domain.' : null}</div>
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Add phones</label>
            <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
              <div className="sub">Adds deterministic 555 test numbers.</div>
              <Switch on={bulk.addPhones} onClick={() => setBulk({ addPhones: !bulk.addPhones })} />
            </div>
          </div>
          <div className="field span-full">
            <div className="callout">
              <i className="fa-solid fa-users"></i>
              <div><strong>Sample records</strong> — {sample.map(b => `${b.bidder_number}: ${b.first_name} ${b.last_name} (${b.emails[0].email})${b.phones ? ` · ${b.phones[0].phone}` : ''}${b.city && b.state ? ` · ${b.city}, ${b.state}` : ''}`).join(' · ') || 'No bidders will be created.'}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="section-pane-stack">
          <div className="section-pane-actions">
            <div className="help">Use exact bidders when names, numbers, emails, or phones must be deterministic.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={addExactRecord}><i className="fa-solid fa-plus"></i> Add bidder</button>
          </div>
          {exactRecords.length === 0 ? (
            <div className="item-empty"><i className="fa-solid fa-user-plus"></i>No exact bidders yet. Add rows here when a test needs known bidder details.</div>
          ) : (
            <div className="exact-record-stack">
              {exactRecords.map((record, index) => (
                <div className="exact-record-card" key={`bidder-${index}`}>
                  <div className="exact-record-head">
                    <div>
                      <strong>Bidder #{record.bidder_number || 'new'}</strong>
                      <div className="help">Created one-by-one after bulk generated bidders.</div>
                    </div>
                    <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeExactRecord(index)}><i className="fa-solid fa-trash"></i></button>
                  </div>
                  <div className="form-grid cols-3">
                    <div className="field">
                      <label>Bidder number</label>
                      <input type="number" min="1" value={record.bidder_number ?? ''} onChange={e => updateExactRecord(index, { bidder_number: +e.target.value })} />
                    </div>
                    <div className="field">
                      <label>First name</label>
                      <input type="text" value={record.first_name || ''} onChange={e => updateExactRecord(index, { first_name: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Last name</label>
                      <input type="text" value={record.last_name || ''} onChange={e => updateExactRecord(index, { last_name: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Email</label>
                      <input type="email" value={record.email || ''} onChange={e => updateExactRecord(index, { email: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Phone</label>
                      <input type="text" value={record.phone || ''} onChange={e => updateExactRecord(index, { phone: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Accept texts</label>
                      <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
                        <div className="sub">Per-bidder override.</div>
                        <Switch on={Boolean(record.accept_texts)} onClick={() => updateExactRecord(index, { accept_texts: !record.accept_texts })} />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ItemsBody({ data, set }) {
  const bulk = { ...MODEL.DEFAULT_CONFIG.items.bulk, ...(data.bulk || {}) };
  const exactRecords = Array.isArray(data.exact?.records) ? data.exact.records : [];
  const activeTab = data.activeTab === 'exact' ? 'exact' : 'bulk';
  const itemTotal = (Number(bulk.silentCount) || 0) + (Number(bulk.liveCount) || 0) + (Number(bulk.donationCount) || 0) + (Number(bulk.quantityCount) || 0);

  const setBulk = (patch) => set({ bulk: { ...bulk, ...patch } });
  const setExactRecords = (records) => set({ exact: { records } });
  const updateExactRecord = (index, patch) => {
    const next = exactRecords.map((record, i) => i === index ? { ...record, ...patch } : record);
    setExactRecords(next);
  };
  const removeExactRecord = (index) => setExactRecords(exactRecords.filter((_, i) => i !== index));
  const addExactRecord = () => {
    const maxItemNumber = exactRecords.reduce((max, record) => Math.max(max, Number(record.item_number) || 0), bulk.startNum - 1);
    setExactRecords([
      ...exactRecords,
      {
        item_number: maxItemNumber + 1,
        item_name: `QA Exact Item ${String(exactRecords.length + 1).padStart(3, '0')}`,
        type: 'silent',
        status_id: bulk.statusId,
        starting_bid: bulk.startingBid,
        bid_increment: bulk.bidIncrement,
        fair_market_value: bulk.fairMarketValue,
        reserve_amount: bulk.reserveAmount,
        qty: 100,
        quantity_tiers: '1-25, 5-100, 10-180',
      },
    ]);
  };

  return (
    <div className="section-pane-stack">
      <SectionTabs
        value={activeTab}
        onChange={(tab) => set({ activeTab: tab })}
        tabs={[
          { value: 'bulk', label: 'Bulk', badge: itemTotal },
          { value: 'exact', label: 'Exact', badge: exactRecords.length },
        ]}
      />

      {activeTab === 'bulk' ? (
        <div className="form-grid cols-3">
          <div className="field">
            <label>Silent items</label>
            <input type="number" min="0" value={bulk.silentCount} onChange={e => setBulk({ silentCount: +e.target.value })} />
            <div className="help">Bulk endpoint, item_type_id 10.</div>
          </div>
          <div className="field">
            <label>Live items</label>
            <input type="number" min="0" value={bulk.liveCount} onChange={e => setBulk({ liveCount: +e.target.value })} />
            <div className="help">Auctioneer/Butler winner entry.</div>
          </div>
          <div className="field">
            <label>Donation items</label>
            <input type="number" min="0" value={bulk.donationCount} onChange={e => setBulk({ donationCount: +e.target.value })} />
            <div className="help">Bulk endpoint, item_type_id 30.</div>
          </div>
          <div className="field">
            <label>Quantity items</label>
            <input type="number" min="0" value={bulk.quantityCount ?? 0} onChange={e => setBulk({ quantityCount: +e.target.value })} />
            <div className="help">Bulk endpoint, item_type_id 40.</div>
          </div>
          <div className="field">
            <label>Starting item number</label>
            <input type="number" min="1" value={bulk.startNum} onChange={e => setBulk({ startNum: +e.target.value })} />
          </div>
          <div className="field">
            <label>Item name prefix</label>
            <input type="text" value={bulk.namePrefix} onChange={e => setBulk({ namePrefix: e.target.value })} style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }} />
          </div>
          <div className="field">
            <label>Status ID</label>
            <input type="number" min="1" value={bulk.statusId} onChange={e => setBulk({ statusId: +e.target.value })} />
          </div>
          <div className="field span-full">
            <div className="toggle-row" style={{ padding: '10px 14px', borderRadius: 8, background: bulk.useFaker ? '#f0fdf4' : 'transparent', border: bulk.useFaker ? '1px solid #bbf7d0' : '1px solid transparent' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                  <i className="fa-solid fa-wand-magic-sparkles" style={{ color: bulk.useFaker ? '#16a34a' : '#94a3b8', marginRight: 6 }}></i>
                  Realistic data (faker)
                </div>
                <div className="sub">Generate realistic item names and varied pricing by type instead of QA prefixes. Silent items get experience packages, live items get premium/luxury items, donations get fund names.</div>
              </div>
              <Switch on={bulk.useFaker} onClick={() => setBulk({ useFaker: !bulk.useFaker })} />
            </div>
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Starting bid</label>
            <input type="number" min="0" value={bulk.startingBid} onChange={e => setBulk({ startingBid: +e.target.value })} />
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Bid increment</label>
            <input type="number" min="0" value={bulk.bidIncrement} onChange={e => setBulk({ bidIncrement: +e.target.value })} />
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>FMV</label>
            <input type="number" min="0" value={bulk.fairMarketValue} onChange={e => setBulk({ fairMarketValue: +e.target.value })} />
          </div>
          <div className="field" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Quantity item total available</label>
            <input type="number" min="1" value={bulk.quantityItemQty ?? 100} onChange={e => setBulk({ quantityItemQty: +e.target.value })} />
          </div>
          <div className="field span-2" style={{ opacity: bulk.useFaker ? 0.35 : 1, pointerEvents: bulk.useFaker ? 'none' : 'auto' }}>
            <label>Quantity item pricing tiers</label>
            <input type="text" value={bulk.quantityItemTiers || ''} onChange={e => setBulk({ quantityItemTiers: e.target.value })} placeholder="1-25, 5-100, 10-180" />
            <div className="help">Applied to every bulk quantity item as comma-separated <code>quantity-price</code> pairs.</div>
          </div>
          <div className="field span-full">
            <div className="callout">
              <i className="fa-solid fa-gavel"></i>
              <div><strong>{itemTotal} items</strong> will be generated with deterministic numbers and names through the bulk item endpoint. Landing/customer-facing pages will use ClickBid defaults.</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="section-pane-stack">
          <div className="section-pane-actions">
            <div className="help">Use exact items for edge cases, special pricing, or known item names and numbers.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={addExactRecord}><i className="fa-solid fa-plus"></i> Add item</button>
          </div>
          {exactRecords.length === 0 ? (
            <div className="item-empty"><i className="fa-solid fa-square-plus"></i>No exact items yet. Add rows here when a test needs a specific item.</div>
          ) : (
            <div className="exact-record-stack">
              {exactRecords.map((record, index) => (
                <div className="exact-record-card" key={`item-${index}`}>
                  <div className="exact-record-head">
                    <div>
                      <strong>Item #{record.item_number || 'new'}</strong>
                      <div className="help">Created one-by-one after the bulk item pass.</div>
                    </div>
                    <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeExactRecord(index)}><i className="fa-solid fa-trash"></i></button>
                  </div>
                  <div className="form-grid cols-3">
                    <div className="field">
                      <label>Item number</label>
                      <input type="number" min="1" value={record.item_number ?? ''} onChange={e => updateExactRecord(index, { item_number: +e.target.value })} />
                    </div>
                    <div className="field span-2">
                      <label>Item name</label>
                      <input type="text" value={record.item_name || ''} onChange={e => updateExactRecord(index, { item_name: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Type</label>
                      <select value={record.type || 'silent'} onChange={e => updateExactRecord(index, { type: e.target.value })}>
                        {MODEL.ITEM_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>Status ID</label>
                      <input type="number" min="1" value={record.status_id ?? 1} onChange={e => updateExactRecord(index, { status_id: +e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Starting bid</label>
                      <input type="number" min="0" value={record.starting_bid ?? 0} onChange={e => updateExactRecord(index, { starting_bid: +e.target.value })} disabled={record.type === 'donation' || record.type === 'quantity'} />
                    </div>
                    <div className="field">
                      <label>Bid increment</label>
                      <input type="number" min="0" value={record.bid_increment ?? 0} onChange={e => updateExactRecord(index, { bid_increment: +e.target.value })} disabled={record.type === 'donation' || record.type === 'quantity'} />
                    </div>
                    <div className="field">
                      <label>FMV</label>
                      <input type="number" min="0" value={record.fair_market_value ?? 0} onChange={e => updateExactRecord(index, { fair_market_value: +e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Reserve</label>
                      <input type="number" min="0" value={record.reserve_amount ?? 0} onChange={e => updateExactRecord(index, { reserve_amount: +e.target.value })} disabled={record.type === 'quantity'} />
                    </div>
                    {record.type === 'quantity' && (
                      <>
                        <div className="field">
                          <label>Total available</label>
                          <input type="number" min="1" value={record.qty ?? 0} onChange={e => updateExactRecord(index, { qty: +e.target.value })} />
                          <div className="help">Saved to the item as <code>qty</code> and used as the remaining quantity cap.</div>
                        </div>
                        <div className="field span-2">
                          <label>Pricing tiers</label>
                          <input type="text" value={record.quantity_tiers || ''} onChange={e => updateExactRecord(index, { quantity_tiers: e.target.value })} placeholder="1-25, 5-100, 10-180" />
                          <div className="help">Comma-separated <code>quantity-price</code> pairs. Example: <code>1-25, 5-100, 10-180</code>.</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export function AuctionSettingsBody({ data, bidders, set }) {
  const settings = { ...MODEL.DEFAULT_CONFIG.auctionSettings, ...(data || {}) };
  const bidderStart = Number(bidders?.bulk?.startNum) || MODEL.DEFAULT_CONFIG.bidders.bulk.startNum;
  const effectiveStartingBidderNumber = settings.syncStartingBidderNumber ? bidderStart : settings.startingBidderNumber;

  const setBool = (key) => set({ [key]: !settings[key] });

  return (
    <div className="section-pane-stack">
      <div className="field span-full">
        <div className="toggle-row" style={{ padding: '10px 14px', borderRadius: 8, background: settings.enabled ? '#eff6ff' : 'transparent', border: settings.enabled ? '1px solid #bfdbfe' : '1px solid transparent' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              <i className="fa-solid fa-sliders" style={{ color: settings.enabled ? '#2563eb' : '#94a3b8', marginRight: 6 }}></i>
              Apply post-create auction settings
            </div>
            <div className="sub">Uses the logged-in admin browser fallback session after the event is created. Turn this off to leave ClickBid defaults unchanged.</div>
          </div>
          <Switch on={settings.enabled} onClick={() => setBool('enabled')} />
        </div>
      </div>

      <div className="form-grid cols-3" style={{ opacity: settings.enabled ? 1 : 0.45, pointerEvents: settings.enabled ? 'auto' : 'none' }}>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-credit-card"></i>
            <div><strong>Payments</strong> — Merchant assignment is checked by default and reuses the org's existing Stripe account when ClickBid offers “Yes, Use Same Accounts”.</div>
          </div>
        </div>
        <div className="field span-full">
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div>
              <strong>Use Existing Merchant Account</strong>
              <div className="sub">Click Merchant Registration and choose “Yes, Use Same Accounts” when available.</div>
            </div>
            <Switch on={settings.useExistingMerchantAccount} onClick={() => setBool('useExistingMerchantAccount')} />
          </div>
        </div>
        <div className="field">
          <label>Enable Crypto Payments?</label>
          <select value={settings.enableCrypto ? '1' : '0'} onChange={e => set({ enableCrypto: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        <div className="field">
          <label>Enable Link?</label>
          <select value={settings.enableLink ? '1' : '0'} onChange={e => set({ enableLink: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
          <div className="help">Depends on Stripe Link capability for the assigned account.</div>
        </div>

        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-gavel"></i>
            <div><strong>General Event Details</strong> — Max Bidding maps to <code>#onchange-max_bidding</code>.</div>
          </div>
        </div>
        <div className="field">
          <label>Max Bidding</label>
          <select value={settings.maxBidding ? '1' : '0'} onChange={e => set({ maxBidding: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>

        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-users"></i>
            <div><strong>Bidder Settings</strong> — Registration, required fields, mobile check-in reset, and starting bidder number.</div>
          </div>
        </div>
        <div className="field">
          <label>Allow Bidder Registration?</label>
          <select value={settings.allowBidderRegistration ? '1' : '0'} onChange={e => set({ allowBidderRegistration: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        <div className="field">
          <label>Enable Text to Register</label>
          <select value={settings.enableTextToRegister ? '1' : '0'} onChange={e => set({ enableTextToRegister: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        <div className="field">
          <label>Mobile Check-In</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Reset to org/default value</div>
            <Switch on={settings.resetMobileCheckin} onClick={() => setBool('resetMobileCheckin')} />
          </div>
        </div>
        <div className="field">
          <label>Require Address?</label>
          <select value={settings.requireAddress ? '1' : '0'} onChange={e => set({ requireAddress: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        <div className="field">
          <label>Require Credit Card Info?</label>
          <select value={settings.requireCreditCard ? '1' : '0'} onChange={e => set({ requireCreditCard: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
          <div className="help">Yes requires a configured Stripe merchant account.</div>
        </div>
        <div className="field">
          <label>Admin Fee (%)</label>
          <input type="number" min="0" step="0.01" value={settings.adminFeePercent || ''} onChange={e => set({ adminFeePercent: e.target.value })} />
          <div className="help">Blank = no fee. Credit-card admin fee passed to bidders.</div>
        </div>
        <div className="field">
          <label>Allow Guest to Optout of Admin Fees?</label>
          <select value={settings.allowAdminFeeOptOut ? '1' : '0'} onChange={e => set({ allowAdminFeeOptOut: e.target.value === '1' })}>
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </div>
        <div className="field">
          <label>Starting Bidder Number</label>
          <input type="number" min="1" value={effectiveStartingBidderNumber || ''} disabled={settings.syncStartingBidderNumber} onChange={e => set({ startingBidderNumber: e.target.value })} />
          <div className="help">{settings.syncStartingBidderNumber ? `Copied from Bidders start number (${bidderStart}).` : 'Custom value.'}</div>
        </div>
        <div className="field span-full">
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div>
              <strong>Copy starting bidder number from Bidders section</strong>
              <div className="sub">Keeps Auction Settings aligned with generated bidder numbers.</div>
            </div>
            <Switch on={settings.syncStartingBidderNumber} onClick={() => setBool('syncStartingBidderNumber')} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TicketPagesBody({ data, items, set, basics = {}, api = {} }) {
  const ticketPages = MODEL.normalizeTicketPages(data);
  const page = ticketPages.pages[0] || MODEL.DEFAULT_CONFIG.ticketPages.pages[0];
  const previewSlug = MODEL.slugifyForClickBid(basics.slug || basics.name || '');
  // Mirror summarizeRecipe: only the form name of an ENABLED ticket page shapes
  // the public URL, so the preview never diverges from the footer/admin URL.
  const previewFormName = ticketPages.enabled ? page.formName : '';
  const previewUrl = previewSlug && api.baseUrl
    ? MODEL.buildPublicEventUrl(api.baseUrl, previewSlug, previewFormName)
    : '';
  const disabledStyle = { opacity: ticketPages.enabled ? 1 : 0.45, pointerEvents: ticketPages.enabled ? 'auto' : 'none' };
  const [answerDrafts, setAnswerDrafts] = useState({});

  const commit = (patch) => set(MODEL.normalizeTicketPages({ ...ticketPages, ...patch }));
  const commitPage = (patch) => commit({ pages: [{ ...page, ...patch }] });
  const commitSettings = (patch) => commitPage({ settings: { ...page.settings, ...patch } });
  const setPreset = (preset) => {
    if (preset === 'off') {
      commit({ enabled: false, preset: 'off' });
      return;
    }
    if (preset === 'custom') {
      commit({ enabled: true, preset: 'custom', pages: ticketPages.pages });
      return;
    }
    const presetPage = MODEL.normalizeTicketPages({ enabled: true, preset, pages: [] }).pages[0];
    commit({ enabled: true, preset, pages: [presetPage] });
  };
  const updateList = (key, records) => commitPage({ [key]: records });
  const updateRecord = (key, index, patch) => updateList(key, page[key].map((record, i) => i === index ? { ...record, ...patch } : record));
  const addRecord = (key, record) => updateList(key, [...page[key], record]);
  const removeRecord = (key, index) => updateList(key, page[key].filter((_, i) => i !== index));

  const ticketDefaults = MODEL.DEFAULT_CONFIG.ticketPages.pages[0].individualTickets[0];
  const sponsorDefaults = MODEL.DEFAULT_CONFIG.ticketPages.pages[0].sponsors[0];
  const underwritingDefaults = { title: 'Underwriting Opportunity', price: 250, fairMarketValue: 0, availability: 10, visible: true };
  const selectionDefaults = { name: 'Meal Selection', description: '', quantity: 100, visible: true, showOnType: 'ticket-form', showOnIndex: 0 };
  const questionDefaults = { question: 'Custom question', type: 'text', showOn: 'ticket', required: false, isActive: true, answers: [] };
  const normalizedItems = MODEL.normalizeItemSection(items);
  const generatedBulkItems = MODEL.generateItems(normalizedItems.bulk);
  const buildAttachedItemOptions = (itemType, fallbackLabel) => [
    ...generatedBulkItems
      .map((record, bulkIndex) => ({ record, bulkIndex }))
      .filter(({ record }) => record?.item_type_id === MODEL.ITEM_TYPE_IDS[itemType])
      .map(({ record, bulkIndex }) => ({
        value: `bulk:${bulkIndex}`,
        source: 'Bulk',
        number: record.item_number || '?',
        name: record.item_name || `${fallbackLabel} ${bulkIndex + 1}`,
      })),
    ...(Array.isArray(normalizedItems.exact?.records) ? normalizedItems.exact.records : [])
      .map((record, exactIndex) => ({ record, exactIndex }))
      .filter(({ record }) => record?.type === itemType)
      .map(({ record, exactIndex }) => ({
        value: `exact:${exactIndex}`,
        source: 'Exact',
        number: record.item_number || '?',
        name: record.item_name || `${fallbackLabel} ${exactIndex + 1}`,
      })),
  ];
  const attachedQuantityItemOptions = buildAttachedItemOptions('quantity', 'Quantity Item');
  const attachedDonationItemOptions = buildAttachedItemOptions('donation', 'Donation Item');
  const selectedQuantityItemValues = [
    ...(page.quantityItemBulkIndexes || []).map((index) => `bulk:${index}`),
    ...(page.quantityItemExactIndexes || []).map((index) => `exact:${index}`),
  ];
  const selectedDonationItemValues = [
    ...(page.donationItemBulkIndexes || []).map((index) => `bulk:${index}`),
    ...(page.donationItemExactIndexes || []).map((index) => `exact:${index}`),
  ];
  const commitAttachedItems = (prefix, selectedValues) => {
    commitPage({
      [`${prefix}ItemBulkIndexes`]: selectedValues
        .filter((value) => value.startsWith('bulk:'))
        .map((value) => +(value.split(':')[1] || 0)),
      [`${prefix}ItemExactIndexes`]: selectedValues
        .filter((value) => value.startsWith('exact:'))
        .map((value) => +(value.split(':')[1] || 0)),
    });
  };
  const toggleAttachedItem = (prefix, selectedValues, value) => {
    const next = selectedValues.includes(value)
      ? selectedValues.filter((entry) => entry !== value)
      : [...selectedValues, value];
    commitAttachedItems(prefix, next);
  };
  const parseDropdownAnswers = (value) => value
    .split(',')
    .map((answer) => answer.trim())
    .filter(Boolean);
  const questionDraftKey = (key, recordIndex, questionIndex) => `${key}-${recordIndex}-question-${questionIndex}`;
  const getQuestionAnswersInputValue = (key, recordIndex, questionIndex, question) => {
    const draftKey = questionDraftKey(key, recordIndex, questionIndex);
    if (Object.prototype.hasOwnProperty.call(answerDrafts, draftKey)) {
      return answerDrafts[draftKey];
    }
    return (question.answers || []).join(', ');
  };
  const setQuestionAnswersDraft = (key, recordIndex, questionIndex, value) => {
    const draftKey = questionDraftKey(key, recordIndex, questionIndex);
    setAnswerDrafts((current) => ({ ...current, [draftKey]: value }));
  };
  const commitQuestionAnswersDraft = (key, recordIndex, questionIndex) => {
    const draftKey = questionDraftKey(key, recordIndex, questionIndex);
    const draftValue = Object.prototype.hasOwnProperty.call(answerDrafts, draftKey)
      ? answerDrafts[draftKey]
      : (page[key][recordIndex]?.customQuestions?.[questionIndex]?.answers || []).join(', ');
    updateRecordQuestion(key, recordIndex, questionIndex, { answers: parseDropdownAnswers(draftValue) });
    setAnswerDrafts((current) => {
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
  };
  const updateRecordQuestion = (key, recordIndex, questionIndex, patch) => {
    const record = page[key][recordIndex];
    const questions = (record.customQuestions || []).map((question, i) => i === questionIndex ? { ...question, ...patch } : question);
    updateRecord(key, recordIndex, { customQuestions: questions });
  };
  const addRecordQuestion = (key, recordIndex) => {
    const record = page[key][recordIndex];
    const questions = record.customQuestions || [];
    updateRecord(key, recordIndex, { customQuestions: [...questions, { ...questionDefaults, question: `Question ${questions.length + 1}` }] });
  };
  const removeRecordQuestion = (key, recordIndex, questionIndex) => {
    const record = page[key][recordIndex];
    updateRecord(key, recordIndex, { customQuestions: (record.customQuestions || []).filter((_, i) => i !== questionIndex) });
  };
  const selectionShowOnOptions = [
    { value: 'ticket-form', label: 'All' },
    ...page.individualTickets.map((ticket, index) => ({
      value: `individual-ticket:${index}`,
      label: `${ticket.name || `Ticket ${index + 1}`} (Individual)`,
    })),
    ...page.sponsors.map((sponsor, index) => ({
      value: `sponsor-ticket:${index}`,
      label: `${sponsor.title || `Sponsor ${index + 1}`} (Sponsor)`,
    })),
  ];
  const getSelectionShowOnValue = (record) => {
    const rawValue = record?.showOnType === 'ticket-form'
      ? 'ticket-form'
      : `${record?.showOnType || 'ticket-form'}:${Math.max(0, Number(record?.showOnIndex) || 0)}`;
    return selectionShowOnOptions.some((option) => option.value === rawValue) ? rawValue : 'ticket-form';
  };
  const parseSelectionShowOnValue = (value) => {
    if (!value || value === 'ticket-form') return { showOnType: 'ticket-form', showOnIndex: 0 };
    const [showOnType, rawIndex] = String(value).split(':');
    return {
      showOnType: ['individual-ticket', 'sponsor-ticket'].includes(showOnType) ? showOnType : 'ticket-form',
      showOnIndex: Math.max(0, Number(rawIndex) || 0),
    };
  };
  const questionOwnerLabel = (key) => ({
    individualTickets: 'ticket',
    sponsors: 'sponsor',
    underwriting: 'underwriting opportunity',
  }[key] || 'record');
  const renderItemAttachmentPicker = ({ label, icon, options, selectedValues, prefix, emptyText, help }) => (
    <div className="field">
      <label>{label}</label>
      <div className="attachment-picker" role="group" aria-label={label}>
        {options.length > 0 ? options.map((option) => {
          const checked = selectedValues.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={`attachment-option${checked ? ' is-selected' : ''}`}
              onClick={() => toggleAttachedItem(prefix, selectedValues, option.value)}
              aria-pressed={checked}
            >
              <span className="attachment-check"><i className={`fa-solid ${checked ? 'fa-check' : icon}`}></i></span>
              <span>
                <strong>#{option.number} {option.name}</strong>
                <small>{option.source}</small>
              </span>
            </button>
          );
        }) : (
          <div className="attachment-empty">{emptyText}</div>
        )}
      </div>
      <div className="help">{help}</div>
    </div>
  );
  const renderCustomQuestions = (key, record, recordIndex) => (
    <div className="field span-full">
      <div className="section-pane-actions">
        <div className="help"><strong>Custom questions</strong> — attach text/dropdown questions directly to this {questionOwnerLabel(key)}, choose whether the answer belongs on the ticket or guest record, and control whether the question is active.</div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => addRecordQuestion(key, recordIndex)}><i className="fa-solid fa-plus"></i> Add question</button>
      </div>
      {(record.customQuestions || []).map((question, questionIndex) => (
        <div className="exact-record-card" key={`${key}-${recordIndex}-question-${questionIndex}`} style={{ marginTop: 10 }}>
          <div className="exact-record-head">
            <strong>{question.question || `Question ${questionIndex + 1}`}</strong>
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeRecordQuestion(key, recordIndex, questionIndex)}><i className="fa-solid fa-trash"></i></button>
          </div>
          <div className="form-grid cols-3">
            <div className="field span-2"><label>Question</label><input type="text" value={question.question || ''} onChange={e => updateRecordQuestion(key, recordIndex, questionIndex, { question: e.target.value })} /></div>
            <div className="field"><label>Type</label><select value={question.type || 'text'} onChange={e => updateRecordQuestion(key, recordIndex, questionIndex, { type: e.target.value })}><option value="text">Text</option><option value="dropdown">Dropdown</option></select></div>
            {key !== 'underwriting' && <div className="field"><label>Show on</label><select value={question.showOn || 'ticket'} onChange={e => updateRecordQuestion(key, recordIndex, questionIndex, { showOn: e.target.value })}><option value="ticket">Ticket</option><option value="guest">Guest record</option></select><div className="help">Match ClickBid ticket-page settings.</div></div>}
            <div className="field"><label>Required</label><div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}><div className="sub">Require answer</div><Switch on={Boolean(question.required)} onClick={() => updateRecordQuestion(key, recordIndex, questionIndex, { required: !question.required })} /></div></div>
            <div className="field"><label>Active</label><div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}><div className="sub">Show this question</div><Switch on={question.isActive !== false} onClick={() => updateRecordQuestion(key, recordIndex, questionIndex, { isActive: question.isActive === false })} /></div></div>
            <div className="field span-full"><label>Dropdown answers</label><input type="text" value={getQuestionAnswersInputValue(key, recordIndex, questionIndex, question)} onChange={e => setQuestionAnswersDraft(key, recordIndex, questionIndex, e.target.value)} onBlur={() => commitQuestionAnswersDraft(key, recordIndex, questionIndex)} placeholder="Chicken, Vegetarian, No meal needed" /><div className="help">Use commas to add multiple dropdown answers. Saved on blur. Ignored for text questions.</div></div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="section-pane-stack">
      <div className="field span-full">
        <div className="toggle-row" style={{ padding: '10px 14px', borderRadius: 8, background: ticketPages.enabled ? '#eff6ff' : 'transparent', border: ticketPages.enabled ? '1px solid #bfdbfe' : '1px solid transparent' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              <i className="fa-solid fa-ticket" style={{ color: ticketPages.enabled ? '#2563eb' : '#94a3b8', marginRight: 6 }}></i>
              Configure ticket pages after event creation
            </div>
            <div className="sub">Quick event setup only. Runtime application will use the admin/browser fallback session in the next phase.</div>
          </div>
          <Switch on={ticketPages.enabled} onClick={() => setPreset(ticketPages.enabled ? 'off' : (ticketPages.preset === 'off' ? 'basic' : ticketPages.preset))} />
        </div>
      </div>

      <div className="form-grid cols-3" style={disabledStyle}>
        <div className="field">
          <label>Preset</label>
          <select value={ticketPages.preset} onChange={e => setPreset(e.target.value)}>
            <option value="off">Off</option>
            <option value="basic">Basic</option>
            <option value="full">Full</option>
            <option value="custom">Custom</option>
          </select>
          <div className="help">Basic = one ticket + one sponsor. Full adds underwriting, selections, and questions.</div>
        </div>
        <div className="field">
          <label>Form name</label>
          <input type="text" value={page.formName} onChange={e => commitPage({ formName: e.target.value })} />
          <div className="help">ClickBid default form is <code>tix</code>.</div>
          <div className="ticket-url-preview">
            {previewUrl
              ? <>Public URL: <code>{previewUrl.replace(/^https?:\/\//, '')}</code> · Title: <strong>{page.displayName || 'Tickets'}</strong></>
              : <span className="muted">Set an event keyword to preview the public URL.</span>}
          </div>
        </div>
        <div className="field">
          <label>Display name</label>
          <input type="text" value={page.displayName} onChange={e => commitPage({ displayName: e.target.value })} />
        </div>
        <div className="field span-full">
          <div className="form-grid cols-2">
            {renderItemAttachmentPicker({
              label: 'Quantity items',
              icon: 'fa-boxes-stacked',
              options: attachedQuantityItemOptions,
              selectedValues: selectedQuantityItemValues,
              prefix: 'quantity',
              emptyText: 'No quantity items configured in the Items section.',
              help: 'Attach bulk and exact quantity items from the Items section to this ticket page.',
            })}
            {renderItemAttachmentPicker({
              label: 'Donation items',
              icon: 'fa-hand-holding-dollar',
              options: attachedDonationItemOptions,
              selectedValues: selectedDonationItemValues,
              prefix: 'donation',
              emptyText: 'No donation items configured in the Items section.',
              help: 'Attach donation items from the Items section to the ticket page donation step.',
            })}
          </div>
        </div>

        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-credit-card"></i>
            <div><strong>Ticket page settings</strong> — stored now; browser fallback application comes next.</div>
          </div>
        </div>
        {[
          ['creditCard', 'Credit card'],
          ['sendInvoice', 'Send invoice'],
          ['cash', 'Cash'],
          ['check', 'Check'],
          ['allowGuestUpdates', 'Allow guest updates'],
          ['showQrCode', 'Show QR code'],
        ].map(([key, label]) => (
          <div className="field" key={key}>
            <label>{label}</label>
            <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
              <div className="sub">{page.settings[key] ? 'Enabled' : 'Disabled'}</div>
              <Switch on={Boolean(page.settings[key])} onClick={() => commitSettings({ [key]: !page.settings[key] })} />
            </div>
          </div>
        ))}

        <div className="field span-full">
          <div className="section-pane-actions">
            <div className="help"><strong>Individual tickets</strong> — maps to /ajax/post_individual_ticket.php later.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => addRecord('individualTickets', { ...ticketDefaults, name: `General Admission ${page.individualTickets.length + 1}` })}><i className="fa-solid fa-plus"></i> Add ticket</button>
          </div>
        </div>
        {page.individualTickets.map((record, index) => (
          <div className="exact-record-card span-full" key={`ticket-${index}`}>
            <div className="exact-record-head">
              <strong>{record.name || `Ticket ${index + 1}`}</strong>
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeRecord('individualTickets', index)}><i className="fa-solid fa-trash"></i></button>
            </div>
            <div className="form-grid cols-3">
              <div className="field"><label>Name</label><input type="text" value={record.name || ''} onChange={e => updateRecord('individualTickets', index, { name: e.target.value })} /></div>
              <div className="field"><label>Price</label><input type="number" min="0" value={record.price ?? 0} onChange={e => updateRecord('individualTickets', index, { price: +e.target.value })} /></div>
              <div className="field"><label>FMV</label><input type="number" min="0" value={record.fairMarketValue ?? 0} onChange={e => updateRecord('individualTickets', index, { fairMarketValue: +e.target.value })} /></div>
              <div className="field"><label>Tickets per purchase</label><input type="number" min="0" value={record.ticketsPerPurchase ?? 0} onChange={e => updateRecord('individualTickets', index, { ticketsPerPurchase: +e.target.value })} /></div>
              <div className="field"><label>Availability</label><input type="number" min="0" value={record.availability ?? 0} onChange={e => updateRecord('individualTickets', index, { availability: +e.target.value })} /></div>
              <div className="field"><label>Visible</label><div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}><div className="sub">Show online</div><Switch on={record.visible !== false} onClick={() => updateRecord('individualTickets', index, { visible: !record.visible })} /></div></div>
              {renderCustomQuestions('individualTickets', record, index)}
            </div>
          </div>
        ))}

        <div className="field span-full">
          <div className="section-pane-actions">
            <div className="help"><strong>Sponsor levels</strong> — maps to /ajax/post_sponsor_ticket.php later.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => addRecord('sponsors', { ...sponsorDefaults, title: `Sponsor Level ${page.sponsors.length + 1}` })}><i className="fa-solid fa-plus"></i> Add sponsor</button>
          </div>
        </div>
        {page.sponsors.map((record, index) => (
          <div className="exact-record-card span-full" key={`sponsor-${index}`}>
            <div className="exact-record-head">
              <strong>{record.title || `Sponsor ${index + 1}`}</strong>
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeRecord('sponsors', index)}><i className="fa-solid fa-trash"></i></button>
            </div>
            <div className="form-grid cols-3">
              <div className="field"><label>Title</label><input type="text" value={record.title || ''} onChange={e => updateRecord('sponsors', index, { title: e.target.value })} /></div>
              <div className="field"><label>Price</label><input type="number" min="0" value={record.price ?? 0} onChange={e => updateRecord('sponsors', index, { price: +e.target.value })} /></div>
              <div className="field"><label>FMV</label><input type="number" min="0" value={record.fairMarketValue ?? 0} onChange={e => updateRecord('sponsors', index, { fairMarketValue: +e.target.value })} /></div>
              <div className="field"><label>Tickets per purchase</label><input type="number" min="0" value={record.ticketsPerPurchase ?? 0} onChange={e => updateRecord('sponsors', index, { ticketsPerPurchase: +e.target.value })} /></div>
              <div className="field"><label>Availability</label><input type="number" min="0" value={record.availability ?? 0} onChange={e => updateRecord('sponsors', index, { availability: +e.target.value })} /></div>
              <div className="field"><label>Visible</label><div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}><div className="sub">Show online</div><Switch on={record.visible !== false} onClick={() => updateRecord('sponsors', index, { visible: !record.visible })} /></div></div>
              {renderCustomQuestions('sponsors', record, index)}
            </div>
          </div>
        ))}

        <div className="field span-full">
          <div className="section-pane-actions">
            <div className="help"><strong>Underwriting</strong> — optional full-preset opportunities.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => addRecord('underwriting', { ...underwritingDefaults, title: `Underwriting ${page.underwriting.length + 1}` })}><i className="fa-solid fa-plus"></i> Add underwriting</button>
          </div>
        </div>
        {page.underwriting.map((record, index) => (
          <div className="exact-record-card span-full" key={`underwriting-${index}`}>
            <div className="exact-record-head">
              <strong>{record.title || `Underwriting ${index + 1}`}</strong>
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeRecord('underwriting', index)}><i className="fa-solid fa-trash"></i></button>
            </div>
            <div className="form-grid cols-3">
              <div className="field"><label>Title</label><input type="text" value={record.title || ''} onChange={e => updateRecord('underwriting', index, { title: e.target.value })} /></div>
              <div className="field"><label>Price</label><input type="number" min="0" value={record.price ?? 0} onChange={e => updateRecord('underwriting', index, { price: +e.target.value })} /></div>
              <div className="field"><label>Availability</label><input type="number" min="0" value={record.availability ?? 0} onChange={e => updateRecord('underwriting', index, { availability: +e.target.value })} /></div>
              {renderCustomQuestions('underwriting', record, index)}
            </div>
          </div>
        ))}

        <div className="field span-full">
          <div className="section-pane-actions">
            <div className="help"><strong>Selections</strong> — meal/dropdown options for tickets.</div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => addRecord('selections', { ...selectionDefaults, name: `Selection ${page.selections.length + 1}` })}><i className="fa-solid fa-plus"></i> Add selection</button>
          </div>
        </div>
        {page.selections.map((record, index) => (
          <div className="exact-record-card span-full" key={`selection-${index}`}>
            <div className="exact-record-head">
              <strong>{record.name || `Selection ${index + 1}`}</strong>
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => removeRecord('selections', index)}><i className="fa-solid fa-trash"></i></button>
            </div>
            <div className="form-grid cols-3">
              <div className="field"><label>Name</label><input type="text" value={record.name || ''} onChange={e => updateRecord('selections', index, { name: e.target.value })} /></div>
              <div className="field"><label>Description</label><input type="text" value={record.description || ''} onChange={e => updateRecord('selections', index, { description: e.target.value })} /></div>
              <div className="field"><label>Show on</label><select value={getSelectionShowOnValue(record)} onChange={e => updateRecord('selections', index, parseSelectionShowOnValue(e.target.value))}>{selectionShowOnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><div className="help">Match ClickBid selection visibility.</div></div>
              <div className="field"><label>Quantity</label><input type="number" min="0" value={record.quantity ?? 0} onChange={e => updateRecord('selections', index, { quantity: +e.target.value })} /></div>
              <div className="field"><label>Visible</label><div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}><div className="sub">Show online</div><Switch on={record.visible !== false} onClick={() => updateRecord('selections', index, { visible: !record.visible })} /></div></div>
            </div>
          </div>
        ))}


        <div className="field span-full">
          <div className="callout warn">
            <i className="fa-solid fa-wand-magic-sparkles"></i>
            <div><strong>Faker hook reserved</strong> — schema includes <code>useFaker</code>, but ticket faker generation is intentionally deferred until the manual/preset browser fallback flow is stable.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PostCreateActivityBody({ data, ticketPages, set }) {
  const normalizedTicketPages = MODEL.normalizeTicketPages(ticketPages);
  const activity = MODEL.normalizePostCreateActivity(data, normalizedTicketPages);
  const purchase = activity.ticketPurchases;
  const auction = activity.auctionActivity;
  const donations = activity.donationActivity;
  const pageOptions = normalizedTicketPages.pages.map((page, index) => ({
    value: String(index),
    label: `${page.displayName || page.formName || `Page ${index + 1}`} (${page.formName || 'tix'})`,
  }));
  const selectedPage = normalizedTicketPages.pages[purchase.pageIndex] || normalizedTicketPages.pages[0] || MODEL.DEFAULT_CONFIG.ticketPages.pages[0];
  const targetOptions = [
    {
      value: 'mixed',
      label: 'Mix across configured tickets/sponsors',
    },
    ...selectedPage.individualTickets.map((ticket, index) => ({
      value: `individual-ticket:${index}`,
      label: `${ticket.name || `Ticket ${index + 1}`} (Individual)`,
    })),
    ...selectedPage.sponsors.map((sponsor, index) => ({
      value: `sponsor-ticket:${index}`,
      label: `${sponsor.title || `Sponsor ${index + 1}`} (Sponsor)`,
    })),
  ];
  const selectedTargetValue = purchase.targetMode === 'mixed' ? 'mixed' : `${purchase.targetType}:${purchase.targetIndex}`;
  const selectedPagePaymentSupport = MODEL.resolveTicketPurchasePaymentSupport(selectedPage);
  const unsupportedPaymentMix = MODEL.findUnsupportedTicketPurchasePayments(purchase, selectedPage);
  const unsupportedPaymentEntries = Object.entries(unsupportedPaymentMix);
  const ticketDisabled = !activity.enabled || !normalizedTicketPages.enabled || !purchase.enabled;
  const activityDisabled = !activity.enabled;
  const commit = (patch) => set(MODEL.normalizePostCreateActivity({ ...activity, ...patch }, normalizedTicketPages));
  const commitPurchase = (patch) => commit({ ticketPurchases: { ...purchase, ...patch } });
  const commitAuction = (patch) => commit({ auctionActivity: { ...auction, ...patch } });
  const commitDonations = (patch) => commit({ donationActivity: { ...donations, ...patch } });
  const commitPaymentMix = (method, value) => commitPurchase({ paymentMix: { ...(purchase.paymentMix || {}), [method]: Math.max(0, Number(value) || 0) } });

  return (
    <div className="section-pane-stack">
      <div className="field span-full">
        <div className="toggle-row" style={{ padding: '10px 14px', borderRadius: 8, background: activity.enabled ? '#eff6ff' : 'transparent', border: activity.enabled ? '1px solid #bfdbfe' : '1px solid transparent' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
              <i className="fa-solid fa-cart-shopping" style={{ color: activity.enabled ? '#2563eb' : '#94a3b8', marginRight: 6 }}></i>
              Seed post-create activity
            </div>
            <div className="sub">Add ticket sales, bidder activity, and donation traffic after the event build finishes.</div>
          </div>
          <Switch on={activity.enabled} onClick={() => commit({ enabled: !activity.enabled })} />
        </div>
      </div>

      <div className="form-grid cols-3" style={{ opacity: activityDisabled ? 0.45 : 1, pointerEvents: activityDisabled ? 'none' : 'auto' }}>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-credit-card"></i>
            <div><strong>Ticket sales</strong> — mkEvent can run the hosted public checkout flow, fill purchaser + guest data, and submit a real Stripe test payment with <code>4242 4242 4242 4242</code>.</div>
          </div>
        </div>
        <div className="field">
          <label>Seed ticket sales</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Run public ticket checkout after create.</div>
            <Switch on={purchase.enabled !== false} onClick={() => commitPurchase({ enabled: purchase.enabled === false })} />
          </div>
        </div>
        <div className="field">
          <label>Realistic data (faker)</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Generate realistic purchaser and guest details.</div>
            <Switch on={activity.useFaker !== false} onClick={() => commit({ useFaker: activity.useFaker === false })} />
          </div>
        </div>
        {!normalizedTicketPages.enabled && (
          <div className="field span-full">
            <div className="callout warn">
              <i className="fa-solid fa-triangle-exclamation"></i>
              <div><strong>Ticket pages required</strong> — enable Ticket Pages first so mkEvent has something public to purchase.</div>
            </div>
          </div>
        )}
      </div>

      <div className="form-grid cols-3" style={{ opacity: ticketDisabled ? 0.45 : 1, pointerEvents: ticketDisabled ? 'none' : 'auto' }}>
        {unsupportedPaymentEntries.length > 0 && (
          <div className="field span-full">
            <div className="callout warn">
              <i className="fa-solid fa-triangle-exclamation"></i>
              <div><strong>Unsupported ticket payment mix</strong> — this ticket page currently allows {Object.entries(selectedPagePaymentSupport).filter(([, enabled]) => enabled).map(([method]) => method.replace('_', ' ')).join(', ') || 'no payment methods'}. mkEvent will skip {unsupportedPaymentEntries.map(([method, count]) => `${count} ${method.replace('_', ' ')}`).join(', ')} unless you enable those methods on the ticket page.</div>
            </div>
          </div>
        )}
        <div className="field">
          <label>Ticket page</label>
          <select value={String(purchase.pageIndex)} onChange={e => commitPurchase({ pageIndex: +e.target.value })}>
            {pageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Purchase target</label>
          <select
            value={selectedTargetValue}
            onChange={(e) => {
              if (String(e.target.value) === 'mixed') {
                commitPurchase({ targetMode: 'mixed' });
                return;
              }
              const [targetType, rawIndex] = String(e.target.value || '').split(':');
              commitPurchase({ targetMode: 'specific', targetType, targetIndex: Math.max(0, Number(rawIndex) || 0) });
            }}
          >
            {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <div className="help">{purchase.targetMode === 'mixed' ? 'Round-robins across the configured ticket and sponsor options on this page.' : 'Guest cards are generated from the selected ticket\'s tickets-per-purchase value.'}</div>
        </div>
        <div className="field">
          <label>Check purchases</label>
          <input type="number" min="0" value={purchase.paymentMix?.check ?? 0} onChange={e => commitPaymentMix('check', e.target.value)} />
        </div>
        <div className="field">
          <label>Cash purchases</label>
          <input type="number" min="0" value={purchase.paymentMix?.cash ?? 0} onChange={e => commitPaymentMix('cash', e.target.value)} />
        </div>
        <div className="field">
          <label>Invoice purchases</label>
          <input type="number" min="0" value={purchase.paymentMix?.invoice ?? 0} onChange={e => commitPaymentMix('invoice', e.target.value)} />
        </div>
        <div className="field">
          <label>Credit card purchases</label>
          <input type="number" min="0" value={purchase.paymentMix?.credit_card ?? 0} onChange={e => commitPaymentMix('credit_card', e.target.value)} />
          <div className="help">Uses the slower public checkout + Stripe path.</div>
        </div>
        <div className="field">
          <label>Total purchases</label>
          <input type="number" value={purchase.purchaseCount} readOnly />
          <div className="help">Derived from the payment mix above.</div>
        </div>
        <div className="field">
          <label>Quantity per purchase</label>
          <input type="number" min="1" value={purchase.quantity} onChange={e => commitPurchase({ quantity: +e.target.value })} />
        </div>
        <div className="field">
          <label>Add donation</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Adds the first visible donation item to each purchase.</div>
            <Switch on={Boolean(purchase.addDonation)} onClick={() => commitPurchase({ addDonation: !purchase.addDonation })} />
          </div>
        </div>
        <div className="field">
          <label>Donation amount</label>
          <input type="number" min="1" value={purchase.donationAmount} disabled={!purchase.addDonation} onChange={e => commitPurchase({ donationAmount: +e.target.value })} />
          <div className="help">Skipped automatically if the public ticket page has no donation section.</div>
        </div>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-receipt"></i>
            <div><strong>Ticket sales note</strong> — Check/Cash/Invoice complete through the fast API path. Only the credit-card count uses the slower public checkout UI and Stripe.</div>
          </div>
        </div>
      </div>

      <div className="form-grid cols-3" style={{ opacity: activityDisabled ? 0.45 : 1, pointerEvents: activityDisabled ? 'none' : 'auto' }}>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-gavel"></i>
            <div><strong>Auction activity</strong> — impersonates seeded bidders and places real public bids on created auction items.</div>
          </div>
        </div>
        <div className="field">
          <label>Seed bids</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Place fast bids and max bids after create.</div>
            <Switch on={auction.enabled} onClick={() => commitAuction({ enabled: !auction.enabled })} />
          </div>
        </div>
        <div className="field">
          <label>Fast bid count</label>
          <input type="number" min="0" value={auction.bidCount} disabled={!auction.enabled} onChange={e => commitAuction({ bidCount: +e.target.value })} />
        </div>
        <div className="field">
          <label>Max bid count</label>
          <input type="number" min="0" value={auction.maxBidCount} disabled={!auction.enabled} onChange={e => commitAuction({ maxBidCount: +e.target.value })} />
        </div>
        <div className="field">
          <label>Include silent items</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Use seeded silent items as bid targets.</div>
            <Switch on={auction.includeSilent !== false} onClick={() => commitAuction({ includeSilent: auction.includeSilent === false })} />
          </div>
        </div>
        <div className="field">
          <label>Include live items</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Use seeded live items as bid targets.</div>
            <Switch on={auction.includeLive !== false} onClick={() => commitAuction({ includeLive: auction.includeLive === false })} />
          </div>
        </div>
      </div>

      <div className="form-grid cols-3" style={{ opacity: activityDisabled ? 0.45 : 1, pointerEvents: activityDisabled ? 'none' : 'auto' }}>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-hand-holding-dollar"></i>
            <div><strong>Donation activity</strong> — impersonates seeded bidders and submits real donation-item gifts through the public bidapp flow.</div>
          </div>
        </div>
        <div className="field">
          <label>Seed donation activity</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Make direct donations outside ticket checkout.</div>
            <Switch on={donations.enabled} onClick={() => commitDonations({ enabled: !donations.enabled })} />
          </div>
        </div>
        <div className="field">
          <label>Donation count</label>
          <input type="number" min="0" value={donations.donationCount} disabled={!donations.enabled} onChange={e => commitDonations({ donationCount: +e.target.value })} />
        </div>
        <div className="field">
          <label>Anonymous rate (%)</label>
          <input type="number" min="0" max="100" value={donations.anonymousRate} disabled={!donations.enabled} onChange={e => commitDonations({ anonymousRate: +e.target.value })} />
        </div>
        <div className="field">
          <label>Min donation</label>
          <input type="number" min="1" value={donations.amountMin} disabled={!donations.enabled} onChange={e => commitDonations({ amountMin: +e.target.value })} />
        </div>
        <div className="field">
          <label>Max donation</label>
          <input type="number" min="1" value={donations.amountMax} disabled={!donations.enabled} onChange={e => commitDonations({ amountMax: +e.target.value })} />
        </div>
      </div>
    </div>
  );
}

export function SettingsBody({ data, set, onTestConnection, testState, testError, onSaveProfile, onLoadProfile, onDeleteProfile }) {
  const [showOrg, setShowOrg] = useState(false);
  const [showEvent, setShowEvent] = useState(false);
  const currentBaseUrl = data.baseUrl || MODEL.ENVIRONMENTS[data.env]?.baseUrl || '';
  const currentApiBaseUrl = data.apiBaseUrl || MODEL.apiBaseUrlFrom(currentBaseUrl);
  const canTest = data.orgToken && data.organizationId;
  const envProfiles = Object.entries(data.savedProfiles || {})
    .filter(([, profile]) => profile?.env === data.env)
    .sort((left, right) => {
      const leftLabel = left[1]?.label || left[1]?.organizationId || '';
      const rightLabel = right[1]?.label || right[1]?.organizationId || '';
      return leftLabel.localeCompare(rightLabel);
    });
  return (
    <div className="form-grid">
      <div className="field span-2">
        <label>Environment base URL</label>
        <input type="text" value={currentBaseUrl} readOnly />
        <div className="help">Derived from the selected environment. URLs are locked to trusted QA presets.</div>
      </div>
      <div className="field span-2">
        <label>API base URL</label>
        <input type="text" value={currentApiBaseUrl} readOnly />
        <div className="help">Always {currentBaseUrl || '{baseUrl}'}/api/v4.</div>
      </div>
      <div className="field span-2">
        <label>Local proxy URL</label>
        <input type="text" value={data.proxyUrl || 'http://localhost:9999/proxy'} readOnly />
        <div className="help">Fixed to localhost:9999. The proxy accepts API calls from the browser and forwards them to allowed ClickBid hosts only.</div>
      </div>
      <div className="field span-full">
        <div className="callout warn">
          <i className="fa-solid fa-triangle-exclamation"></i>
          <div><strong>Prototype security note</strong> — Bearer tokens below are stored in browser localStorage. This is acceptable for a local development prototype but not for shared or internet-facing use. The planned desktop app will use the OS keychain instead.</div>
        </div>
      </div>
      <div className="field span-2">
        <label>Saved org profile</label>
        <select
          value={data.selectedProfileId || ''}
          onChange={e => onLoadProfile?.(e.target.value)}
        >
          <option value="">Current unsaved credentials</option>
          {envProfiles.map(([profileId, profile]) => (
            <option key={profileId} value={profileId}>
              {profile.label || `Org ${profile.organizationId}`} · {profile.organizationId}
            </option>
          ))}
        </select>
        <div className="help">Profiles are scoped to the selected environment and save org/event bearer tokens only.</div>
      </div>
      <div className="field">
        <label>Profile label</label>
        <input
          type="text"
          value={data.profileLabel || ''}
          onChange={e => set({ profileLabel: e.target.value })}
          placeholder="Optional label like Main Stage Org"
        />
      </div>
      <div className="field span-full" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" disabled={!data.organizationId || !data.orgToken} onClick={onSaveProfile}>
          <i className="fa-regular fa-floppy-disk"></i>
          {data.selectedProfileId ? ' Save profile' : ' Save current org profile'}
        </button>
        <button className="btn btn-outline" disabled={!data.selectedProfileId} onClick={() => onDeleteProfile?.(data.selectedProfileId)}>
          <i className="fa-regular fa-trash-can"></i>
          Delete selected profile
        </button>
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
        <div className="help">Used only when event create falls back to the admin UI automation path.</div>
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-window-restore"></i>
          <div><strong>Browser fallback</strong> — if hosted V4 event create is not exposed, mkEvent can log into the admin UI and create the event there before switching back to API seeding. Store admin credentials locally below if you want that fallback to run unattended.</div>
        </div>
      </div>
      <div className="field">
        <label>Admin login email</label>
        <input type="email" value={data.adminEmail || ''} onChange={e => set({ adminEmail: e.target.value })} placeholder="Admin UI email for fallback" />
      </div>
      <div className="field">
        <label>Admin login password</label>
        <input type="password" value={data.adminPassword || ''} onChange={e => set({ adminPassword: e.target.value })} placeholder="Admin UI password for fallback" />
        <div className="help">Saved locally only. Exported recipes never include credentials.</div>
      </div>
      <div className="field span-full" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-outline" disabled={!canTest || testState === 'testing'} onClick={onTestConnection}>
          <i className={`fa-solid ${testState === 'testing' ? 'fa-spinner fa-spin' : 'fa-plug'}`}></i>
          {testState === 'testing' ? ' Testing…' : testState === 'ok' ? ' Connected' : testState === 'fail' ? ' Connection failed' : ' Test connection'}
        </button>
        {testState === 'ok' && <span style={{ color: '#166534', fontWeight: 600 }}>✓ Connected to {data.env} / org {data.organizationId}</span>}
        {testState === 'fail' && testError && <span style={{ color: '#b91c1c' }}>{testError}</span>}
      </div>
      <div className="field span-full">
        <div className="callout">
          <i className="fa-solid fa-key"></i>
          <div>Org and event bearer tokens are saved as environment-specific org profiles on this workstation. Admin fallback credentials, proxy URL, and browser choice are global to the workstation. Exported event recipes do not include tokens. URLs are locked to trusted QA environment presets.</div>
        </div>
      </div>
    </div>
  );
}
