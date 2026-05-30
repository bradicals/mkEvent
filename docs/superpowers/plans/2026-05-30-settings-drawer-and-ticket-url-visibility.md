# Settings Drawer + Ticket-Page URL Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API Settings into a top-right gear-triggered slide-in drawer, and make the ticket-page Form name / Display name visibly drive the public URL before creation.

**Architecture:** All UI work targets the packaged renderer tree `src/renderer/` (the live Vite/Electron app — NOT the dead root-level duplicates). Shared model logic lives in repo-root `event-model.js`. Form name and Display name already drive real creation in `browser-fallback.cjs`; this plan adds pre-create visibility (a live URL preview + summary surfacing) and aligns `summarizeRecipe`'s preview URL with what is actually created.

**Tech Stack:** React 18 (ES modules via Vite), plain CSS, Node's built-in test runner (`node --test`) for model unit tests. There is no React/jsdom test harness, so renderer changes are verified manually with `npm run dev`.

---

## Critical context for the implementer

- **Two parallel UI copies exist.** Edit ONLY `src/renderer/App.jsx`, `src/renderer/sections.jsx`, `src/renderer/app.css`. The root-level `app.jsx`, `sections.jsx`, `create-runner.jsx`, `app.css`, `mkEvent.html` are dead duplicates — do not touch them.
- **Shared model is at repo root:** `event-model.js` (NOT `src/shared/event-model.js`, which is a thin re-export shim). Tests live in repo-root `event-model.test.js`.
- **Run the app:** `npm run dev`, then open the printed `http://127.0.0.1:5173`.
- **Run model tests:** `node --test event-model.test.js`.
- **Verified facts (from live `node` eval):** default `ticketPages.enabled=false`, `preset='off'`, `pages[0].formName='tix'`, `pages[0].displayName='Tickets'`; stage `baseUrl='https://cbo.bid'`; `buildPublicEventUrl('https://cbo.bid','qa1234','gala-dinner') === 'https://qa1234.cbo.bid/gala-dinner'`; with `'tix'` or no form name it returns `'https://qa1234.cbo.bid'` (no path).

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `event-model.js` (root) | `summarizeRecipe.publicUrl` includes primary page's form name | Modify line 1614 |
| `event-model.test.js` (root) | Unit coverage for the URL behavior | Add tests |
| `src/renderer/App.jsx` | Drawer state + gear button (`AppTop`) + render `<aside>`/backdrop + Esc handler + remove inline Settings section + surface URL/display name in `AppFoot` + pass `basics`/`api` to `TicketPagesBody` | Modify |
| `src/renderer/sections.jsx` | `TicketPagesBody` accepts `basics`/`api`, renders live URL preview under Form name | Modify |
| `src/renderer/app.css` | `.gear-btn` (if needed), `.settings-backdrop`, `.settings-aside*`, slide animation, `.ticket-url-preview` | Add rules |

## Task ordering rationale

Task 1 (model fix) is pure, testable, and unblocks the summary surfacing in Task 4. Tasks 2–3 deliver the drawer (independent of the model). Tasks 4–5 deliver URL visibility. Each task ends green and committed.

---

## Task 1: Fix `summarizeRecipe.publicUrl` to include the primary form name

**Files:**
- Modify: `event-model.js:1614`
- Test: `event-model.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to the end of `event-model.test.js` (before the file's final line if there is one; otherwise append):

```javascript
test('summarizeRecipe publicUrl reflects the primary ticket-page form name', () => {
  const baseConfig = model.buildRecipe(model.DEFAULT_CONFIG);
  // Ticket pages OFF -> URL is the event root (no path).
  const offSummary = model.summarizeRecipe(baseConfig);
  assert.ok(/^https:\/\/[^/]+$/.test(offSummary.publicUrl), `expected root URL, got ${offSummary.publicUrl}`);

  // Ticket pages ON with a custom form name -> URL carries the form name.
  const withPages = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    api: { ...model.DEFAULT_CONFIG.api, env: 'stage', baseUrl: 'https://cbo.bid' },
    basics: { ...model.DEFAULT_CONFIG.basics, slug: 'qa1234' },
    ticketPages: { enabled: true, preset: 'basic', pages: [{ formName: 'gala-dinner', displayName: 'Gala' }] },
  });
  const onSummary = model.summarizeRecipe(withPages);
  assert.equal(onSummary.publicUrl, 'https://qa1234.cbo.bid/gala-dinner');

  // Ticket pages ON but default 'tix' form name -> still collapses to root.
  const withDefault = model.buildRecipe({
    ...model.DEFAULT_CONFIG,
    api: { ...model.DEFAULT_CONFIG.api, env: 'stage', baseUrl: 'https://cbo.bid' },
    basics: { ...model.DEFAULT_CONFIG.basics, slug: 'qa1234' },
    ticketPages: { enabled: true, preset: 'basic', pages: [{ formName: 'tix', displayName: 'Tickets' }] },
  });
  assert.equal(model.summarizeRecipe(withDefault).publicUrl, 'https://qa1234.cbo.bid');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="publicUrl reflects the primary ticket-page form name" event-model.test.js`
Expected: FAIL — the `gala-dinner` assertion fails because `publicUrl` is currently `https://qa1234.cbo.bid` (form name not passed).

