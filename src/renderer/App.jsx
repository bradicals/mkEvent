// Main app — QA event creator settings-only layout.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import EVENT_MODEL from '../shared/event-model.js';
import clickbidMarkUrl from '../../assets/clickbid-mark.png';
import {
  AuctionSettingsBody,
  BasicsBody,
  BiddersBody,
  EnvironmentBody,
  ItemsBody,
  PostCreateActivityBody,
  Section,
  SettingsBody,
  TicketPagesBody,
} from './sections.jsx';
import { RunModal } from './create-runner.jsx';

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(EVENT_MODEL.DEFAULT_CONFIG));
}

function settingsKey() {
  return EVENT_MODEL.LOCAL_SETTINGS_KEY_PREFIX;
}

function legacySettingsKey(env) {
  return `mkEvent.localSettings.v2.${env || 'stage'}`;
}

function loadInitialConfig() {
  const defaults = cloneDefaultConfig();
  try {
    const saved = window.localStorage?.getItem(settingsKey())
      || window.localStorage?.getItem(legacySettingsKey(defaults.api.env))
      || window.localStorage?.getItem('mkEvent.localSettings.v1');
    return saved ? EVENT_MODEL.importLocalSettings(defaults, JSON.parse(saved)) : defaults;
  } catch (error) {
    console.warn('Could not load mkEvent local settings:', error);
    return defaults;
  }
}

function saveLocalSettings(cfg) {
  try {
    window.localStorage?.setItem(settingsKey(), JSON.stringify(EVENT_MODEL.exportLocalSettings(cfg)));
  } catch (error) {
    console.warn('Could not save mkEvent local settings:', error);
  }
}

function loadPresetLibrary() {
  try {
    const raw = window.localStorage?.getItem(EVENT_MODEL.LOCAL_PRESET_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const presets = Array.isArray(parsed?.presets) ? parsed.presets : [];
    return presets
      .filter((preset) => preset && preset.id && preset.name && preset.data)
      .map((preset) => ({
        id: String(preset.id),
        name: String(preset.name),
        data: preset.data,
      }));
  } catch (error) {
    console.warn('Could not load mkEvent presets:', error);
    return [];
  }
}

function savePresetLibrary(presets) {
  try {
    window.localStorage?.setItem(EVENT_MODEL.LOCAL_PRESET_LIBRARY_KEY, JSON.stringify({
      version: EVENT_MODEL.LOCAL_PRESET_VERSION,
      presets,
    }));
  } catch (error) {
    console.warn('Could not save mkEvent presets:', error);
  }
}

function useConfig() {
  const [cfg, setCfg] = useState(loadInitialConfig);

  // Save whenever api settings change
  useEffect(() => saveLocalSettings(cfg), [cfg.api]);

  const switchEnv = (newEnv) => {
    setCfg(current => {
      saveLocalSettings(current);
      const nextBase = {
        ...current,
        api: {
          ...current.api,
          ...EVENT_MODEL.environmentPatch(newEnv),
        },
      };
      try {
        const saved = window.localStorage?.getItem(settingsKey())
          || window.localStorage?.getItem(legacySettingsKey(newEnv));
        if (saved) {
          return EVENT_MODEL.importLocalSettings(nextBase, JSON.parse(saved));
        }
      } catch (_) { /* ignore parse errors */ }
      return EVENT_MODEL.importLocalSettings(nextBase, EVENT_MODEL.exportLocalSettings(current));
    });
  };

  const saveApiProfile = () => setCfg(current => EVENT_MODEL.saveApiProfile(current));
  const loadApiProfile = (profileId) => setCfg(current => EVENT_MODEL.applyApiProfile(current, profileId));
  const deleteApiProfile = (profileId) => setCfg(current => EVENT_MODEL.deleteApiProfile(current, profileId));

  const setSection = (key) => (patch) => setCfg(c => ({ ...c, [key]: { ...c[key], ...patch } }));
  return [cfg, setSection, setCfg, switchEnv, saveApiProfile, loadApiProfile, deleteApiProfile];
}

function AppTop({ cfg, onOpenSettings }) {
  const apiConnected = Boolean(cfg.api.orgToken && cfg.api.organizationId);
  return (
    <div className="app-top">
      <div className="app-top-logo">
        <img src={clickbidMarkUrl} alt="ClickBid" />
        <span className="divider"></span>
        <span className="product">mkEvent <span>· QA event creator</span></span>
      </div>
      <div className="app-top-right">
        <button className={`api-pill ${apiConnected ? 'connected' : ''}`}>
          <span className="dot"></span>
          {apiConnected ? `${cfg.api.env} API ready` : 'API settings needed'}
        </button>
        <button className="btn btn-ghost btn-sm"><i className="fa-regular fa-circle-question"></i> Docs</button>
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings} title="Settings" aria-label="Settings"><i className="fa-solid fa-gear"></i></button>
      </div>
    </div>
  );
}

