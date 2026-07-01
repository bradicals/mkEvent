# Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin mkEvent's create-event UI into the guided 8-step Onboarding Wizard with Light/Dark theming, reusing every existing setting and the existing engine unchanged.

**Architecture:** `App.jsx` becomes a shell (top bar → step rail | step card → footer nav) that renders one existing `sections.jsx` body per step. Wizard metadata + validation live in a new pure module `wizard.js` (unit-tested). Theming is driven by a `data-theme` attribute on `<html>` + `theme.css` tokens; `app.css` is re-tokenized so both themes come for free. Presets/recipes and the theme toggle move into the existing Settings drawer.

**Tech Stack:** React 18 + Vite (renderer), plain CSS with custom properties, `node --test` for the logic module. Electron app; icons via FontAwesome 6.5.2 **Free** (CDN in `index.html`) — use `fa-solid` / `fa-regular` only (no `fa-light`).

## Global Constraints

- No new dependencies. No changes to `event-model.js`, `creation-engine.js`, `browser-fallback.cjs`, or any `src/main`/`src/preload` file.
- Section bodies in `sections.jsx` keep their FULL field set — do not trim fields. The wizard only chooses which body renders.
- Theme persists to `localStorage` key **`mkEvent.onboarding.theme`** (`"light"`/`"dark"`), default `"light"`.
- All new/edited colors must reference `var(--*)` tokens from `theme.css` — no new hard-coded hex on themed surfaces.
- Create-event enable rule = the existing strict rule (org id + org token + name + slug + startDate + endDate + onCallDate + contactFirstName + contactLastName + contactEmail + contactPhone + slug not `taken`/`invalid`).
- Reuse existing state/handlers in `App.jsx` (`useConfig`, `slugCheck`, `checkSlugAvailability`, `testConnection`, `testState`, preset handlers, `runRequest`, `showSettings`). Add only `step` and `theme`.
- Commit after each task. Run `npm test` (must stay green) before every commit.

---

## File structure

- **Create** `src/renderer/wizard.js` — pure data + logic: `STEPS`, `stepReady(cfg, id)`, `canCreateEvent(cfg, slugCheck)`, `readyCount(cfg, slugCheck)`, `QUICK_START`, `applyQuickStart(setCfg, preset)`.
- **Create** `src/renderer/wizard.test.js` — `node --test` coverage for the above.
- **Create** `src/renderer/theme.css` — copied verbatim from the handoff token file.
- **Modify** `src/renderer/app.css` — `@import './theme.css'`; tokenize colors; add wizard/rail/step-card/hero/quick-start/theme-toggle styles; tokenize run modal + drawer.
- **Modify** `src/renderer/App.jsx` — shell, wizard render tree, theme wiring, Connect extras, Review step, Settings drawer additions. `sections.jsx` bodies imported and reused unchanged.
- **Modify** `src/renderer/create-runner.jsx` — only if a color is inline in JSX (it is not today); run-modal colors live in `app.css`.

`sections.jsx` bodies are **not** edited (they already contain the real fields). The `Section` accordion component stays exported for safety but is no longer used by `App.jsx`.

---

## Task 1: Wizard logic module (`wizard.js`)

Pure functions with no React/DOM dependency, so they run under `node --test`.

**Files:**
- Create: `src/renderer/wizard.js`
- Test: `src/renderer/wizard.test.js`

**Interfaces:**
- Consumes: nothing (operates on plain `cfg` objects shaped like `EVENT_MODEL.DEFAULT_CONFIG`, and a `slugCheck` of `{ state, slug, message }`).
- Produces:
  - `STEPS`: array of `{ id, num, icon, title, subtitle }` (8 entries, order: connect, basics, bidders, items, auction, tickets, activity, review).
  - `stepReady(cfg, id) -> boolean`
  - `canCreateEvent(cfg, slugCheck) -> boolean`
  - `readyCount(cfg, slugCheck) -> number` (count of steps where `stepReady` is true)
  - `QUICK_START`: array of `{ id, icon, name, blurb, bidders, items:{silent,live,donation,quantity} }`
  - `applyQuickStart(setCfg, preset) -> void` (calls the React `setCfg` updater; merges counts into `cfg.bidders.bulk` / `cfg.items.bulk`)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/wizard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const wizard = require('./wizard.js');