- [ ] **Step 3: Implement the minimal fix**

In `event-model.js`, replace line 1614:

```javascript
      publicUrl: buildPublicEventUrl(recipe.environment.baseUrl || recipe.environment.publicBaseUrl, recipe.event.slug),
```

with:

```javascript
      publicUrl: buildPublicEventUrl(
        recipe.environment.baseUrl || recipe.environment.publicBaseUrl,
        recipe.event.slug,
        ticketPages.enabled && ticketPages.pages[0] ? ticketPages.pages[0].formName : '',
      ),
```

(`ticketPages` is already defined at `event-model.js:1541` as `normalizeTicketPages(recipe.ticketPages)`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="publicUrl reflects the primary ticket-page form name" event-model.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full model test suite (no regressions)**

Run: `node --test event-model.test.js`
Expected: all tests pass (same count as before + 1).

- [ ] **Step 6: Commit**

```bash
git add event-model.js event-model.test.js
git commit -m "Align summarizeRecipe publicUrl with primary ticket-page form name"
```

---

## Task 2: Move API Settings into a top-right gear-triggered drawer

**Files:**
- Modify: `src/renderer/App.jsx` (AppTop signature + gear button ~line 117–132; App state ~line 313; AppTop usage ~line 457; remove inline Settings Section ~line 504–515; add `<aside>` before closing fragment ~line 537)

There is no automated renderer test harness, so this task is verified manually in the browser.

- [ ] **Step 1: Add the `onOpenSettings` prop and gear button to `AppTop`**

In `src/renderer/App.jsx`, change the `AppTop` signature:

```jsx
function AppTop({ cfg }) {
```
to:
```jsx
function AppTop({ cfg, onOpenSettings }) {
```

Then add a gear button immediately after the Docs button. Replace:

```jsx
        <button className="btn btn-ghost btn-sm"><i className="fa-regular fa-circle-question"></i> Docs</button>
      </div>
```
with:
```jsx
        <button className="btn btn-ghost btn-sm"><i className="fa-regular fa-circle-question"></i> Docs</button>
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings} title="Settings" aria-label="Settings"><i className="fa-solid fa-gear"></i></button>
      </div>
```

- [ ] **Step 2: Add drawer state to `App`**

In `App()`, after the line:

```jsx
  const [slugCheck, setSlugCheck] = useState({ state: 'idle', slug: '', message: '' });
```
add:
```jsx
  const [showSettings, setShowSettings] = useState(false);
```

- [ ] **Step 3: Add an Escape-to-close effect**

In `App()`, after the line:

```jsx
  useEffect(() => savePresetLibrary(savedPresets), [savedPresets]);
```
add:
```jsx
  useEffect(() => {
    if (!showSettings) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setShowSettings(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showSettings]);
```

- [ ] **Step 4: Wire the gear button to open the drawer**

Replace:
```jsx
      <AppTop cfg={cfg} />
```
with:
```jsx
      <AppTop cfg={cfg} onOpenSettings={() => setShowSettings(true)} />
```

- [ ] **Step 5: Remove the inline Settings `Section`**

Delete this entire block from the page (currently ~line 504–515):

```jsx
        <Section icon="fa-key" title="Settings" sub="API URLs, bearer tokens, and fallback browser." summary={settingsSummary(cfg.api)}>
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
        </Section>
```

- [ ] **Step 6: Render the drawer**

Immediately before the closing `</>` of `App`'s return (after the `{runRequest && (...)}` block), add:

```jsx
      {showSettings && (
        <>
          <div className="settings-backdrop" onClick={() => setShowSettings(false)} />
          <aside className="settings-aside" role="dialog" aria-label="Settings">
            <div className="settings-aside-head">
              <h2>Settings</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(false)} aria-label="Close settings"><i className="fa-solid fa-xmark"></i></button>
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
```

- [ ] **Step 7: Verify in the browser (drawer markup before CSS)**

Run: `npm run dev`, open the printed URL.
Expected: a gear icon appears in the top-right next to Docs; the "Settings" section is gone from the page; clicking the gear shows the `SettingsBody` fields (unstyled overlay is fine — CSS is Task 3); Escape and clicking outside hide it. No console errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.jsx
git commit -m "Move API Settings into a top-right gear-triggered drawer"
```

---

## Task 3: Style the drawer, backdrop, and gear

**Files:**
- Modify: `src/renderer/app.css` (append new rules)

Style reference from the existing file: `.app-top-right` (line 25) lays out the header cluster with `gap: 12px`; `.btn-ghost` (line 225) is the muted button style the gear reuses; `.run-overlay` (line 269) uses `position: fixed; inset: 0; z-index: 100`; `@keyframes fadeIn` exists (line 276). The drawer must sit above the sticky footer (`z-index: 25`) and the run overlay should remain on top, so use `z-index: 90` for the drawer/backdrop.

- [ ] **Step 1: Append drawer CSS**

Append to the end of `src/renderer/app.css`:

```css
/* Settings drawer */
.settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.42);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  animation: fadeIn 0.18s ease;
}
.settings-aside {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 91;
  width: 100%;
  max-width: 520px;
  background: #fff;
  box-shadow: -10px 0 32px rgba(15, 23, 42, 0.22);
  display: flex;
  flex-direction: column;
  animation: slideInRight 0.24s ease;
}
.settings-aside-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 1px solid #eef2f7;
  flex-shrink: 0;
}
.settings-aside-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #043059;
}
.settings-aside-body {
  flex: 1;
  overflow-y: auto;
  padding: 22px;
}
@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@media (max-width: 640px) {
  .settings-aside { max-width: 100%; }
}
```

- [ ] **Step 2: Verify styling in the browser**

Run: `npm run dev` (or reload if already running).
Expected: clicking the gear slides a white panel in from the right over a dimmed, slightly blurred backdrop; the panel has a "Settings" header with an ✕ close button; the body scrolls if the form is tall; ✕, backdrop click, and Escape all close it; on a narrow window the panel fills the width. Opening the Create-event run modal (if reachable) still appears above the drawer.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app.css
git commit -m "Style the settings drawer, backdrop, and gear button"
```

