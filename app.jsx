// Main app — QA event creator settings-only layout.

const { useState, useMemo, useRef, useEffect } = React;
const EVENT_MODEL = window.EventModel;

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(EVENT_MODEL.DEFAULT_CONFIG));
}

function loadInitialConfig() {
  const defaults = cloneDefaultConfig();
  try {
    const saved = window.localStorage?.getItem(EVENT_MODEL.LOCAL_SETTINGS_STORAGE_KEY);
    return saved ? EVENT_MODEL.importLocalSettings(defaults, JSON.parse(saved)) : defaults;
  } catch (error) {
    console.warn('Could not load mkEvent local settings:', error);
    return defaults;
  }
}

function saveLocalSettings(cfg) {
  try {
    window.localStorage?.setItem(
      EVENT_MODEL.LOCAL_SETTINGS_STORAGE_KEY,
      JSON.stringify(EVENT_MODEL.exportLocalSettings(cfg))
    );
  } catch (error) {
    console.warn('Could not save mkEvent local settings:', error);
  }
}

function useConfig() {
  const [cfg, setCfg] = useState(loadInitialConfig);
  useEffect(() => saveLocalSettings(cfg), [cfg.api]);
  const setSection = (key) => (patch) => setCfg(c => ({ ...c, [key]: { ...c[key], ...patch } }));
  return [cfg, setSection, setCfg];
}

function AppTop({ cfg }) {
  const apiConnected = Boolean(cfg.api.orgToken && cfg.api.organizationId);
  return (
    <div className="app-top">
      <div className="app-top-logo">
        <img src="assets/clickbid-mark.png" alt="ClickBid" />
        <span className="divider"></span>
        <span className="product">mkEvent <span>· QA event creator</span></span>
      </div>
      <div className="app-top-right">
        <button className={`api-pill ${apiConnected ? 'connected' : ''}`}>
          <span className="dot"></span>
          {apiConnected ? `${cfg.api.env} API ready` : 'API settings needed'}
        </button>
        <button className="btn btn-ghost btn-sm"><i className="fa-regular fa-circle-question"></i> Docs</button>
      </div>
    </div>
  );
}

function AppFoot({ cfg, recipe, summary, onCreate, onExportRecipe, onImportRecipe }) {
  const canCreate = cfg.basics.name && cfg.basics.slug && cfg.api.organizationId && cfg.api.orgToken;
  return (
    <div className="app-foot">
      <div className="summary">
        <span><strong>{summary.eventName}</strong></span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.environment}</strong></span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.bidderCount}</strong> bidders</span>
        <span className="dot-sep">·</span>
        <span><strong>{summary.itemCount}</strong> items ({summary.itemBreakdown.silent}S · {summary.itemBreakdown.live}L · {summary.itemBreakdown.donation}D)</span>
      </div>
      <div className="grow"></div>
      <button className="btn btn-outline" onClick={onImportRecipe}><i className="fa-solid fa-file-import"></i> Import recipe</button>
      <button className="btn btn-outline" onClick={onExportRecipe}><i className="fa-regular fa-floppy-disk"></i> Export recipe</button>
      <button className="btn btn-lime btn-lg" disabled={!canCreate} onClick={onCreate} title={!canCreate ? 'Enter event name, slug, organization ID, and org token first.' : 'Create event'}>
        <i className="fa-solid fa-rocket-launch"></i> Create event <span className="kbd">⌘ ⏎</span>
      </button>
    </div>
  );
}

function envSummary(api) {
  const safe = Object.hasOwn(EVENT_MODEL.ENVIRONMENTS, api.env);
  return <><span className="pill" style={{background: safe ? '#dcfce7' : '#fef3c7', color: safe ? '#166534' : '#92400e'}}>● {api.env}</span><span className="pill">{api.organizationId || 'org required'}</span></>;
}
function basicsSummary(b) { return <><span className="pill">{b.slug || 'keyword required'}</span>{b.startDate && <span className="pill">{new Date(b.startDate + 'T' + (b.startTime||'00:00')).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'})}</span>}</>; }
function biddersSummary(b) { return <><span className="pill brand">{b.count} bidders</span><span className="pill">start #{b.startNum}</span></>; }
function itemsSummary(i) { return <><span className="pill brand">{(i.silentCount || 0) + (i.liveCount || 0) + (i.donationCount || 0)} items</span><span className="pill">{i.silentCount}S · {i.liveCount}L · {i.donationCount}D</span></>; }
function settingsSummary(api) { return <><span className="pill">{api.apiBaseUrl ? 'API URL set' : 'API URL needed'}</span><span className="pill">{api.orgToken ? 'org token set' : 'org token needed'}</span></>; }

function App() {
  const [cfg, set, setCfg] = useConfig();
  const [running, setRunning] = useState(false);
  const [testState, setTestState] = useState('idle');
  const [testError, setTestError] = useState('');
  useEffect(() => { setTestState('idle'); setTestError(''); },
    [cfg.api.env, cfg.api.organizationId, cfg.api.orgToken, cfg.api.baseUrl]);
  const importInputRef = useRef(null);
  const recipe = useMemo(() => EVENT_MODEL.buildRecipe(cfg), [cfg]);
  const summary = useMemo(() => EVENT_MODEL.summarizeRecipe(recipe), [recipe]);

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
      <AppTop cfg={cfg} />
      <div className="page" data-screen-label="QA Event creator">
        <div className="page-head">
          <div>
            <div className="eyebrow-mini">Create QA event</div>
            <h1 className="page-title">New QA event configuration</h1>
            <p className="page-sub">Choose the environment, set the event basics, decide how many bidders and items to generate, then create it through the ClickBid API. Customer-facing pages use ClickBid defaults.</p>
          </div>
        </div>

        <window.Section icon="fa-server" title="Environment" sub="Where the event will be created." defaultOpen summary={envSummary(cfg.api)}>
          <window.EnvironmentBody data={cfg.api} set={set('api')} />
        </window.Section>

        <window.Section icon="fa-circle-info" title="Event basics" sub="Name, slug, schedule." defaultOpen summary={basicsSummary(cfg.basics)}>
          <window.BasicsBody data={cfg.basics} set={set('basics')} />
        </window.Section>

        <window.Section icon="fa-users" title="Bidders" sub="Generated bidder count and naming." summary={biddersSummary(cfg.bidders)}>
          <window.BiddersBody data={cfg.bidders} set={set('bidders')} />
        </window.Section>

        <window.Section icon="fa-gavel" title="Items" sub="Bulk silent, live, and donation items." defaultOpen summary={itemsSummary(cfg.items)}>
          <window.ItemsBody data={cfg.items} set={set('items')} />
        </window.Section>

        <window.Section icon="fa-key" title="Settings" sub="API URLs, bearer tokens, and fallback browser." summary={settingsSummary(cfg.api)}>
          <window.SettingsBody data={cfg.api} set={set('api')} onTestConnection={testConnection} testState={testState} testError={testError} />
        </window.Section>
      </div>
      <AppFoot
        cfg={cfg}
        recipe={recipe}
        summary={summary}
        onCreate={() => setRunning(true)}
        onExportRecipe={exportRecipe}
        onImportRecipe={() => importInputRef.current?.click()}
      />
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        onChange={importRecipe}
        style={{ display: 'none' }}
      />
      {running && <window.RunModal config={cfg} recipe={recipe} summary={summary} onClose={() => setRunning(false)} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<App />);