const baseCfg = () => ({
  api: { env: 'stage', organizationId: '', orgToken: '' },
  basics: {
    name: '', slug: '', startDate: '', endDate: '', onCallDate: '',
    contactFirstName: '', contactLastName: '', contactEmail: '', contactPhone: '',
  },
  bidders: { bulk: { count: 5 } },
  items: { bulk: { silentCount: 5, liveCount: 0, donationCount: 0, quantityCount: 0 } },
});

const fullBasics = {
  name: 'QA Gala', slug: 'qa-gala', startDate: '2026-08-01', endDate: '2026-08-02',
  onCallDate: '2026-08-01', contactFirstName: 'A', contactLastName: 'B',
  contactEmail: 'a@b.com', contactPhone: '5551212',
};

test('STEPS has 8 steps ending in review', () => {
  assert.equal(wizard.STEPS.length, 8);
  assert.equal(wizard.STEPS[0].id, 'connect');
  assert.equal(wizard.STEPS.at(-1).id, 'review');
});

test('connect step ready only with org id + token', () => {
  const cfg = baseCfg();
  assert.equal(wizard.stepReady(cfg, 'connect'), false);
  cfg.api.organizationId = 'org1';
  cfg.api.orgToken = 'tok';
  assert.equal(wizard.stepReady(cfg, 'connect'), true);
});

test('basics step ready needs all required fields', () => {
  const cfg = baseCfg();
  assert.equal(wizard.stepReady(cfg, 'basics'), false);
  cfg.basics = { ...fullBasics };
  assert.equal(wizard.stepReady(cfg, 'basics'), true);
});

test('optional steps are always ready', () => {
  const cfg = baseCfg();
  for (const id of ['bidders', 'items', 'auction', 'tickets', 'activity']) {
    assert.equal(wizard.stepReady(cfg, id), true, id);
  }
});

test('canCreateEvent requires connect + basics and unblocked slug', () => {
  const cfg = baseCfg();
  assert.equal(wizard.canCreateEvent(cfg, null), false);
  cfg.api.organizationId = 'org1';
  cfg.api.orgToken = 'tok';
  cfg.basics = { ...fullBasics };
  assert.equal(wizard.canCreateEvent(cfg, { state: 'ok', slug: 'qa-gala' }), true);
  assert.equal(wizard.canCreateEvent(cfg, { state: 'taken', slug: 'qa-gala' }), false);
});

test('readyCount counts ready steps', () => {
  const cfg = baseCfg();
  // connect+basics not ready, review not ready => 5 optional ready
  assert.equal(wizard.readyCount(cfg, null), 5);
});