---

## Task 4: Surface the public URL and display name in the footer summary

**Files:**
- Modify: `src/renderer/App.jsx` (`AppFoot` summary block ~line 219–228)

`summary.publicUrl` now reflects the primary form name (Task 1), and `AppFoot` already receives `summary` as a prop, so the footer just needs to render it. The public URL was previously invisible anywhere in the UI; the display name is surfaced separately in the ticket-page section preview (Task 5), where `page.displayName` already lives.

- [ ] **Step 1: Add the URL + display-name pills to the summary**

In `src/renderer/App.jsx`, inside `AppFoot`'s `.summary` div, replace:

```jsx
        <span className="dot-sep">·</span>
        <span><strong>{summary.ticketPages.enabled ? summary.ticketPages.pageCount : 0}</strong> ticket pages</span>
      </div>
```
with:
```jsx
        <span className="dot-sep">·</span>
        <span><strong>{summary.ticketPages.enabled ? summary.ticketPages.pageCount : 0}</strong> ticket pages</span>
        {summary.publicUrl && (
          <>
            <span className="dot-sep">·</span>
            <span className="summary-url" title={summary.publicUrl}>{summary.publicUrl.replace(/^https?:\/\//, '')}</span>
          </>
        )}
      </div>
```

- [ ] **Step 2: Verify in the browser**

