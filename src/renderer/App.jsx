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
  SettingsBody,
  TicketPagesBody,
} from './sections.jsx';
import { RunModal } from './create-runner.jsx';
import STOCKED_RECIPE from './stocked-recipe.json';
// Side-effect import: wizard.js sets globalThis.WIZARD for the browser bundle
// (see wizard.js for why a plain `import * as WIZARD`/default import doesn't work here).
import './wizard.js';
const WIZARD = globalThis.WIZARD;

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(EVENT_MODEL.DEFAULT_CONFIG));
}

function settingsKey() {
  return EVENT_MODEL.LOCAL_SETTINGS_KEY_PREFIX;
}

function legacySettingsKey(env) {
  return `mkEvent.localSettings.v2.${env || 'stage'}`;
}

// Encrypted settings store (issue #10): in Electron, connection settings
// (tokens + admin credentials) are stored via safeStorage instead of plaintext
// localStorage. Plain-browser dev (no preload) or an OS without encryption
// support falls back to the old localStorage behavior.
const SECURE = window.mkEventDesktop?.secureSettings;
const SECURE_ON = Boolean(SECURE?.isAvailable?.());

// When the encrypted store exists but couldn't be decrypted (transient DPAPI
// hiccup), block all saves for this session — otherwise the auto-save effect
// would overwrite the still-valid file with defaults (issue #15).
let secureLoadFailed = false;

function loadSecureSettings() {
  const result = SECURE.load();
  if (result && !result.ok) {
    secureLoadFailed = true;
    console.warn('mkEvent secure settings could not be decrypted; saving is disabled this session to protect the stored copy.');
  }
  return result?.json ?? null;
}

function readPlaintextSettings(env) {
  return window.localStorage?.getItem(settingsKey())
    || window.localStorage?.getItem(legacySettingsKey(env))
    || window.localStorage?.getItem('mkEvent.localSettings.v1');
}

function purgePlaintextSettings() {
  try {
    const doomed = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('mkEvent.localSettings')) doomed.push(key);
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch (_) { /* ignore */ }
}

function loadInitialConfig() {
  const defaults = cloneDefaultConfig();
  try {
    let saved = SECURE_ON ? loadSecureSettings() : null;
    if (!saved && !secureLoadFailed) {
      saved = readPlaintextSettings(defaults.api.env);
      if (saved && SECURE_ON) {
        // One-time migration: move plaintext settings into the encrypted
        // store; only delete the plaintext copies once the save is confirmed.
        if (SECURE.save(saved) === true) purgePlaintextSettings();
      }
    }
    return saved ? EVENT_MODEL.importLocalSettings(defaults, JSON.parse(saved)) : defaults;
  } catch (error) {
    console.warn('Could not load mkEvent local settings:', error);
    return defaults;
  }
}