test('applyQuickStart merges counts into bulk shapes', () => {
  let cfg = baseCfg();
  const setCfg = (fn) => { cfg = fn(cfg); };
  wizard.applyQuickStart(setCfg, wizard.QUICK_START.find(p => p.id === 'stress'));
  assert.equal(cfg.bidders.bulk.count, 500);
  assert.equal(cfg.items.bulk.silentCount, 180);
  // untouched sibling fields preserved
  assert.equal(cfg.items.bulk.quantityCount, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/wizard.test.js` (or `node --test src/renderer/wizard.test.js`)
Expected: FAIL — `Cannot find module './wizard.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/wizard.js`. Written as CommonJS with an ESM-compatible shape so both `node --test` (CJS) and Vite (ESM via `import`) can load it — use `module.exports` and Vite will interop. (If the project's other renderer files are pure ESM and the test still needs CJS, keep this file CJS-only; App.jsx imports it with `import wizard from './wizard.js'` which Vite handles.)

```js
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

module.exports = { STEPS, stepReady, canCreateEvent, readyCount, QUICK_START, applyQuickStart };
```

> Note: `stepReady` takes an optional 3rd `slugCheck` arg (used only for `review`). The test calls `stepReady(cfg, id)` for non-review steps, so the arg is optional.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/renderer/wizard.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/wizard.js src/renderer/wizard.test.js
git commit -m "feat(wizard): add step metadata, validation, and quick-start presets"
```

---

## Task 2: Theme foundation (theme.css + tokenize app.css + data-theme wiring)

Bring in the token file, drive `data-theme` from a persisted `theme` state, and swap hard-coded colors in `app.css` for tokens. After this task the app still shows the OLD stacked-sections layout, but it renders correctly in both light and dark.

**Files:**
- Create: `src/renderer/theme.css`
- Modify: `src/renderer/app.css`
- Modify: `src/renderer/App.jsx` (add `theme` state + effect only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `theme` state + `setTheme` available in `App` for Task 5's toggle; `<html data-theme>` reflects it.

- [ ] **Step 1: Copy the token file**

Copy the handoff file to `src/renderer/theme.css` verbatim:

```bash
cp "/c/Users/Bradley/Downloads/mkEvent onboarding experience/design_handoff_onboarding/theme.css" src/renderer/theme.css
```

- [ ] **Step 2: Import tokens at the top of `app.css`**

Edit `src/renderer/app.css` line 1 — keep the existing font import, add the theme import right after it:

```css
@import url('../../assets/colors_and_type.css');
@import './theme.css';
```

- [ ] **Step 3: Add the theme state + persistence to `App.jsx`**

In `App()` (near the other `useState` calls, ~line 366), add:

```js
const [theme, setTheme] = useState(() => {
  try { return window.localStorage?.getItem('mkEvent.onboarding.theme') || 'light'; }
  catch (_) { return 'light'; }
});
useEffect(() => {
  document.documentElement.setAttribute('data-theme', theme);
  try { window.localStorage?.setItem('mkEvent.onboarding.theme', theme); } catch (_) { /* ignore */ }
}, [theme]);
```

(`document.documentElement` is used so `[data-theme]` sits above `#app`; no mount restructuring needed.)

- [ ] **Step 4: Tokenize `app.css` colors**

Replace hard-coded colors with tokens across `app.css`. Apply this mapping globally (search/replace, but verify each hit is a surface color, not e.g. a semantic status badge you want to keep):

| Hard-coded value | Replace with |
|---|---|
| `background: white` / `#ffffff` on shells/cards/inputs | `var(--card-bg)` (cards, drawer, modals), `var(--input-bg)` (inputs), `var(--topbar-bg)` (`.app-top`), `var(--rail-bg)` (rail) |
| body/`#app` `#f6f8fb` | `var(--bg)` |
| `#eef2f7` borders | `var(--card-border)` (cards) / `var(--topbar-border)` (top bar) / `var(--rail-border)` (rail) |
| `#e2e8f0` input borders | `var(--input-border)` |
| `#f1f5f9` dividers | `var(--divider)` |
| text `#1f2937` | `var(--text)` |
| headings `#043059` / `#0f172a` | `var(--heading)` |
| labels `#334155` | `var(--label)` |
| muted `#64748b` | `var(--muted)` |
| caption `#94a3b8` | `var(--muted2)` |
| chips bg `#f1f5f9` | `var(--chip-bg)`; chip text `#07529c` | `var(--chip-fg)` |
| prefix/test panels `#f8fafc` / `#fbfdff` | `var(--prefix-bg)` / `var(--test-bg)` |
| focus ring `border-color`/box-shadow (lines 11, 158) | `var(--accent-cyan)` + `0 0 0 3px rgba(0,163,255,0.18)` |

Explicit edits for the base rules (lines 4–11):

```css
html, body { margin: 0; padding: 0; font-family: var(--font-sans); color: var(--text); }
html, body { background: var(--bg); min-height: 100%; }
body { overflow-x: hidden; }
#app { min-height: 100vh; background: var(--bg); }

button, input, select, textarea { font-family: inherit; color: inherit; }
input, select, textarea { outline: none; }
input:focus, select:focus, textarea:focus { border-color: var(--accent-cyan); box-shadow: 0 0 0 3px rgba(0,163,255,0.18); }
```

Also tokenize: `.app-top` (bg `var(--topbar-bg)`, border `var(--topbar-border)`), `.api-pill` (bg `var(--card-bg)`, border `var(--input-border)`, text `var(--muted)`; keep `.connected` greens as-is — they are semantic), `.field ... input/select/textarea` (bg `var(--input-bg)`, border `var(--input-border)`), `.field label` → `var(--label)`, `.field .help` → `var(--muted)`, `.btn-outline` (bg `var(--card-bg)`, border `var(--input-border)`, text `var(--label)`), `.settings-aside` / `.preset-modal` / `.section` surfaces → `var(--card-bg)` + `var(--card-border)`.

> Leave semantic status colors intact (success greens, danger reds, callout blue/amber, the dark run-console — retokenized in Task 6). These read correctly on both themes.

- [ ] **Step 5: Verify build + dark theme manually**

Run: `npm run build`
Expected: build succeeds, no CSS/JS errors.

Then `npm run electron:dev` (or `npm run dev`), open dev tools, run `document.documentElement.setAttribute('data-theme','dark')` in the console.
Expected: background, top bar, cards, and inputs switch to the dark palette; text stays readable. Flip back to `light`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/theme.css src/renderer/app.css src/renderer/App.jsx
git commit -m "feat(theme): add theme.css tokens and drive data-theme from persisted setting"
```

---

## Task 3: Wizard shell — rail, step card, footer nav

Replace the stacked-`<Section>` main flow with the wizard: left step rail + single step card + footer nav. Steps 0–6 render their existing bodies; step 7 (review) is a placeholder here and filled in Task 4. The old `.page`, `page-head`, `ConfigToolbar` usage, and `AppFoot` are removed from render (helpers kept for Task 4).

**Files:**
- Modify: `src/renderer/App.jsx`
- Modify: `src/renderer/app.css` (add wizard layout styles)

**Interfaces:**
- Consumes: `wizard.STEPS`, `wizard.stepReady`, `wizard.readyCount`, `wizard.canCreateEvent` (Task 1); existing `cfg`, `set`, `switchEnv`, `slugCheck`, `checkSlugAvailability`, `openRunModal`.
- Produces: `step` state; `StepRail`, `StepCard`, `WizardFooter`, `StepBody` components in `App.jsx`.

- [ ] **Step 1: Import the wizard module**

Top of `App.jsx`, after the `create-runner` import:

```js
import * as WIZARD from './wizard.js';
```

- [ ] **Step 2: Add `step` state**

In `App()` with the other state:

```js
const [step, setStep] = useState(0);
const currentStep = WIZARD.STEPS[step];
const goto = (n) => setStep(Math.max(0, Math.min(WIZARD.STEPS.length - 1, n)));
```

- [ ] **Step 3: Add the wizard components** (in `App.jsx`, above `function App()`):

```jsx
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
          <i className="fa-solid fa-rocket-launch" /> Create event
        </button>
      ) : (
        <button className="btn btn-primary" onClick={onNext}>Continue <i className="fa-solid fa-arrow-right" /></button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add a `StepBody` switch** (renders the existing body for the current step). In `App.jsx`, inside `App()` after handlers are defined, define an inline renderer:

```jsx
const renderStepBody = () => {
  switch (currentStep.id) {
    case 'connect':
      return (
        <ConnectStep
          cfg={cfg} set={set} switchEnv={switchEnv}
          onQuickStart={(preset) => WIZARD.applyQuickStart(setCfg, preset)}
          onTest={testConnection} testState={testState} testError={testError}
        />
      );
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
      return <ReviewStep summary={summary} recipe={recipe} cfg={cfg} />;
    default:
      return null;
  }
};
```

> `ConnectStep` and `ReviewStep` are added in Task 4. For THIS task, temporarily render `<EnvironmentBody data={cfg.api} set={set('api')} onSwitchEnv={switchEnv} />` for `connect` and a `<div>Review coming next</div>` for `review`, so the shell is testable before Task 4. Replace both in Task 4.

- [ ] **Step 5: Replace the `App` return tree.** Swap the current `return (...)` (the `<AppTop/>` + `.page` + `<AppFoot/>` block, ~lines 537–591) for:

```jsx
return (
  <>
    <AppTop cfg={cfg} onOpenSettings={() => setShowSettings(true)} />
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
    {/* Settings drawer stays as-is for now; extended in Task 5 */}
    {showSettings && (
      <>
        <div className="settings-backdrop" onClick={closeSettings} />
        <aside className="settings-aside" role="dialog" aria-label="Settings">
          <div className="settings-aside-head">
            <h2>Settings</h2>
            <button className="btn btn-ghost btn-sm" onClick={closeSettings} aria-label="Close settings"><i className="fa-solid fa-xmark" /></button>
          </div>
          <div className="settings-aside-body">
            <SettingsBody data={cfg.api} set={set('api')} onTestConnection={testConnection} testState={testState} testError={testError} onSaveProfile={saveApiProfile} onLoadProfile={loadApiProfile} onDeleteProfile={deleteApiProfile} />
          </div>
        </aside>
      </>
    )}
  </>
);
```

Remove the now-unused `AppTop`'s Docs button is fine to keep. Keep `AppFoot`, `ConfigToolbar`, summary helpers defined (used in Tasks 4–5); they are just no longer rendered here.

- [ ] **Step 6: Add wizard layout styles to `app.css`** (append near the old `.layout-b` block; you may delete the dead `.layout-b*`, `.stepper*`, `.preview-card*`, `.json-preview*` rules — they are unused):

```css
/* ---- Onboarding wizard ---- */
.wizard { display: grid; grid-template-columns: 262px 1fr; min-height: calc(100vh - 64px); }
.wiz-rail { background: var(--rail-bg); border-right: 1px solid var(--rail-border); padding: 22px 16px; overflow-y: auto; }
.wiz-rail-head { padding: 0 8px 18px; }
.wiz-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted2); }
.wiz-progress { height: 6px; background: var(--track); border-radius: 9999px; overflow: hidden; margin: 12px 0 8px; }
.wiz-progress .bar { height: 100%; background: var(--accent-cyan); transition: width 0.4s ease; }
.wiz-progress-label { font-size: 11.5px; color: var(--muted); }
.wiz-rail-items { display: flex; flex-direction: column; gap: 2px; }
.wiz-rail-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: none; border-left: 3px solid transparent; background: transparent; cursor: pointer; border-radius: 0 10px 10px 0; text-align: left; }
.wiz-rail-item:hover { background: var(--divider); }
.wiz-rail-item .circle { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; background: var(--chip-bg); color: var(--muted); flex-shrink: 0; }
.wiz-rail-item .label { font-size: 13.5px; color: var(--label); }
.wiz-rail-item.is-active { border-left-color: var(--accent-cyan); background: color-mix(in srgb, var(--accent-cyan) 12%, transparent); }
.wiz-rail-item.is-active .circle { background: var(--accent-cyan); color: var(--on-accent); }
.wiz-rail-item.is-active .label { color: var(--heading); font-weight: 600; }
.wiz-rail-item.is-complete .circle { background: color-mix(in srgb, var(--accent-lime) 22%, transparent); color: var(--ok-fg); }

.wiz-main { padding: 34px 44px 44px; background: var(--bg); }
.wiz-head { max-width: 820px; margin: 0 auto 20px; }
.wiz-step-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--eyebrow); }
.wiz-title { font-size: 27px; font-weight: 700; color: var(--heading); letter-spacing: -0.015em; margin: 8px 0 4px; }
.wiz-sub { font-size: 14px; color: var(--muted); margin: 0; }
.wiz-card { max-width: 820px; margin: 0 auto; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 18px; box-shadow: var(--card-shadow); padding: 28px 30px; }
.wiz-foot { display: flex; align-items: center; gap: 12px; border-top: 1px solid var(--divider); margin-top: 26px; padding-top: 20px; }
.wiz-foot .grow { flex: 1; }

@media (max-width: 860px) {
  .wizard { grid-template-columns: 1fr; }
  .wiz-rail { border-right: none; border-bottom: 1px solid var(--rail-border); }
  .wiz-main { padding: 24px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .wiz-progress .bar, .switch, .switch::after { transition: none; }
}
```

- [ ] **Step 7: Verify**

Run: `npm test` → all green (wizard tests unaffected).
Run: `npm run build` → succeeds.
Run: `npm run electron:dev` → the 8-step rail shows; Continue/Back move between steps; each of steps 2–7 shows its full existing body; rail items jump; "Skip to review" jumps to step 8; the temporary review placeholder + disabled/enabled Create button behave with the strict rule.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.jsx src/renderer/app.css
git commit -m "feat(wizard): replace stacked sections with step rail, step card, and footer nav"
```

---

## Task 4: Connect step (quick-start + test panel) and Review step

Fill the two custom steps: `ConnectStep` (preset chips + `EnvironmentBody` + a connection-status test panel) and `ReviewStep` (hero summary card + recipe rows).

**Files:**
- Modify: `src/renderer/App.jsx`
- Modify: `src/renderer/app.css`

**Interfaces:**
- Consumes: `WIZARD.QUICK_START`, `EnvironmentBody`, existing `testConnection`/`testState`/`testError`, `summary` (from `EVENT_MODEL.summarizeRecipe`), `recipe`, `cfg`.
- Produces: `ConnectStep`, `ReviewStep` components (referenced by `renderStepBody` from Task 3).

- [ ] **Step 1: Add `ConnectStep`** (above `function App()`):

```jsx
function ConnectStep({ cfg, set, switchEnv, onQuickStart, onTest, testState, testError }) {
  const testLabel = { idle: 'Test connection', testing: 'Testing…', ok: 'Connected', fail: 'Failed' }[testState] || 'Test connection';
  const canTest = Boolean(cfg.api.organizationId && cfg.api.orgToken) && testState !== 'testing';
  return (
    <>
      <div className="quick-start">
        <div className="quick-start-eyebrow">Quick start — prefill a recipe</div>
        <div className="quick-start-chips">
          {WIZARD.QUICK_START.map((p) => (
            <button key={p.id} type="button" className="quick-chip" onClick={() => onQuickStart(p)}>
              <span className="qc-icon"><i className={`fa-solid ${p.icon}`} /></span>
              <span className="qc-text"><strong>{p.name}</strong><small>{p.blurb}</small></span>
            </button>
          ))}
        </div>
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
```

- [ ] **Step 2: Add `ReviewStep`** (above `function App()`). Reuses the existing `summarizeRecipe` output shape already consumed by `AppFoot`:

```jsx
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
        <div className="review-hero-mark"><i className="fa-solid fa-rocket-launch" /></div>
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
```

- [ ] **Step 3: Wire them into `renderStepBody`.** Replace the two temporary placeholders from Task 3 Step 4 with the real `ConnectStep` (already shown in that switch) and `ReviewStep` calls. Confirm `renderStepBody`'s `connect` case passes `onQuickStart={(preset) => WIZARD.applyQuickStart(setCfg, preset)}` and `review` renders `<ReviewStep summary={summary} cfg={cfg} />`.

- [ ] **Step 4: Add styles to `app.css`:**

```css
/* Connect step */
.quick-start { margin-bottom: 22px; }
.quick-start-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted2); margin-bottom: 10px; }
.quick-start-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.quick-chip { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--card-border); border-radius: 14px; background: var(--card-bg); cursor: pointer; text-align: left; }
.quick-chip:hover { border-color: var(--accent-cyan); }
.quick-chip .qc-icon { width: 38px; height: 38px; border-radius: 10px; background: var(--chip-bg); color: var(--chip-fg); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.quick-chip .qc-text strong { display: block; font-size: 13.5px; color: var(--heading); }
.quick-chip .qc-text small { display: block; font-size: 11.5px; color: var(--muted); margin-top: 2px; }

.test-panel { display: flex; align-items: center; gap: 14px; margin-top: 18px; padding: 14px 16px; background: var(--test-bg); border: 1px solid var(--card-border); border-radius: 12px; }
.test-panel .test-text { flex: 1; min-width: 0; }
.test-panel .test-text strong { display: block; font-size: 13px; color: var(--heading); }
.test-panel .test-text small { display: block; font-size: 12px; color: var(--muted); }
.test-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted2); flex-shrink: 0; }
.test-dot.ok { background: var(--accent-lime); }
.test-dot.fail { background: var(--req); }
.test-dot.testing { background: var(--accent-cyan); }