Run: `npm run dev`. In the Ticket pages section set preset to Basic and change Form name to e.g. `gala-dinner`; set a valid Event keyword in Event basics.
Expected: the footer summary shows the public URL host/path (e.g. `qa1234.cbo.bid/gala-dinner`); changing the Form name to `tix` drops the `/gala-dinner` path; the full URL shows on hover.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.jsx
git commit -m "Surface the ticket-page public URL in the footer summary"
```

---

## Task 5: Live URL preview under the Form name field

**Files:**
- Modify: `src/renderer/sections.jsx` (`TicketPagesBody` signature ~line 683; Form name help text ~line 916)
- Modify: `src/renderer/App.jsx` (`TicketPagesBody` invocation ~line 497)

The preview uses the exact shared functions that creation uses, so it can never drift: `MODEL.slugifyForClickBid(basics.slug || basics.name)` for the slug (matching `buildRecipe`), and `MODEL.buildPublicEventUrl(api.baseUrl, slug, page.formName)` for the URL. With form name `tix` (or empty) the URL has no path; otherwise it appends `/<formName>`.

- [ ] **Step 1: Accept `basics` and `api` props in `TicketPagesBody`**

In `src/renderer/sections.jsx`, change:

```jsx
export function TicketPagesBody({ data, items, set }) {
```
to:
```jsx
export function TicketPagesBody({ data, items, set, basics = {}, api = {} }) {
```

- [ ] **Step 2: Compute the preview URL**

In `src/renderer/sections.jsx`, immediately after the line:

```jsx
  const page = ticketPages.pages[0] || MODEL.DEFAULT_CONFIG.ticketPages.pages[0];
```
add:
```jsx
  const previewSlug = MODEL.slugifyForClickBid(basics.slug || basics.name || '');
  const previewUrl = previewSlug && api.baseUrl
    ? MODEL.buildPublicEventUrl(api.baseUrl, previewSlug, page.formName)
    : '';
```

- [ ] **Step 3: Render the preview under the Form name field**

In `src/renderer/sections.jsx`, replace:

```jsx
          <div className="help">ClickBid default form is <code>tix</code>.</div>
```
with:
```jsx
          <div className="help">ClickBid default form is <code>tix</code>.</div>
          <div className="ticket-url-preview">
            {previewUrl
              ? <>Public URL: <code>{previewUrl.replace(/^https?:\/\//, '')}</code> · Title: <strong>{page.displayName || 'Tickets'}</strong></>
              : <span className="muted">Set an event keyword to preview the public URL.</span>}
          </div>
```

- [ ] **Step 4: Pass `basics` and `api` from `App.jsx`**

In `src/renderer/App.jsx`, replace:

```jsx
          <TicketPagesBody data={cfg.ticketPages} items={cfg.items} set={set('ticketPages')} />
```
with:
```jsx
          <TicketPagesBody data={cfg.ticketPages} items={cfg.items} set={set('ticketPages')} basics={cfg.basics} api={cfg.api} />
```

- [ ] **Step 5: Add preview styling**

Append to the end of `src/renderer/app.css`:

```css
.ticket-url-preview {
  margin-top: 6px;
  font-size: 13px;
  color: #475569;
}
.ticket-url-preview code {
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  color: #043059;
}
.ticket-url-preview .muted {
  color: #94a3b8;
}
```

- [ ] **Step 6: Verify in the browser**

Run: `npm run dev`. Set an Event keyword (e.g. `qa1234`), open Ticket pages, set preset Basic.
Expected: under Form name, "Public URL: `qa1234.cbo.bid` · Title: **Tickets**" for `tix`; typing `gala-dinner` updates the URL live to `qa1234.cbo.bid/gala-dinner`; editing Display name updates the "Title:" value; clearing the Event keyword shows the "Set an event keyword…" hint. The previewed URL matches the footer summary URL from Task 4.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/sections.jsx src/renderer/App.jsx src/renderer/app.css
git commit -m "Add live public-URL preview under the ticket-page Form name"
```

---

## Final verification

- [ ] **Run the full model test suite**

Run: `node --test event-model.test.js`
Expected: all tests pass.

- [ ] **Manual smoke (`npm run dev`)**

Confirm end to end: gear opens/closes the drawer (✕ / backdrop / Esc); Settings is no longer inline; Environment still inline; ticket-page Form name drives both the in-section preview and the footer URL; default `tix` collapses to the bare host; display name edits persist. No console errors.

- [ ] **Offer the optional follow-up**

Remind the user that deleting the dead root duplicates (`app.jsx`, `sections.jsx`, `create-runner.jsx`, `app.css`, `mkEvent.html`) is a separate, optional cleanup before packaging — not part of this branch unless they ask.