function PresetPicker({ presets, selectedPresetId, onSelectPreset }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = (presets || []).find((preset) => preset.id === selectedPresetId);
  const label = selected?.name || 'Load saved preset…';

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="preset-picker" ref={rootRef}>
      <button type="button" className={`preset-picker-trigger ${open ? 'is-open' : ''}`} onClick={() => setOpen((current) => !current)}>
        <span>{label}</span>
        <i className="fa-solid fa-chevron-down"></i>
      </button>
      {open && (
        <div className="preset-picker-menu">
          <button
            type="button"
            className={`preset-picker-item ${!selectedPresetId ? 'is-active' : ''}`}
            onClick={() => {
              onSelectPreset('');
              setOpen(false);
            }}
          >
            Current unsaved config
          </button>
          {(presets || []).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset-picker-item ${selectedPresetId === preset.id ? 'is-active' : ''}`}
              onClick={() => {
                onSelectPreset(preset.id);
                setOpen(false);
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigToolbar({ presets, selectedPresetId, onSelectPreset, onSavePreset, onDeletePreset, onImportRecipe, onExportRecipe }) {
  return (
    <div className="page-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
      <PresetPicker presets={presets} selectedPresetId={selectedPresetId} onSelectPreset={onSelectPreset} />
      <button className="btn btn-outline" onClick={onSavePreset}><i className="fa-regular fa-bookmark"></i> Save preset</button>
      <button className="btn btn-outline" disabled={!selectedPresetId} onClick={onDeletePreset}><i className="fa-regular fa-trash-can"></i> Delete preset</button>
      <button className="btn btn-outline" onClick={onImportRecipe}><i className="fa-solid fa-file-import"></i> Import recipe</button>
      <button className="btn btn-outline" onClick={onExportRecipe}><i className="fa-regular fa-floppy-disk"></i> Export recipe</button>
    </div>
  );
}

function AppFoot({ cfg, recipe, summary, slugCheck, onCreate }) {
  const basicsReady = Boolean(
    cfg.basics.name &&
    cfg.basics.slug &&
    cfg.basics.startDate &&
    cfg.basics.endDate &&
    cfg.basics.onCallDate &&
    cfg.basics.contactFirstName &&
    cfg.basics.contactLastName &&
    cfg.basics.contactEmail &&
    cfg.basics.contactPhone
  );
  const slugBlocked = slugCheck?.slug === cfg.basics.slug && ['taken', 'invalid'].includes(slugCheck?.state);
  const canCreate = Boolean(cfg.api.organizationId && cfg.api.orgToken && basicsReady && !slugBlocked);
  return (
    <div className="app-foot">
      <div className="summary">
        <span><strong>{summary.eventName}</strong></span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.environment}</strong></span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.bidderCount}</strong> bidders</span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.itemCount}</strong> items ({summary.itemBreakdown.silent}S · {summary.itemBreakdown.live}L · {summary.itemBreakdown.donation}D · {summary.itemBreakdown.quantity}Q)</span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.ticketPages.enabled ? summary.ticketPages.pageCount : 0}</strong> ticket pages</span>
        {summary.publicUrl && (
          <>
            <span className="dot-sep">·</span>
            <span className="summary-url" title={summary.publicUrl}>{summary.publicUrl.replace(/^https?:\/\//, '')}</span>
          </>
        )}
      </div>
      <div className="grow"></div>
      <button className="btn btn-lime btn-lg" disabled={!canCreate} onClick={onCreate} title={!canCreate ? (slugBlocked ? 'Choose an available event keyword before creating the event.' : 'Enter event basics, contact info, organization ID, and org token first.') : 'Create event'}>
        <i className="fa-solid fa-rocket-launch"></i> Create event
      </button>
    </div>
  );
}

function envSummary(api) {
  const safe = Object.hasOwn(EVENT_MODEL.ENVIRONMENTS, api.env);
  return <><span className="pill" style={{background: safe ? '#dcfce7' : '#fef3c7', color: safe ? '#166534' : '#92400e'}}>● {api.env}</span><span className="pill">{api.organizationId || 'org required'}</span></>;
}
function basicsSummary(b) {
  return <>
    <span className="pill">{b.slug || 'keyword required'}</span>
    {b.startDate && <span className="pill">{new Date(`${b.startDate}T${b.startTime || '00:00'}`).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'})}</span>}
    {b.contactFirstName && <span className="pill">{b.contactFirstName} {b.contactLastName || ''}</span>}
  </>;
}
function biddersSummary(b) {
  const bulk = b.bulk || b;
  const exactCount = Array.isArray(b.exact?.records) ? b.exact.records.length : 0;
  return <><span className="pill brand">{(bulk.count || 0) + exactCount} bidders</span><span className="pill">{bulk.count || 0} bulk + {exactCount} exact</span></>;
}
function itemsSummary(i) {
  const bulk = i.bulk || i;
  const exactCount = Array.isArray(i.exact?.records) ? i.exact.records.length : 0;
  const bulkCount = (bulk.silentCount || 0) + (bulk.liveCount || 0) + (bulk.donationCount || 0) + (bulk.quantityCount || 0);
  return <><span className="pill brand">{bulkCount + exactCount} items</span><span className="pill">{bulkCount} bulk + {exactCount} exact</span></>;
}
function auctionSettingsSummary(settings) {
  const s = { ...EVENT_MODEL.DEFAULT_CONFIG.auctionSettings, ...(settings || {}) };
  if (!s.enabled) return <><span className="pill">unchanged</span></>;
  return <>
    <span className="pill brand">post-create</span>
    {s.useExistingMerchantAccount && <span className="pill">merchant</span>}
    <span className="pill">max bidding {s.maxBidding ? 'yes' : 'no'}</span>
    {s.requireCreditCard && <span className="pill">require CC</span>}
  </>;
}
function ticketPagesSummary(ticketPages) {
  const t = EVENT_MODEL.normalizeTicketPages(ticketPages);
  if (!t.enabled) return <><span className="pill">off</span></>;
  const totals = t.pages.reduce((sum, page) => {
    const individualQuestions = page.individualTickets.reduce((count, ticket) => count + (ticket.customQuestions?.length || 0), 0);
    const sponsorQuestions = page.sponsors.reduce((count, sponsor) => count + (sponsor.customQuestions?.length || 0), 0);
    return {
      tickets: sum.tickets + page.individualTickets.length,
      sponsors: sum.sponsors + page.sponsors.length,
      underwriting: sum.underwriting + page.underwriting.length,
      selections: sum.selections + page.selections.length,
      questions: sum.questions + individualQuestions + sponsorQuestions + (page.pageCustomQuestions?.length || 0),
    };
  }, { tickets: 0, sponsors: 0, underwriting: 0, selections: 0, questions: 0 });
  return <>
    <span className="pill brand">{t.preset}</span>
    <span className="pill">{totals.tickets} tickets</span>
    <span className="pill">{totals.sponsors} sponsors</span>
    {(totals.underwriting + totals.selections + totals.questions) > 0 && <span className="pill">+{totals.underwriting + totals.selections + totals.questions} extras</span>}
  </>;
}
function postCreateActivitySummary(postCreateActivity, ticketPages) {
  const activity = EVENT_MODEL.normalizePostCreateActivity(postCreateActivity, ticketPages);
  if (!activity.enabled) return <><span className="pill">off</span></>;
  return <>
    <span className="pill brand">{activity.ticketPurchases.purchaseCount} purchases</span>
    <span className="pill">{activity.ticketPurchases.targetType === 'sponsor-ticket' ? 'sponsor' : 'ticket'} flow</span>
    {activity.ticketPurchases.addDonation && <span className="pill">+ donation</span>}
  </>;
}
function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function App() {
  const [cfg, set, setCfg, switchEnv, saveApiProfile, loadApiProfile, deleteApiProfile] = useConfig();
  const [savedPresets, setSavedPresets] = useState(loadPresetLibrary);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [runRequest, setRunRequest] = useState(null);
  const [testState, setTestState] = useState('idle');
  const [testError, setTestError] = useState('');
  const [slugCheck, setSlugCheck] = useState({ state: 'idle', slug: '', message: '' });
  const [showSettings, setShowSettings] = useState(false);
  const closeSettings = () => setShowSettings(false);
  useEffect(() => { setTestState('idle'); setTestError(''); },
    [cfg.api.env, cfg.api.organizationId, cfg.api.orgToken, cfg.api.baseUrl]);
  useEffect(() => { setSlugCheck({ state: 'idle', slug: '', message: '' }); },
    [cfg.api.env, cfg.api.organizationId, cfg.api.orgToken, cfg.api.baseUrl, cfg.basics.slug]);
  useEffect(() => savePresetLibrary(savedPresets), [savedPresets]);

  useEffect(() => {
    if (!showSettings) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') closeSettings(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showSettings]);

  // Lock background scroll while the settings drawer or the run modal is open.
  const overlayOpen = showSettings || Boolean(runRequest);
  useEffect(() => {
    if (!overlayOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [overlayOpen]);
  const importInputRef = useRef(null);
  const recipe = useMemo(() => EVENT_MODEL.buildRecipe(cfg), [cfg]);
  const summary = useMemo(() => EVENT_MODEL.summarizeRecipe(recipe), [recipe]);

  const openRunModal = () => {
    setRunRequest({
      config: cloneData(cfg),
      recipe: cloneData(recipe),
    });
  };

  const exportRecipe = () => {
    const exportData = EVENT_MODEL.exportRecipeConfig(cfg);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportData.event.slug || 'mkEvent-recipe'}.recipe.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importRecipe = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result || '{}'));
        setCfg(current => EVENT_MODEL.importRecipeConfig(current, imported));
      } catch (error) {
        window.alert(`Could not import recipe JSON: ${error.message}`);
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const savePreset = () => {
    const suggestedName = savedPresets.find((preset) => preset.id === selectedPresetId)?.name || cfg.basics.name || 'QA Preset';
    const name = window.prompt('Preset name', suggestedName);
    if (!name || !String(name).trim()) return;
    const trimmedName = String(name).trim();
    const presetData = EVENT_MODEL.exportPresetConfig(cfg, trimmedName);
    const nextId = selectedPresetId && savedPresets.some((preset) => preset.id === selectedPresetId)
      ? selectedPresetId
      : `preset-${Date.now()}`;
    setSavedPresets((current) => {
      const existingIndex = current.findIndex((preset) => preset.id === nextId || preset.name === trimmedName);
      const nextPreset = { id: existingIndex >= 0 ? current[existingIndex].id : nextId, name: trimmedName, data: presetData };
      const next = [...current];
      if (existingIndex >= 0) next[existingIndex] = nextPreset;
      else next.push(nextPreset);
      return next.sort((left, right) => left.name.localeCompare(right.name));
    });
    setSelectedPresetId(nextId);
  };

  const loadPreset = (presetId) => {
    setSelectedPresetId(presetId);
    if (!presetId) return;
    const preset = savedPresets.find((entry) => entry.id === presetId);
    if (!preset) return;
    setCfg((current) => EVENT_MODEL.importPresetConfig(current, preset.data));
  };

  const deletePreset = () => {
    if (!selectedPresetId) return;
    setSavedPresets((current) => current.filter((preset) => preset.id !== selectedPresetId));
    setSelectedPresetId('');
  };

  const checkSlugAvailability = async (slugOverride) => {
    const rawSlug = typeof slugOverride === 'string' ? slugOverride : cfg.basics.slug;
    const normalizedSlug = EVENT_MODEL.slugifyForClickBid(rawSlug);
    if (!normalizedSlug) {
      setSlugCheck({ state: 'idle', slug: '', message: '' });
      return null;
    }

    const localErrors = EVENT_MODEL.validateSlug(normalizedSlug);
    if (localErrors.length > 0) {
      const next = { state: 'invalid', slug: normalizedSlug, message: localErrors.join(' ') };
      setSlugCheck(next);
      return next;
    }

    if (!cfg.api.organizationId || !cfg.api.orgToken) {
      const next = { state: 'idle', slug: normalizedSlug, message: 'Enter organization ID and org token to check keyword availability.' };
      setSlugCheck(next);
      return next;
    }

    setSlugCheck({ state: 'checking', slug: normalizedSlug, message: '' });
    try {
      const result = await EVENT_MODEL.validateEventSlugAvailability(cfg.api, normalizedSlug);
      const next = result.isValid
        ? { state: 'ok', slug: normalizedSlug, message: 'Keyword is available.' }
        : { state: 'taken', slug: normalizedSlug, message: result.reason || 'Keyword is already in use.' };
      setSlugCheck(next);
      return next;
    } catch (error) {
      const next = { state: 'error', slug: normalizedSlug, message: error.message || 'Could not verify keyword availability.' };
      setSlugCheck(next);
      return next;
    }
  };

  const testConnection = async () => {
    if (!cfg.api.orgToken || !cfg.api.organizationId) return;
    setTestState('testing');
    setTestError('');
    const targetUrl = `${cfg.api.apiBaseUrl || EVENT_MODEL.apiBaseUrlFrom(cfg.api.baseUrl)}/organizations/${cfg.api.organizationId}/events?per_page=1`;
    try {
      const result = await EVENT_MODEL.apiProxyCall(cfg.api.proxyUrl, targetUrl, 'GET', {
        'Authorization': `Bearer ${cfg.api.orgToken}`,
        'Accept': 'application/json',
      });
      if (result.status >= 200 && result.status < 300) {
        setTestState('ok');
      } else {
        setTestState('fail');
        let body = '';
        try { body = JSON.parse(result.body); } catch (_) { body = result.body; }
        const msg = body?.message || body?.error || `HTTP ${result.status}`;
        setTestError(String(msg).slice(0, 200));
      }
    } catch (error) {
      setTestState('fail');
      setTestError(error.message || 'Proxy unreachable');
    }
  };

  return (
    <>
      <AppTop cfg={cfg} onOpenSettings={() => setShowSettings(true)} />
      <div className="page" data-screen-label="QA Event creator">
        <div className="page-head">
        <div>
          <div className="eyebrow-mini">Create QA event</div>
          <h1 className="page-title">New QA event configuration</h1>
          <p className="page-sub">Choose the environment, set the event basics, then mix bulk-generated and exact bidders/items inside each section. Customer-facing pages use ClickBid defaults.</p>
          <ConfigToolbar
            presets={savedPresets}
            selectedPresetId={selectedPresetId}
            onSelectPreset={loadPreset}
            onSavePreset={savePreset}
            onDeletePreset={deletePreset}
            onImportRecipe={() => importInputRef.current?.click()}
            onExportRecipe={exportRecipe}
          />
        </div>
      </div>

        <Section icon="fa-server" title="Environment" sub="Where the event will be created." defaultOpen summary={envSummary(cfg.api)}>
          <EnvironmentBody data={cfg.api} set={set('api')} onSwitchEnv={switchEnv} />
        </Section>

        <Section icon="fa-circle-info" title="Event basics" sub="Name, slug, schedule." defaultOpen summary={basicsSummary(cfg.basics)}>
          <BasicsBody data={cfg.basics} set={set('basics')} slugCheck={slugCheck} onCheckSlug={checkSlugAvailability} />
        </Section>

        <Section icon="fa-users" title="Bidders" sub="Generated bidder count and naming." summary={biddersSummary(cfg.bidders)}>
          <BiddersBody data={cfg.bidders} set={set('bidders')} />
        </Section>

        <Section icon="fa-gavel" title="Items" sub="Bulk silent, live, donation, and quantity items." defaultOpen summary={itemsSummary(cfg.items)}>
          <ItemsBody data={cfg.items} set={set('items')} />
        </Section>

        <Section icon="fa-sliders" title="Auction settings" sub="High-traffic admin toggles applied after event creation." defaultOpen summary={auctionSettingsSummary(cfg.auctionSettings)}>
          <AuctionSettingsBody data={cfg.auctionSettings} bidders={cfg.bidders} set={set('auctionSettings')} />
        </Section>

        <Section icon="fa-ticket" title="Ticket pages" sub="Quick setup for ticket forms, ticket types, selections, and questions." summary={ticketPagesSummary(cfg.ticketPages)}>
          <TicketPagesBody data={cfg.ticketPages} items={cfg.items} set={set('ticketPages')} basics={cfg.basics} api={cfg.api} />
        </Section>

        <Section icon="fa-cart-shopping" title="Post-create activity" sub="Optional public checkout seeding for guest and sales data." summary={postCreateActivitySummary(cfg.postCreateActivity, cfg.ticketPages)}>
          <PostCreateActivityBody data={cfg.postCreateActivity} ticketPages={cfg.ticketPages} set={set('postCreateActivity')} />
        </Section>
      </div>
      <AppFoot
        cfg={cfg}
        recipe={recipe}
        summary={summary}
        slugCheck={slugCheck}
        onCreate={openRunModal}
      />
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        onChange={importRecipe}
        style={{ display: 'none' }}
      />
      {runRequest && (
        <RunModal
          config={runRequest.config}
          recipe={runRequest.recipe}
          onClose={() => setRunRequest(null)}
        />
      )}
      {showSettings && (
        <>
          <div className="settings-backdrop" onClick={closeSettings} />
          <aside className="settings-aside" role="dialog" aria-label="Settings">
            <div className="settings-aside-head">
              <h2>Settings</h2>
              <button className="btn btn-ghost btn-sm" onClick={closeSettings} aria-label="Close settings"><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div className="settings-aside-body">
              <SettingsBody
                data={cfg.api}
                set={set('api')}
                onTestConnection={testConnection}
                testState={testState}
                testError={testError}
                onSaveProfile={saveApiProfile}
                onLoadProfile={loadApiProfile}
                onDeleteProfile={deleteApiProfile}
              />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

export default App;