/* Review step */
.review-hero { display: flex; align-items: center; gap: 16px; padding: 20px; border: 1px solid var(--card-border); border-radius: 16px; background: color-mix(in srgb, var(--accent-cyan) 6%, var(--card-bg)); margin-bottom: 18px; }
.review-hero-mark { width: 56px; height: 56px; border-radius: 14px; background: var(--accent-cyan); color: var(--on-accent); display: flex; align-items: center; justify-content: center; font-size: 22px; }
.review-hero-text { flex: 1; min-width: 0; }
.review-hero-text strong { display: block; font-size: 20px; color: var(--heading); }
.review-hero-text span { font-size: 13px; color: var(--eyebrow); }
.review-env { padding: 5px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; background: var(--ok-bg); color: var(--ok-fg); }
.review-env.warn { background: #fef3c7; color: #92400e; }
.review-rows { display: flex; flex-direction: column; }
.review-row { display: grid; grid-template-columns: 40px 140px 1fr; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--divider); }
.review-row:last-child { border-bottom: none; }
.rr-icon { width: 32px; height: 32px; border-radius: 8px; background: var(--chip-bg); color: var(--chip-fg); display: flex; align-items: center; justify-content: center; }
.rr-label { font-size: 12.5px; color: var(--muted); }
.rr-value { font-size: 14px; font-weight: 600; color: var(--heading); }
```

- [ ] **Step 5: Verify**

Run: `npm test` → green. `npm run build` → succeeds.
Run: `npm run electron:dev`:
- Connect step shows 3 quick-start chips; clicking one changes bidder/item counts (verify on Bidders/Items steps).
- Test-connection button enables once org id + token are entered; running it flips the dot/label.
- Review step shows the hero + 8 recipe rows reflecting current config; env badge colored.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.jsx src/renderer/app.css
git commit -m "feat(wizard): add Connect quick-start/test panel and Review summary steps"
```