function saveLocalSettings(cfg) {
  try {
    if (SECURE_ON && secureLoadFailed) return;
    const json = JSON.stringify(EVENT_MODEL.exportLocalSettings(cfg));
    if (SECURE_ON) SECURE.save(json);
    else window.localStorage?.setItem(settingsKey(), json);
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
        // Same rule as loadInitialConfig: after a decrypt failure the encrypted
        // store stays authoritative — don't fall back to plaintext.
        const saved = (SECURE_ON ? loadSecureSettings() : null)
          || (secureLoadFailed ? null : readPlaintextSettings(newEnv));
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
        <span className="product">mkEvent <span>· QA event creator · v{__APP_VERSION__}</span></span>
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

function PresetNameModal({ initialName, onSave, onCancel }) {
  const [name, setName] = useState(initialName || '');
  const inputRef = useRef(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const trimmed = name.trim();
  const submit = (event) => {
    event.preventDefault();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <div className="preset-modal-overlay" onMouseDown={onCancel}>
      <form className="preset-modal" role="dialog" aria-label="Save preset" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="preset-modal-head">
          <h2><i className="fa-regular fa-bookmark"></i> Save preset</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} aria-label="Close"><i className="fa-solid fa-xmark"></i></button>
        </div>
        <div className="preset-modal-body">
          <div className="field">
            <label htmlFor="preset-name-input">Preset name</label>
            <input
              id="preset-name-input"
              ref={inputRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. QA Preset"
            />
            <div className="help">Saving with an existing name overwrites that preset.</div>
          </div>
        </div>
        <div className="preset-modal-foot">
          <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!trimmed}>Save preset</button>
        </div>
      </form>
    </div>
  );
}

function StepRail({ cfg, slugCheck, step, onJump }) {
  const ready = WIZARD.readyCount(cfg, slugCheck);
  const pct = (step / (WIZARD.STEPS.length - 1)) * 100;
  return (
    <aside className="wiz-rail">
      <div className="wiz-rail-head">
        <div className="wiz-eyebrow">Progress</div>
        <div className="wiz-progress"><div className="bar" style={{ width: `${pct}%` }} /></div>
        <div className="wiz-progress-label">{ready} of {WIZARD.STEPS.length} steps ready</div>
      </div>
      <nav className="wiz-rail-items">
        {WIZARD.STEPS.map((s, i) => {
          const active = i === step;
          const complete = !active && WIZARD.stepReady(cfg, s.id, slugCheck);
          return (
            <button
              key={s.id}
              type="button"
              className={`wiz-rail-item ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}
              onClick={() => onJump(i)}
            >
              <span className="circle">{complete ? <i className="fa-solid fa-check" /> : s.num}</span>
              <span className="label">{s.title}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function StepCard({ step, children }) {
  return (
    <div className="wiz-main">
      <div className="wiz-head">
        <div className="wiz-step-eyebrow">Step {step.num} of {WIZARD.STEPS.length}</div>
        <h1 className="wiz-title">{step.title}</h1>
        <p className="wiz-sub">{step.subtitle}</p>
      </div>
      <div className="wiz-card">{children}</div>
    </div>
  );
}

function WizardFooter({ step, canCreate, onBack, onNext, onSkip, onCreate }) {
  const isFirst = step === 0;
  const isReview = step === WIZARD.STEPS.length - 1;
  return (
    <div className="wiz-foot">
      <button className="btn btn-outline" disabled={isFirst} onClick={onBack}>
        <i className="fa-solid fa-arrow-left" /> Back
      </button>
      <div className="grow" />
      {!isReview && <button className="btn btn-ghost" onClick={onSkip}>Skip to review</button>}
      {isReview ? (
        <button className="btn btn-lime btn-lg" disabled={!canCreate} onClick={onCreate}
          title={canCreate ? 'Create event' : 'Complete Connect and Event basics first.'}>
          <i className="fa-solid fa-rocket" /> Create event
        </button>
      ) : (
        <button className="btn btn-primary" onClick={onNext}>Continue <i className="fa-solid fa-arrow-right" /></button>
      )}
    </div>
  );
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function ConnectStep({ cfg, set, switchEnv, onQuickStart, activeQuickStart, onTest, testState, testError }) {
  const testLabel = { idle: 'Test connection', testing: 'Testing…', ok: 'Connected', fail: 'Failed' }[testState] || 'Test connection';
  const canTest = Boolean(cfg.api.organizationId && cfg.api.orgToken) && testState !== 'testing';
  const activePreset = WIZARD.QUICK_START.find((p) => p.id === activeQuickStart);
  return (
    <>
      <div className="quick-start">
        <div className="quick-start-eyebrow">Quick start — prefill a recipe</div>
        <div className="quick-start-chips">
          {WIZARD.QUICK_START.map((p) => (
            <button key={p.id} type="button" className={`quick-chip ${activeQuickStart === p.id ? 'is-active' : ''}`} onClick={() => onQuickStart(p)}>
              <span className="qc-icon"><i className={`fa-solid ${p.icon}`} /></span>
              <span className="qc-text"><strong>{p.name}</strong><small>{p.blurb}</small></span>
            </button>
          ))}
        </div>
        {activePreset && (
          <div className="quick-start-note">
            <i className="fa-solid fa-circle-check" /> Applied <strong>{activePreset.name}</strong> — {activePreset.id === 'stocked'
              ? 'bidders, items, auction settings, ticket pages, and post-create activity are prefilled. Review the steps to tweak.'
              : 'bidder and item counts are prefilled. Review or tweak them on the Bidders and Items steps.'}
          </div>
        )}
      </div>
      <EnvironmentBody data={cfg.api} set={set('api')} onSwitchEnv={switchEnv} />
      <div className="test-panel">
        <span className={`test-dot ${testState}`} />
        <div className="test-text">
          <strong>Connection</strong>
          <small>{testState === 'ok' ? 'API responded successfully.' : testState === 'fail' ? (testError || 'Could not reach the API.') : 'Verify the org token before creating an event.'}</small>
        </div>
        <button className="btn btn-outline" disabled={!canTest} onClick={onTest}>
          {testState === 'testing' ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-plug-circle-check" />} {testLabel}
        </button>
      </div>
    </>
  );
}

function ReviewStep({ summary, cfg }) {
  const rows = [
    ['fa-server', 'Environment', cfg.api.env],
    ['fa-signature', 'Event', summary.eventName || 'Untitled event'],
    ['fa-link', 'Keyword', `cbo.io/${cfg.basics.slug || '—'}`],
    ['fa-calendar', 'Schedule', cfg.basics.startDate ? `${cfg.basics.startDate} ${cfg.basics.startTime || ''}`.trim() : 'Dates not set'],
    ['fa-users', 'Bidders', `${summary.bidderCount}`],
    ['fa-gavel', 'Items', `${summary.itemCount} (${summary.itemBreakdown.silent}S · ${summary.itemBreakdown.live}L · ${summary.itemBreakdown.donation}D · ${summary.itemBreakdown.quantity}Q)`],
    ['fa-ticket', 'Ticket pages', summary.ticketPages.enabled ? `${summary.ticketPages.pageCount} pages` : 'Off'],
    ['fa-address-card', 'Contact', `${cfg.basics.contactFirstName || ''} ${cfg.basics.contactLastName || ''}`.trim() || '—'],
  ];
  const envSafe = Object.hasOwn(EVENT_MODEL.ENVIRONMENTS, cfg.api.env);
  return (
    <div className="review">
      <div className="review-hero">
        <div className="review-hero-mark"><i className="fa-solid fa-rocket" /></div>
        <div className="review-hero-text">
          <strong>{summary.eventName || 'Untitled event'}</strong>
          <span>cbo.io/{cfg.basics.slug || '—'}</span>
        </div>
        <span className={`review-env ${envSafe ? 'ok' : 'warn'}`}>{cfg.api.env}</span>
      </div>
      <div className="review-rows">
        {rows.map(([icon, label, value]) => (
          <div className="review-row" key={label}>
            <span className="rr-icon"><i className={`fa-solid ${icon}`} /></span>
            <span className="rr-label">{label}</span>
            <span className="rr-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [cfg, set, setCfg, switchEnv, saveApiProfile, loadApiProfile, deleteApiProfile] = useConfig();
  const [savedPresets, setSavedPresets] = useState(loadPresetLibrary);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetNameDraft, setPresetNameDraft] = useState(null);
  const [runRequest, setRunRequest] = useState(null);
  const [testState, setTestState] = useState('idle');
  const [testError, setTestError] = useState('');
  const [slugCheck, setSlugCheck] = useState({ state: 'idle', slug: '', message: '' });
  const [step, setStep] = useState(0);
  const currentStep = WIZARD.STEPS[step];
  const goto = (n) => setStep(Math.max(0, Math.min(WIZARD.STEPS.length - 1, n)));
  const [showSettings, setShowSettings] = useState(false);
  const [quickStartId, setQuickStartId] = useState('');
  const closeSettings = () => setShowSettings(false);
  // First-run guide: shown until an org token exists or the user dismisses it.
  const [guideDismissed, setGuideDismissed] = useState(() => {
    try { return window.localStorage?.getItem('mkEvent.onboarding.firstRunGuideDismissed') === '1'; }
    catch (_) { return true; }
  });
  const dismissGuide = () => {
    setGuideDismissed(true);
    try { window.localStorage?.setItem('mkEvent.onboarding.firstRunGuideDismissed', '1'); } catch (_) { /* ignore */ }
  };
  const [theme, setTheme] = useState(() => {
    let initial = 'light';
    try { initial = window.localStorage?.getItem('mkEvent.onboarding.theme') || 'light'; }
    catch (_) { initial = 'light'; }
    // Apply during render so the saved theme is on the DOM before first paint (no light flash).
    document.documentElement.setAttribute('data-theme', initial);
    return initial;
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage?.setItem('mkEvent.onboarding.theme', theme); } catch (_) { /* ignore */ }
  }, [theme]);
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
  const overlayOpen = showSettings || Boolean(runRequest) || presetNameDraft !== null;
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
    setPresetNameDraft(suggestedName);
  };

  const confirmSavePreset = (rawName) => {
    if (!rawName || !String(rawName).trim()) return;
    const trimmedName = String(rawName).trim();
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
    setPresetNameDraft(null);
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

  const renderStepBody = () => {
    switch (currentStep.id) {
      case 'connect':
        return <ConnectStep cfg={cfg} set={set} switchEnv={switchEnv} onQuickStart={(preset) => {
          if (preset.id === 'stocked') setCfg((current) => EVENT_MODEL.importRecipeConfig(current, STOCKED_RECIPE));
          else WIZARD.applyQuickStart(setCfg, preset);
          setQuickStartId(preset.id);
        }} activeQuickStart={quickStartId} onTest={testConnection} testState={testState} testError={testError} />;
      case 'basics':
        return <BasicsBody data={cfg.basics} set={set('basics')} slugCheck={slugCheck} onCheckSlug={checkSlugAvailability} />;
      case 'bidders':
        return <BiddersBody data={cfg.bidders} set={set('bidders')} />;
      case 'items':
        return <ItemsBody data={cfg.items} set={set('items')} />;
      case 'auction':
        return <AuctionSettingsBody data={cfg.auctionSettings} bidders={cfg.bidders} set={set('auctionSettings')} />;
      case 'tickets':
        return <TicketPagesBody data={cfg.ticketPages} items={cfg.items} set={set('ticketPages')} basics={cfg.basics} api={cfg.api} />;
      case 'activity':
        return <PostCreateActivityBody data={cfg.postCreateActivity} ticketPages={cfg.ticketPages} set={set('postCreateActivity')} />;
      case 'review':
        return <ReviewStep summary={summary} cfg={cfg} />;
      default:
        return null;
    }
  };

  return (
    <>
      <AppTop cfg={cfg} onOpenSettings={() => setShowSettings(true)} />
      {!guideDismissed && !cfg.api.orgToken && !showSettings && (
        <div className="coach-mark" role="note" aria-label="First-time setup">
          <span className="coach-arrow" />
          <div className="coach-title"><i className="fa-solid fa-wand-magic-sparkles" /> First-time setup</div>
          <ol>
            <li>Raise your org&apos;s event cap first — creation fails once it&apos;s hit: <span className="coach-path">Organization page → Admin → Organization Settings → <strong>Max # of Active Events</strong></span></li>
            <li>Create and copy an org token: <span className="coach-path">API Settings → Create Token → For: <strong>Organization</strong></span></li>
            <li>Paste it in mkEvent&apos;s <strong>Settings</strong> (the gear above).</li>
          </ol>
          <div className="coach-actions">
            <button className="btn btn-primary btn-sm" onClick={() => setShowSettings(true)}>Open Settings</button>
            <button className="btn btn-ghost btn-sm" onClick={dismissGuide}>Dismiss</button>
          </div>
        </div>
      )}
      <div className="wizard">
        <StepRail cfg={cfg} slugCheck={slugCheck} step={step} onJump={goto} />
        <StepCard step={currentStep}>
          {renderStepBody()}
          <WizardFooter
            step={step}
            canCreate={WIZARD.canCreateEvent(cfg, slugCheck)}
            onBack={() => goto(step - 1)}
            onNext={() => goto(step + 1)}
            onSkip={() => goto(WIZARD.STEPS.length - 1)}
            onCreate={openRunModal}
          />
        </StepCard>
      </div>
      <input ref={importInputRef} type="file" accept="application/json,.json" onChange={importRecipe} style={{ display: 'none' }} />
      {presetNameDraft !== null && (
        <PresetNameModal initialName={presetNameDraft} onSave={confirmSavePreset} onCancel={() => setPresetNameDraft(null)} />
      )}
      {runRequest && (
        <RunModal config={runRequest.config} recipe={runRequest.recipe} onClose={() => setRunRequest(null)} />
      )}
      {showSettings && (
        <>
          <div className="settings-backdrop" onClick={closeSettings} />
          <aside className="settings-aside" role="dialog" aria-label="Settings">
            <div className="settings-aside-head">
              <h2>Settings</h2>
              <button className="btn btn-ghost btn-sm" onClick={closeSettings} aria-label="Close settings"><i className="fa-solid fa-xmark" /></button>
            </div>
            <div className="settings-aside-body">
              <section className="drawer-section">
                <h3 className="drawer-h">Appearance</h3>
                <div className="theme-toggle" role="group" aria-label="Theme">
                  <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={() => setTheme('light')}>
                    <i className="fa-solid fa-sun" /> Light
                  </button>
                  <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={() => setTheme('dark')}>
                    <i className="fa-solid fa-moon" /> Dark
                  </button>
                </div>
              </section>

              <section className="drawer-section">
                <h3 className="drawer-h">Presets &amp; recipes</h3>
                <div className="drawer-presets">
                  <PresetPicker presets={savedPresets} selectedPresetId={selectedPresetId} onSelectPreset={loadPreset} />
                  <div className="drawer-preset-actions">
                    <button className="btn btn-outline btn-sm" onClick={savePreset}><i className="fa-regular fa-bookmark" /> Save preset</button>
                    <button className="btn btn-outline btn-sm" disabled={!selectedPresetId} onClick={deletePreset}><i className="fa-regular fa-trash-can" /> Delete</button>
                    <button className="btn btn-outline btn-sm" onClick={() => importInputRef.current?.click()}><i className="fa-solid fa-file-import" /> Import recipe</button>
                    <button className="btn btn-outline btn-sm" onClick={exportRecipe}><i className="fa-regular fa-floppy-disk" /> Export recipe</button>
                  </div>
                </div>
              </section>

              <section className="drawer-section">
                <div className="drawer-h-row">
                  <h3 className="drawer-h">Connection</h3>
                  {guideDismissed && !(cfg.api.orgToken && cfg.api.selectedProfileId) && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setGuideDismissed(false);
                        try { window.localStorage?.removeItem('mkEvent.onboarding.firstRunGuideDismissed'); } catch (_) { /* ignore */ }
                      }}
                    >
                      <i className="fa-solid fa-wand-magic-sparkles" /> Show setup guide
                    </button>
                  )}
                </div>
                <SettingsBody data={cfg.api} set={set('api')} onSwitchEnv={switchEnv} onTestConnection={testConnection} testState={testState} testError={testError} onSaveProfile={saveApiProfile} onLoadProfile={loadApiProfile} onDeleteProfile={deleteApiProfile} guide={!guideDismissed && !(cfg.api.orgToken && cfg.api.selectedProfileId)} />
              </section>
            </div>
          </aside>
        </>
      )}
    </>
  );
}

export default App;