---

## Task 5: Settings drawer — Appearance toggle + moved presets/recipes

Extend the drawer with an Appearance (Light/Dark) toggle and move the preset picker + import/export recipe controls into it. The old page-head toolbar is already gone; this restores those controls in the drawer.

**Files:**
- Modify: `src/renderer/App.jsx`
- Modify: `src/renderer/app.css`

**Interfaces:**
- Consumes: `theme`/`setTheme` (Task 2), existing preset handlers (`savedPresets`, `selectedPresetId`, `loadPreset`, `savePreset`, `deletePreset`, `importInputRef`, `exportRecipe`) and `PresetPicker`.
- Produces: extended drawer markup (no new exported symbols).

- [ ] **Step 1: Add the drawer sections.** Replace the drawer's `.settings-aside-body` contents (from Task 3 Step 5) with:

```jsx
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
    <h3 className="drawer-h">Connection</h3>
    <SettingsBody data={cfg.api} set={set('api')} onTestConnection={testConnection} testState={testState} testError={testError} onSaveProfile={saveApiProfile} onLoadProfile={loadApiProfile} onDeleteProfile={deleteApiProfile} />
  </section>
</div>
```

- [ ] **Step 2: Add drawer styles to `app.css`:**

```css
.drawer-section { margin-bottom: 26px; }
.drawer-h { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted2); margin: 0 0 12px; }
.theme-toggle { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--input-border); border-radius: 12px; background: var(--prefix-bg); }
.theme-toggle button { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px; border: none; border-radius: 9px; background: transparent; color: var(--muted); font-size: 13px; font-weight: 600; cursor: pointer; }
.theme-toggle button.is-active { background: var(--card-bg); color: var(--heading); box-shadow: 0 2px 6px rgba(15,23,42,0.12); }
.drawer-presets { display: flex; flex-direction: column; gap: 12px; }
.drawer-preset-actions { display: flex; flex-wrap: wrap; gap: 8px; }
```

- [ ] **Step 3: Verify**

Run: `npm test` → green. `npm run build` → succeeds.
Run: `npm run electron:dev`, open the gear:
- Appearance toggle flips the whole app light/dark instantly and persists across reload.
- Save/load/delete preset works; Import/Export recipe works (file dialog + downloaded `.recipe.json`).
- Connection section still tests the API and manages profiles.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.jsx src/renderer/app.css
git commit -m "feat(settings): add theme toggle and move presets/recipes into the drawer"
```

---

## Task 6: Run-modal theming + cleanup

Make the run overlay theme-aware and remove dead CSS. The console body stays dark (it is a log terminal), but the backdrop and result cards use tokens so it sits correctly on both themes.

**Files:**
- Modify: `src/renderer/app.css`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Tokenize the run overlay** in `app.css`:

- `.run-overlay` background → `rgba(4,20,38,0.6)` (matches the design backdrop; readable on both themes).
- Leave `.run-modal`, `.run-body`, `.run-line*` dark (terminal styling is intentional and identical in both themes).
- `.run-progress .bar` already uses the cyan→lime gradient — keep.

- [ ] **Step 2: Remove dead CSS.** Delete the unused legacy blocks in `app.css`: `.layout-b*` (lines ~338–352), `.preview-card*` (~355–367), `.json-preview*` (~370–374), and `.stepper*` (~341–349) — confirm none are referenced (`grep -n "layout-b\|preview-card\|json-preview\|stepper" src/renderer/*.jsx` returns nothing).

- [ ] **Step 3: Confirm reduced-motion + focus.** Ensure the `@media (prefers-reduced-motion: reduce)` block (added in Task 3) also covers `.settings-aside` and `.run-overlay` animations:

```css
@media (prefers-reduced-motion: reduce) {
  .wiz-progress .bar, .switch, .switch::after,
  .settings-aside, .run-overlay, .run-progress .bar { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 4: Full verification**

Run: `npm test` → all green.
Run: `npm run build` → succeeds.
Run: `npm run electron:dev` and walk the full flow in BOTH themes:
1. All 8 steps reachable via Back/Continue and rail jumps.
2. Every field from the old UI is present on its step (spot-check Bidders bulk/exact tabs, Items, Ticket pages, Activity).
3. Skip-to-review works; Create disabled until Connect + Basics valid (strict rule).
4. Theme toggle flips everything and persists on reload.
5. Slug live-check, test-connection, presets, import/export all work.
6. Create-event opens the run modal, streams logs, and shows success/summary; copy-summary + copy-debug-report work.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app.css
git commit -m "style(run-modal): theme-aware overlay and remove dead layout CSS"
```

---

## Self-review notes

- **Spec coverage:** shell/top bar (T3), step rail (T3), 8 steps incl. Activity as its own step (T3/T4), Connect quick-start + test panel (T4), Review hero+rows (T4), footer nav + strict `canCreate` (T3), Settings drawer with Appearance + Connection + presets/recipes (T5), full theming (T2 + per-task styles), run-modal reskin (T6). All spec sections mapped.
- **Reused unchanged:** `event-model.js`, `creation-engine.js`, all `sections.jsx` bodies, `create-runner.jsx` logic, `useConfig`, slug/test/preset handlers.
- **Deferred/lazy:** quick-start presets set bidder/item counts only (no ticket-page regeneration — no model helper exists and the design lets these be tuned); run console stays dark in both themes (terminal styling). Both are intentional, noted at their tasks.
</content>
