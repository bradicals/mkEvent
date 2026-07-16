# Custom Payment Types + Butler Checkouts + Custom Window Chrome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mkEvent seeds per-event custom "Other" payment types at event creation, checks out winning bidders through butler using them, and replaces the stock Electron window chrome with themed custom controls.

**Architecture:** Three layers per the spec ([2026-07-16 design](../specs/2026-07-16-custom-payment-types-and-titlebar-design.md)): (1) the event model gains `auctionSettings.customPaymentTypes` and `postCreateActivity.butlerCheckouts`, flowing through recipes automatically via the section normalizers; (2) the Playwright browser fallback seeds types via ClickBid's JSON endpoint during `applyAuctionSettings` and performs butler checkouts during `applyPostCreateActivity`; (3) the wizard UI gets a chip-list editor (Auction step) and per-type count inputs (Activity step). Window chrome is frameless `BrowserWindow` + 3 IPC handlers + a `TitleBar` React component.

**Tech Stack:** Plain JS (no TypeScript), React 18 (JSX), Electron, Playwright (in browser-fallback child process), `node --test` + `node:assert/strict` for tests.

## Global Constraints

- No new dependencies. Plain JS; the model file is a UMD factory — new functions go inside it.
- Edit the ROOT files `event-model.js`, `creation-engine.js`, `browser-fallback.cjs` — the files under `src/shared/` are re-export shims. Never edit the shims.
- ClickBid contract values (verbatim from spec): endpoint `POST {base}/app/public/admin/{eventSlug}/custom-payment-types` with JSON `{"name": ...}` + `X-CSRF-TOKEN` from page meta; name rule `min 3 / max 100 chars`; butler checkout posts `payTypeId=99`, `checkOutMethodId=4`, `rows` as a JSON-encoded **string**, and optional `customPaymentTypeId`.
- Stocked defaults for custom payment types: `['Venmo', 'Zelle', 'Gift Card']`. Missing field → stocked defaults; explicitly empty array → stays empty.
- All engine steps record into `applied`/`skipped`/`warnings` — failures warn, never throw past the section.
- Tests: `npm test` (runs `node --test`, discovering `*.test.js`). Run from repo root.
- Windows-only app: titlebar icons use the `Segoe MDL2 Assets` system font via JSX escapes (minimize `'\uE921'`, maximize `'\uE922'`, restore `'\uE923'`, close `'\uE8BB'`).
- Style every new surface with existing `var(--*)` theme tokens (light/dark safe).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Model — `auctionSettings.customPaymentTypes`

**Files:**
- Modify: `event-model.js` (DEFAULT_CONFIG ~line 243, new normalizer ~line 500, `normalizeAuctionSettings` ~line 459, exports ~line 1835)
- Test: `event-model.test.js` (add after the admin-fee tests, ~line 899)

**Interfaces:**
- Consumes: existing `clampString(value, max)` (event-model.js:335), `DEFAULT_CONFIG`.
- Produces: `normalizeCustomPaymentTypes(value) -> string[]` (exported); `normalizeAuctionSettings(...)` result gains `customPaymentTypes: string[]`. Tasks 3 and 5 rely on the exact field name `customPaymentTypes`.

- [ ] **Step 1: Write the failing tests**

Append to `event-model.test.js` (after the admin-fee-description test, ~line 899):

```js
test('custom payment types: stocked defaults, empty stays empty, comma string, trim/clamp/dedupe', () => {
  assert.deepEqual(model.normalizeAuctionSettings().customPaymentTypes, ['Venmo', 'Zelle', 'Gift Card']);
  assert.deepEqual(model.normalizeAuctionSettings({ customPaymentTypes: [] }).customPaymentTypes, []);
  assert.deepEqual(
    model.normalizeAuctionSettings({ customPaymentTypes: 'Venmo, PayPal ,  xy' }).customPaymentTypes,
    ['Venmo', 'PayPal'],
  );
  assert.deepEqual(
    model.normalizeAuctionSettings({ customPaymentTypes: ['Venmo', 'venmo', '  Zelle  '] }).customPaymentTypes,
    ['Venmo', 'Zelle'],
  );
  const long = 'x'.repeat(120);
  assert.equal(model.normalizeAuctionSettings({ customPaymentTypes: [long] }).customPaymentTypes[0].length, 100);
});

test('custom payment types round-trip through recipes and exports', () => {
  const config = {
    api: model.DEFAULT_CONFIG.api,
    basics: { ...model.DEFAULT_CONFIG.basics, startDate: '2026-06-01', endDate: '2026-06-02', onCallDate: '2026-06-02' },
    bidders: model.DEFAULT_CONFIG.bidders,
    items: model.DEFAULT_CONFIG.items,
    auctionSettings: { ...model.DEFAULT_CONFIG.auctionSettings, customPaymentTypes: ['Student Account'] },
  };
  assert.deepEqual(model.buildRecipe(config).auctionSettings.customPaymentTypes, ['Student Account']);
  assert.deepEqual(model.exportRecipeConfig(config).auctionSettings.customPaymentTypes, ['Student Account']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test event-model.test.js`
Expected: the two new tests FAIL (`customPaymentTypes` is `undefined`).

- [ ] **Step 3: Implement**

In `event-model.js`:

(a) `DEFAULT_CONFIG.auctionSettings` — add after `enableLink: false,` (line 243):

```js
      customPaymentTypes: ['Venmo', 'Zelle', 'Gift Card'],
```

(b) Add the normalizer directly after `normalizeCustomQuestionAnswers` (after line 500):

```js
  // Ticket 7720: per-event custom "Other" payment types. ClickBid validates
  // name min:3/max:100, so mirror that here to keep seeding from 422ing.
  function normalizeCustomPaymentTypes(value) {
    if (value === undefined || value === null) {
      return [...DEFAULT_CONFIG.auctionSettings.customPaymentTypes];
    }
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];
    const seen = new Set();
    const result = [];
    raw.forEach((name) => {
      const clean = clampString(name, 100).trim();
      if (clean.length < 3) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(clean);
    });
    return result;
  }
```

(c) In `normalizeAuctionSettings`, add after `enableLink: Boolean(base.enableLink),` (line 459):

```js
      customPaymentTypes: normalizeCustomPaymentTypes(base.customPaymentTypes),
```

(d) In the exports object (~line 1835, alphabetical region), add after `normalizeAuctionSettings,`:

```js
    normalizeCustomPaymentTypes,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test event-model.test.js`
Expected: PASS, no other tests broken.

- [ ] **Step 5: Commit**

```bash
git add event-model.js event-model.test.js
git commit -m "feat(model): auctionSettings.customPaymentTypes with stocked defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Model — `postCreateActivity.butlerCheckouts`

**Files:**
- Modify: `event-model.js` (DEFAULT_CONFIG ~line 315, new normalizer near `normalizeAuctionActivity` ~line 651, `normalizePostCreateActivity` ~line 789)
- Test: `event-model.test.js`

**Interfaces:**
- Consumes: `clampString` (event-model.js:335).
- Produces: normalized `postCreateActivity.butlerCheckouts = { enabled: boolean, perType: { [typeName]: positiveInt } }`. Tasks 4 and 7 rely on the exact names `butlerCheckouts`, `enabled`, `perType`.

- [ ] **Step 1: Write the failing test**

Append to `event-model.test.js`:

```js
test('butler checkouts: default off, counts coerced, short names and zero counts dropped', () => {
  const off = model.normalizePostCreateActivity({}, model.DEFAULT_CONFIG.ticketPages);
  assert.deepEqual(off.butlerCheckouts, { enabled: false, perType: {} });

  const normalized = model.normalizePostCreateActivity({
    butlerCheckouts: {
      enabled: true,
      perType: { Venmo: '2', xy: 5, Zelle: -3, 'Gift Card': 0 },
    },
  }, model.DEFAULT_CONFIG.ticketPages);
  assert.deepEqual(normalized.butlerCheckouts, { enabled: true, perType: { Venmo: 2 } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test event-model.test.js`
Expected: FAIL (`butlerCheckouts` is `undefined`).

- [ ] **Step 3: Implement**

In `event-model.js`:

(a) `DEFAULT_CONFIG.postCreateActivity` — add after the `donationActivity` block (after line 328's closing `},`):

```js
      butlerCheckouts: {
        enabled: false,
        perType: {},
      },
```

(b) Add after `normalizeDonationActivity` (after line 665):

```js
  // Butler checkouts of winning bids using custom "Other" payment types.
  // perType maps a custom type name -> number of bidder-checkouts using it.
  // Unknown-on-event names are warned about at runtime, not dropped here.
  function normalizeButlerCheckouts(section) {
    const base = section || {};
    const perType = {};
    Object.entries(base.perType || {}).forEach(([name, count]) => {
      const clean = clampString(name, 100).trim();
      const n = Math.floor(Number(count) || 0);
      if (clean.length >= 3 && n > 0) perType[clean] = n;
    });
    return { enabled: Boolean(base.enabled), perType };
  }
```

(c) In `normalizePostCreateActivity`'s return object, add after `donationActivity: normalizeDonationActivity(base.donationActivity),` (line 789):

```js
      butlerCheckouts: normalizeButlerCheckouts(base.butlerCheckouts),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test event-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add event-model.js event-model.test.js
git commit -m "feat(model): postCreateActivity.butlerCheckouts with per-type counts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Renderer — chip-list editor in Auction Settings

**Files:**
- Modify: `src/renderer/sections.jsx` (AuctionSettingsBody, insert after the "Enable Link?" field closing `</div>` at line 620)
- Modify: `src/renderer/app.css` (append chip styles)

**Interfaces:**
- Consumes: `settings.customPaymentTypes` (Task 1), `set({ customPaymentTypes })` section patcher, existing `.field`/`.help`/`.btn btn-outline btn-sm` classes and `--chip-bg`/`--chip-fg` tokens.
- Produces: chip-list UI writing `string[]` to `cfg.auctionSettings.customPaymentTypes`.

- [ ] **Step 1: Add local draft state + chip JSX**

In `AuctionSettingsBody` (sections.jsx:568), add below the `setBool` line (573):

```jsx
  const customPaymentTypes = Array.isArray(settings.customPaymentTypes) ? settings.customPaymentTypes : [];
  const [typeDraft, setTypeDraft] = useState('');
  const addCustomPaymentType = () => {
    const name = typeDraft.trim();
    if (name.length < 3 || name.length > 100) return;
    if (customPaymentTypes.some((t) => t.toLowerCase() === name.toLowerCase())) return;
    set({ customPaymentTypes: [...customPaymentTypes, name] });
    setTypeDraft('');
  };
```

Note: `useState` is already imported at the top of sections.jsx.

Insert after the "Enable Link?" field's closing `</div>` (line 620), inside the Payments grid:

```jsx
        <div className="field span-full">
          <label>Other payment types</label>
          <div className="chip-list">
            {customPaymentTypes.map((name) => (
              <span key={name} className="chip">
                {name}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${name}`}
                  onClick={() => set({ customPaymentTypes: customPaymentTypes.filter((t) => t !== name) })}
                >
                  <i className="fa-solid fa-xmark" />
                </button>
              </span>
            ))}
            {customPaymentTypes.length === 0 && (
              <span className="help">No custom types — the event keeps only built-in payment methods.</span>
            )}
          </div>
          <div className="chip-add">
            <input
              value={typeDraft}
              placeholder="e.g. Venmo"
              maxLength={100}
              onChange={(e) => setTypeDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomPaymentType(); } }}
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={addCustomPaymentType}>
              <i className="fa-solid fa-plus" /> Add
            </button>
          </div>
          <div className="help">Seeded on the new event under Payments → Other. Volunteers pick these from a dropdown at butler checkout. 3–100 characters each.</div>
        </div>
```

- [ ] **Step 2: Add chip styles**

Append to `src/renderer/app.css`:

```css
/* Custom payment type chips (Auction Settings → Payments) */
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 28px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--chip-bg); color: var(--chip-fg);
  border-radius: 9999px; padding: 4px 6px 4px 12px;
  font-size: 12px; font-weight: 600;
}
.chip-remove {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  border-radius: 9999px; width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 11px;
}
.chip-remove:hover { background: #fef2f2; color: #b91c1c; }
.chip-add { display: flex; gap: 8px; margin-top: 8px; }
.chip-add input { flex: 1; }
```

- [ ] **Step 3: Verify in the running app**

Run: `npm run electron:dev`
Expected on the Auction step → Payments group: three default chips (Venmo, Zelle, Gift Card); removing one updates the list; adding "PayPal" via Enter and via the Add button works; entries under 3 chars and duplicates (case-insensitive) are ignored; chips look right in both light and dark theme (Settings → Appearance).

- [ ] **Step 4: Run the full test suite (guard against regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/sections.jsx src/renderer/app.css
git commit -m "feat(ui): chip-list editor for custom Other payment types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Renderer — butler checkouts block in the Activity step

**Files:**
- Modify: `src/renderer/App.jsx:641` (pass `auctionSettings` prop)
- Modify: `src/renderer/sections.jsx` (PostCreateActivityBody signature at 1113; new grid before the component's closing `</div>` at line 1343)

**Interfaces:**
- Consumes: `activity.butlerCheckouts` (Task 2 normalization), `cfg.auctionSettings.customPaymentTypes` (Task 1), existing `commit()` helper (sections.jsx:1144), `Switch`, `.callout warn` pattern.
- Produces: UI writing `postCreateActivity.butlerCheckouts = { enabled, perType }`.

- [ ] **Step 1: Pass the prop**

App.jsx line 641, change:

```jsx
        return <PostCreateActivityBody data={cfg.postCreateActivity} ticketPages={cfg.ticketPages} set={set('postCreateActivity')} />;
```

to:

```jsx
        return <PostCreateActivityBody data={cfg.postCreateActivity} ticketPages={cfg.ticketPages} auctionSettings={cfg.auctionSettings} set={set('postCreateActivity')} />;
```

- [ ] **Step 2: Extend the component**

sections.jsx:1113, change the signature:

```jsx
export function PostCreateActivityBody({ data, ticketPages, auctionSettings, set }) {
```

Below `commitPaymentMix` (line 1148), add:

```jsx
  const butler = activity.butlerCheckouts || MODEL.DEFAULT_CONFIG.postCreateActivity.butlerCheckouts;
  const commitButler = (patch) => commit({ butlerCheckouts: { ...butler, ...patch } });
  const commitButlerCount = (name, value) => commitButler({
    perType: { ...(butler.perType || {}), [name]: Math.max(0, Number(value) || 0) },
  });
  const customTypeNames = Array.isArray(auctionSettings?.customPaymentTypes)
    ? auctionSettings.customPaymentTypes
    : MODEL.DEFAULT_CONFIG.auctionSettings.customPaymentTypes;
```

Insert this grid after the donation-activity grid's closing `</div>` (line 1342), before the component's final `</div>`:

```jsx
      <div className="form-grid cols-3" style={{ opacity: activityDisabled ? 0.45 : 1, pointerEvents: activityDisabled ? 'none' : 'auto' }}>
        <div className="field span-full">
          <div className="callout">
            <i className="fa-solid fa-cash-register"></i>
            <div><strong>Butler checkouts</strong> — checks out winning bidders through butler using the event&apos;s custom “Other” payment types. Donation bids check out immediately; silent/live bids only count once their items close.</div>
          </div>
        </div>
        <div className="field">
          <label>Seed butler checkouts</label>
          <div className="toggle-row" style={{ height: 40, padding: '8px 12px' }}>
            <div className="sub">Check out winners with Other payment types.</div>
            <Switch on={butler.enabled} onClick={() => commitButler({ enabled: !butler.enabled })} />
          </div>
        </div>
        {butler.enabled && customTypeNames.length === 0 && (
          <div className="field span-full">
            <div className="callout warn">
              <i className="fa-solid fa-triangle-exclamation"></i>
              <div><strong>No custom payment types</strong> — add them under Auction Settings → Payments → Other payment types first.</div>
            </div>
          </div>
        )}
        {butler.enabled && !auction.enabled && !donations.enabled && (
          <div className="field span-full">
            <div className="callout warn">
              <i className="fa-solid fa-triangle-exclamation"></i>
              <div><strong>Nothing to check out</strong> — enable auction or donation activity above so bidders have unpaid winning bids.</div>
            </div>
          </div>
        )}
        {customTypeNames.map((name) => (
          <div className="field" key={name}>
            <label>{name} checkouts</label>
            <input
              type="number"
              min="0"
              value={butler.perType?.[name] ?? 0}
              disabled={!butler.enabled}
              onChange={(e) => commitButlerCount(name, e.target.value)}
            />
          </div>
        ))}
      </div>
```

- [ ] **Step 3: Verify in the running app**

Run: `npm run electron:dev`
Expected on the Activity step: new "Butler checkouts" group; toggle enables per-type count inputs (one per chip from the Auction step); disabling both auction + donation activity while butler is enabled shows the warning callout; removing all chips on the Auction step shows the "No custom payment types" callout.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.jsx src/renderer/sections.jsx
git commit -m "feat(ui): butler checkout counts per custom payment type in Activity step

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Engine — seed custom payment types during auction settings

**Files:**
- Modify: `browser-fallback.cjs` (new helpers after `stripeOnboardingPost` ~line 242; `applyAuctionSettings` signature at 372 + new block after line 450; call site at 2927; exports at ~3019)
- Test: `browser-fallback.test.js`

**Interfaces:**
- Consumes: `payload.auctionSettings.customPaymentTypes` (already flows — creation-engine.js:267 passes the whole section), `eventSlug` local at browser-fallback.cjs:2917.
- Produces: `seedCustomPaymentTypes(page, eventSlug, names) -> { applied: [{setting,applied,name,id}], warnings: [{setting,name,message}] }` (exported); `applyAuctionSettings(page, baseUrl, eventId, eventSlug, settings)` — **note the new 4th parameter**.

- [ ] **Step 1: Write the failing test**

Append to `browser-fallback.test.js`:

```js
test('seedCustomPaymentTypes posts each name in-page and records applied/warnings', async () => {
  const calls = [];
  const page = {
    evaluate: async (_fn, arg) => {
      calls.push(arg);
      if (arg.typeName === 'xy') {
        return { status: 422, body: { message: 'The name field must be at least 3 characters.' } };
      }
      return { status: 200, body: { success: true, custom_payment_type: { id: calls.length, name: arg.typeName } } };
    },
  };

  const result = await fallback.seedCustomPaymentTypes(page, 'my-event', ['Venmo', 'xy', 'Zelle']);

  assert.deepEqual(calls.map((c) => c.slug), ['my-event', 'my-event', 'my-event']);
  assert.equal(result.applied.length, 2);
  assert.equal(result.applied[0].name, 'Venmo');
  assert.equal(result.applied[0].id, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /at least 3 characters/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test browser-fallback.test.js`
Expected: FAIL (`fallback.seedCustomPaymentTypes is not a function`).

- [ ] **Step 3: Implement**

In `browser-fallback.cjs`, add after `stripeOnboardingPost` (after line 242):

```js
// Ticket 7720: create a per-event custom "Other" payment type via ClickBid's
// Laravel endpoint. In-page fetch so session cookies + the page's csrf meta
// ride along (mirrors ClickBid's own admin fetch helper).
async function postCustomPaymentType(page, eventSlug, name) {
  return page.evaluate(async ({ slug, typeName }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const response = await fetch(`/app/public/admin/${slug}/custom-payment-types`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-TOKEN': csrf,
      },
      body: JSON.stringify({ name: typeName }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { success: false, message: text };
    }
    return { status: response.status, body: json };
  }, { slug: eventSlug, typeName: name });
}

async function seedCustomPaymentTypes(page, eventSlug, names) {
  const applied = [];
  const warnings = [];
  for (const name of (Array.isArray(names) ? names : [])) {
    try {
      const result = await postCustomPaymentType(page, eventSlug, name);
      if (result.status < 400 && result.body?.success) {
        applied.push({ setting: 'customPaymentTypes', applied: true, name, id: result.body?.custom_payment_type?.id });
      } else {
        warnings.push({ setting: 'customPaymentTypes', name, message: result.body?.message || `HTTP ${result.status}` });
      }
    } catch (error) {
      warnings.push({ setting: 'customPaymentTypes', name, message: error.message });
    }
  }
  return { applied, warnings };
}
```

Change the `applyAuctionSettings` signature (line 372):

```js
async function applyAuctionSettings(page, baseUrl, eventId, eventSlug, settings) {
```

Add after the `adminFeeDescription` block (after line 450, before the summary stderr write):

```js
  if (Array.isArray(requested.customPaymentTypes) && requested.customPaymentTypes.length) {
    const seeded = await seedCustomPaymentTypes(page, eventSlug, requested.customPaymentTypes);
    seeded.applied.forEach(record);
    warnings.push(...seeded.warnings);
  }
```

Update the call site (line 2927):

```js
      auctionSettingsResult = await applyAuctionSettings(page, payload.baseUrl, eventId, eventSlug, payload.auctionSettings);
```

Add to `module.exports` (after `seedCustomPaymentTypes`'s alphabetical neighbors; e.g. after `resolveTicketPurchasePaymentSupport,` around line 3037):

```js
  seedCustomPaymentTypes,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test browser-fallback.test.js`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add browser-fallback.cjs browser-fallback.test.js
git commit -m "feat(engine): seed custom Other payment types during auction settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Engine — pure butler-checkout builders (plan + post data)

**Files:**
- Modify: `browser-fallback.cjs` (add near `buildTicketPurchaseExecutionPlan` ~line 1420; exports ~3019)
- Test: `browser-fallback.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (both exported, used by Task 7):
  - `buildButlerCheckoutPlan(perType, typeIdsByName) -> { plan: [{typeName, typeId}], warnings: [] }` where `typeIdsByName` is a `Map<lowercasedName, {id, name}>`.
  - `buildButlerCheckoutPostData({ csrfToken, bidderId, scraped, customPaymentTypeId }) -> form-fields object` where `scraped` is `{ rows, firstName, lastName, address, address2, city, state, zip, fmvAmount, bidAmount, donationAmount }`.

- [ ] **Step 1: Write the failing tests**

Append to `browser-fallback.test.js`:

```js
test('buildButlerCheckoutPlan expands per-type counts and warns on unknown types', () => {
  const typeIds = new Map([
    ['venmo', { id: '281', name: 'Venmo' }],
    ['zelle', { id: '282', name: 'Zelle' }],
  ]);
  const { plan, warnings } = fallback.buildButlerCheckoutPlan({ Venmo: 2, Zelle: 1, Missing: 3 }, typeIds);

  assert.deepEqual(plan, [
    { typeName: 'Venmo', typeId: '281' },
    { typeName: 'Venmo', typeId: '281' },
    { typeName: 'Zelle', typeId: '282' },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Missing/);
});

test('buildButlerCheckoutPostData computes totals from rows and JSON-stringifies them', () => {
  const scraped = {
    rows: [
      { itemId: '644788', bidId: '1990465', taxable: '1', taxRate: '7', taxAmount: 1.75, typeId: 40, fmv: '0', quantityCount: '3', quantityPurchased: '1', subTotal: 25 },
      { itemId: '644789', bidId: '1990466,1990467', taxable: '0', taxRate: '0', taxAmount: 0, typeId: 30, fmv: '0', quantityCount: 0, quantityPurchased: '', subTotal: 40 },
    ],
    firstName: 'QA', lastName: 'Automation',
    address: '', address2: '', city: '', state: '', zip: '',
    fmvAmount: 0, bidAmount: 25, donationAmount: 40,
  };

  const postData = fallback.buildButlerCheckoutPostData({
    csrfToken: 'tok123', bidderId: 3398207, scraped, customPaymentTypeId: '281',
  });

  assert.equal(postData.action, 'checkout');
  assert.equal(postData.csrf, 'tok123');
  assert.equal(postData.bidderId, '3398207');
  assert.equal(postData.payTypeId, '99');
  assert.equal(postData.checkOutMethodId, '4');
  assert.equal(postData.checkNumber, '');
  assert.equal(postData.taxAmount, '1.75');
  assert.equal(postData.totalAmount, '66.75'); // 25 + 1.75 + 40
  assert.equal(postData.customPaymentTypeId, '281');
  assert.equal(typeof postData.rows, 'string');
  assert.equal(JSON.parse(postData.rows).length, 2);

  const noType = fallback.buildButlerCheckoutPostData({ csrfToken: 't', bidderId: 1, scraped });
  assert.equal('customPaymentTypeId' in noType, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test browser-fallback.test.js`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement**

In `browser-fallback.cjs`, add after `buildTicketPurchaseExecutionPlan` (after ~line 1430):

```js
function buildButlerCheckoutPlan(perType, typeIdsByName) {
  const plan = [];
  const warnings = [];
  Object.entries(perType || {}).forEach(([name, count]) => {
    const match = typeIdsByName.get(String(name).toLowerCase());
    if (!match) {
      warnings.push({ section: 'butlerCheckouts', name, message: `custom payment type "${name}" not found on the event` });
      return;
    }
    const n = Math.max(0, Math.floor(Number(count) || 0));
    for (let i = 0; i < n; i += 1) plan.push({ typeName: match.name, typeId: match.id });
  });
  return { plan, warnings };
}

// Builds the urlencoded fields for POST /ajax/butler/checkout.php exactly like
// ClickBid's butler checkout.js: rows are a JSON string (max_input_vars dodge),
// payTypeId=99 is "Other" (skips payment processing), checkOutMethodId=4 is
// the Butler channel. The server enforces sum(rows subTotal+taxAmount) ==
// its own recomputed total == totalAmount, so totals derive from the rows.
function buildButlerCheckoutPostData({ csrfToken, bidderId, scraped, customPaymentTypeId }) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const taxAmount = scraped.rows.reduce((sum, row) => sum + (Number(row.taxAmount) || 0), 0);
  const totalAmount = scraped.rows.reduce(
    (sum, row) => sum + (Number(row.subTotal) || 0) + (Number(row.taxAmount) || 0),
    0,
  );
  return {
    action: 'checkout',
    csrf: csrfToken,
    bidderId: String(bidderId),
    fmvAmount: String(scraped.fmvAmount ?? 0),
    bidAmount: String(scraped.bidAmount ?? 0),
    donationAmount: String(scraped.donationAmount ?? 0),
    taxAmount: String(round2(taxAmount)),
    totalAmount: String(round2(totalAmount)),
    payTypeId: '99',
    checkOutMethodId: '4',
    checkNumber: '',
    firstName: scraped.firstName || '',
    lastName: scraped.lastName || '',
    address: scraped.address || '',
    address2: scraped.address2 || '',
    city: scraped.city || '',
    state: scraped.state || '',
    zip: scraped.zip || '',
    rows: JSON.stringify(scraped.rows),
    ...(customPaymentTypeId ? { customPaymentTypeId: String(customPaymentTypeId) } : {}),
  };
}
```

Add both names to `module.exports`:

```js
  buildButlerCheckoutPlan,
  buildButlerCheckoutPostData,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test browser-fallback.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add browser-fallback.cjs browser-fallback.test.js
git commit -m "feat(engine): pure builders for butler checkout plan and post data

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Engine — butler checkout flow wired into post-create activity

**Files:**
- Modify: `browser-fallback.cjs` (async helpers after `buildButlerCheckoutPostData`; wiring in `applyPostCreateActivity` before the `} finally {` at ~line 2432; exports)

**Interfaces:**
- Consumes: Task 6 builders; existing `fetchCsrfTokenFromButler(page, payload)` (:354 — payload only needs `.baseUrl`), `postAdminForm(page, url, fields, extraHeaders)` (:627), `buildBidderDisplayName(bidder)` (:1444), `eligibleBidders` local (:2314), `normalized.butlerCheckouts` (Task 2).
- Produces: `applyButlerCheckouts(page, baseUrl, butlerCheckouts, bidders, applied, skipped, warnings)` (exported), plus `readCustomPaymentTypeIds`, `fetchButlerBidderSummary`, `scrapeButlerCheckoutPage` (exported for future tests).

- [ ] **Step 1: Implement the async helpers**

Add after `buildButlerCheckoutPostData`:

```js
// Reads {id, name} for every custom payment type from the server-rendered
// auction-settings rows (ClickBid has no GET/list route for these).
async function readCustomPaymentTypeIds(page, baseUrl) {
  await page.goto(`${baseUrl}/admin/auction_settings.php?expand=payments`, { waitUntil: 'domcontentloaded' });
  const rows = await page.evaluate(() => (
    Array.from(document.querySelectorAll('.custom-payment-type-row'))
      .map((row) => ({
        id: row.dataset.id || '',
        name: row.querySelector('input[name="custom-payment-type"]')?.value?.trim() || '',
      }))
      .filter((row) => row.id && row.name)
  ));
  return new Map(rows.map((row) => [row.name.toLowerCase(), row]));
}

// Light JSON probe: does this bidder have unpaid winning bids right now?
async function fetchButlerBidderSummary(page, baseUrl, csrfToken, bidderId) {
  const result = await postAdminForm(page, `${baseUrl}/ajax/butler/event-utilities.php`, {
    action: 'get-bidder-by-id',
    csrf: csrfToken,
    bidder_id: String(bidderId),
  });
  const bidder = result.body?.bidder;
  const winning = bidder?.winning || {};
  return {
    hasWinning: ((winning.before_closing?.length || 0) + (winning.after_closing?.length || 0)) > 0,
    queued: Boolean(bidder?.checkout_queue_exists),
  };
}

// POSTs the butler checkout PAGE for a bidder and scrapes the server-rendered
// row checkboxes + totals + bidder fields — the same data ClickBid's own JS
// posts, which guarantees the server's three-way total check passes.
async function scrapeButlerCheckoutPage(page, baseUrl, csrfToken, bidderId) {
  await page.evaluate(({ url, csrf, bidder }) => {
    window.__mkeventNavPending = true;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = url;
    const add = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };
    add('csrf', csrf);
    add('bidder-id', bidder);
    add('loc', 'butler');
    document.body.appendChild(form);
    form.submit();
  }, { url: `${baseUrl}/butler/checkout.php`, csrf: csrfToken, bidder: String(bidderId) });
  // The marker dies with the old document, so this resolves after navigation.
  await page.waitForFunction(() => !window.__mkeventNavPending, { timeout: 20000 });
  await page.waitForLoadState('domcontentloaded');

  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.item-row:checked').forEach((checkbox) => {
      if (checkbox.id === 'credit-card-fees') return; // card fees never apply to payTypeId=99
      rows.push({
        itemId: checkbox.dataset.itemId || 0,
        bidId: checkbox.dataset.bidId || 0,
        taxable: checkbox.dataset.taxable || 0,
        taxRate: checkbox.dataset.taxRate || 0,
        taxAmount: parseFloat(checkbox.dataset.taxAmount || 0),
        typeId: parseInt(checkbox.dataset.typeId || 0, 10),
        fmv: checkbox.dataset.fmv || 0,
        quantityCount: checkbox.dataset.quantityCount || 0,
        quantityPurchased: checkbox.dataset.quantityPurchased || 0,
        subTotal: parseFloat(checkbox.dataset.subTotal || 0),
      });
    });
    const val = (sel) => document.querySelector(sel)?.value ?? '';
    return {
      rows,
      queued: Boolean(document.querySelector('#checkout-message')),
      firstName: val('input[name="first-name"]').trim(),
      lastName: val('input[name="last-name"]').trim(),
      address: val('input[name="address"]').trim(),
      address2: val('input[name="address2"]').trim(),
      city: val('input[name="city"]').trim(),
      state: val('input[name="state"]').trim(),
      zip: val('input[name="zip"]').trim(),
      fmvAmount: parseFloat(val('input[name="fmv-amount"]') || 0) || 0,
      bidAmount: parseFloat(val('input[name="bid-amount"]') || 0) || 0,
      donationAmount: parseFloat(val('input[name="donation-amount"]') || 0) || 0,
    };
  });
}

async function applyButlerCheckouts(page, baseUrl, butlerCheckouts, bidders, applied, skipped, warnings) {
  const requested = butlerCheckouts || {};
  const perTypeEntries = Object.entries(requested.perType || {}).filter(([, count]) => Number(count) > 0);
  if (!perTypeEntries.length) {
    skipped.push({ section: 'butlerCheckouts', reason: 'no checkout counts configured' });
    return;
  }

  // Admin page first, then butler pages — one navigation each.
  const typeIds = await readCustomPaymentTypeIds(page, baseUrl);
  const csrfToken = await fetchCsrfTokenFromButler(page, { baseUrl });

  const { plan, warnings: planWarnings } = buildButlerCheckoutPlan(requested.perType, typeIds);
  warnings.push(...planWarnings);
  if (!plan.length) {
    skipped.push({ section: 'butlerCheckouts', reason: 'no matching custom payment types on the event' });
    return;
  }

  const queue = [...bidders];
  for (const entry of plan) {
    let done = false;
    while (queue.length && !done) {
      const bidder = queue.shift();
      try {
        const summary = await fetchButlerBidderSummary(page, baseUrl, csrfToken, bidder.id);
        if (!summary.hasWinning || summary.queued) continue;

        const scraped = await scrapeButlerCheckoutPage(page, baseUrl, csrfToken, bidder.id);
        if (scraped.queued || !scraped.rows.length) continue;

        const postData = buildButlerCheckoutPostData({
          csrfToken,
          bidderId: bidder.id,
          scraped,
          customPaymentTypeId: entry.typeId,
        });
        const result = await postAdminForm(page, `${baseUrl}/ajax/butler/checkout.php`, postData, { 'X-CSRF-TOKEN': csrfToken });
        if (result.status < 400 && result.body?.success) {
          applied.push({
            section: 'butlerCheckouts',
            bidder: buildBidderDisplayName(bidder),
            paymentType: entry.typeName,
            total: postData.totalAmount,
          });
          done = true;
        } else {
          warnings.push({
            section: 'butlerCheckouts',
            bidder: buildBidderDisplayName(bidder),
            paymentType: entry.typeName,
            message: result.body?.message || `HTTP ${result.status}`,
          });
        }
      } catch (error) {
        warnings.push({
          section: 'butlerCheckouts',
          bidder: buildBidderDisplayName(bidder),
          paymentType: entry.typeName,
          message: error.message,
        });
      }
    }
    if (!done) {
      warnings.push({
        section: 'butlerCheckouts',
        paymentType: entry.typeName,
        message: 'no remaining bidders with unpaid winning bids',
      });
    }
  }
}
```

- [ ] **Step 2: Wire into `applyPostCreateActivity`**

In `applyPostCreateActivity`, insert before the `} finally {` (line 2432, after the donation-activity block's closing brace):

```js
    if (normalized.butlerCheckouts?.enabled) {
      if (eligibleBidders.length === 0) {
        skipped.push({ section: 'butlerCheckouts', reason: 'no seeded bidders to check out' });
      } else {
        const butlerStartedAt = Date.now();
        await applyButlerCheckouts(page, baseUrl, normalized.butlerCheckouts, eligibleBidders, applied, skipped, warnings);
        process.stderr.write(`[fallback] Butler checkout activity completed in ${elapsedSeconds(butlerStartedAt)}s\n`);
      }
    }
```

Add to `module.exports`:

```js
  applyButlerCheckouts,
  readCustomPaymentTypeIds,
  fetchButlerBidderSummary,
  scrapeButlerCheckoutPage,
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (no new unit tests here — the pure logic was tested in Task 6; this flow is exercised end-to-end in Task 10).

- [ ] **Step 4: Commit**

```bash
git add browser-fallback.cjs
git commit -m "feat(engine): butler winning-bid checkouts with custom Other payment types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Window chrome — main process + preload

**Files:**
- Modify: `src/main/index.cjs` (Menu removal + IPC near line 36; BrowserWindow opts at 61; listeners in `createWindow`)
- Modify: `src/preload/index.cjs`

**Interfaces:**
- Produces: `window.mkEventDesktop.windowControls = { minimize(), maximizeToggle(), close(), onMaximizedChange(cb) -> unsubscribe }` — Task 9 consumes these exact names. IPC channels: `window:minimize`, `window:maximize-toggle`, `window:close`, `window:maximized` (main→renderer bool).

- [ ] **Step 1: Main process changes**

In `src/main/index.cjs`:

(a) After the `secure-settings:save` handler (line 36), add:

```js
// Custom titlebar (frameless window): the renderer draws its own
// minimize/maximize/close buttons and drives them over IPC.
Menu.setApplicationMenu(null);

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('window:maximize-toggle', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
```

(b) In the `BrowserWindow` options (line 61), add `frame: false,` after `height,`:

```js
  const window = new BrowserWindow({
    width,
    height,
    frame: false,
    minWidth: 760,
```

(c) In `createWindow`, after `window.loadURL(getRendererEntry());` (line 77), add:

```js
  window.on('maximize', () => window.webContents.send('window:maximized', true));
  window.on('unmaximize', () => window.webContents.send('window:maximized', false));

  // Menu.setApplicationMenu(null) also removes the default accelerators, so
  // re-register the dev ones we actually use.
  if (isDev) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (key === 'f12' || (input.control && input.shift && key === 'i')) window.webContents.toggleDevTools();
      else if (input.control && !input.shift && key === 'r') window.webContents.reload();
    });
  }
```

- [ ] **Step 2: Preload changes**

In `src/preload/index.cjs`, add to the `exposeInMainWorld` object after the `secureSettings` block:

```js
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizedChange: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
```

- [ ] **Step 3: Verify the app still boots (frameless, no menu)**

Run: `npm run electron:dev`
Expected: window opens with NO native titlebar or menu bar (undraggable for now — Task 9 adds the drag region), devtools still open detached, F12 toggles them, right-click context menu still works.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.cjs src/preload/index.cjs
git commit -m "feat(chrome): frameless window, menu removal, window-control IPC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Window chrome — TitleBar component + styles

**Files:**
- Modify: `src/renderer/App.jsx` (new `TitleBar` component; render at the top of the fragment at line 650)
- Modify: `src/renderer/app.css` (titlebar styles; `.app-top` sticky offset via sibling selector)

**Interfaces:**
- Consumes: `window.mkEventDesktop.windowControls` (Task 8 — exact API above). Renders `null` when absent (plain-browser vite dev).

- [ ] **Step 1: Add the component**

In `src/renderer/App.jsx`, above the `App` component definition, add:

```jsx
function TitleBar() {
  const controls = window.mkEventDesktop?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => controls?.onMaximizedChange?.(setMaximized), []);
  if (!controls) return null; // plain-browser dev has native chrome already

  return (
    <div className="titlebar">
      <div className="titlebar-title">mkEvent</div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => controls.minimize()} aria-label="Minimize">
          <span className="mdl2">{'\uE921'}</span>
        </button>
        <button className="titlebar-btn" onClick={() => controls.maximizeToggle()} aria-label={maximized ? 'Restore' : 'Maximize'}>
          <span className="mdl2">{maximized ? '\uE923' : '\uE922'}</span>
        </button>
        <button className="titlebar-btn titlebar-close" onClick={() => controls.close()} aria-label="Close">
          <span className="mdl2">{'\uE8BB'}</span>
        </button>
      </div>
    </div>
  );
}
```

In the `App` return (line 650), render it first:

```jsx
  return (
    <>
      <TitleBar />
      <AppTop cfg={cfg} onOpenSettings={() => setShowSettings(true)} />
```

- [ ] **Step 2: Add styles**

Append to `src/renderer/app.css`:

```css
/* Custom window chrome (frameless Electron window) */
.titlebar {
  display: flex; align-items: center; justify-content: space-between;
  height: 34px;
  -webkit-app-region: drag;
  user-select: none;
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--topbar-border);
  position: sticky; top: 0; z-index: 20;
}
.titlebar-title { padding: 0 14px; font-size: 12px; font-weight: 600; color: var(--muted); }
.titlebar-controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
.titlebar-btn {
  width: 46px; height: 100%;
  border: 0; background: transparent; color: var(--muted);
  display: flex; align-items: center; justify-content: center;
}
.titlebar-btn:hover { background: var(--chip-bg); color: var(--heading); }
.titlebar-close:hover { background: #e81123; color: #fff; }
.mdl2 { font-family: 'Segoe MDL2 Assets'; font-size: 10px; line-height: 1; }
/* The app header sticks below the titlebar when the titlebar is present. */
.titlebar + .app-top { top: 34px; }
```

- [ ] **Step 3: Verify in the running app**

Run: `npm run electron:dev`
Expected: slim themed bar at the top — draggable, double-click maximizes; minimize works; middle button maximizes and its icon flips to restore (and back); close exits the app; close button hover turns red; bar follows light/dark theme; the existing app header sticks 34px down and nothing overlaps when scrolling. Snap-drag to screen edges still works (Snap Layouts hover popup is expected to be gone — accepted in the spec).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.jsx src/renderer/app.css
git commit -m "feat(chrome): custom themed titlebar with min/max/close controls

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite + production build**

Run: `npm test` → all tests pass.
Run: `npm run build` → vite build succeeds with no errors.

- [ ] **Step 2: End-to-end run against triage**

In the running app (`npm run electron:dev`), with connection settings pointed at `cbotriage.bid`:

1. Auction step: keep the three default chips, add one more ("Student Account").
2. Activity step: enable activity + auction activity (a few bids) + donation activity (≥2 donations, so checkout-able wins exist immediately) + butler checkouts with counts, e.g. Venmo: 1, Zelle: 1.
3. Create the event and watch the run log.

Expected in the run summary: `customPaymentTypes` entries applied (4 types with ids); `butlerCheckouts` applied entries naming a bidder + payment type, or explicit shortfall warnings (never a crash).

- [ ] **Step 3: Verify in ClickBid admin (triage)**

- Software Settings → Auction Settings → Payments: the four custom types are listed.
- Event Central → Event Payments → Paid Checkouts: the seeded checkouts appear with the custom payment names.
- Butler → checkout of a remaining winner: the "Other" dropdown lists the types.

- [ ] **Step 4: Report results**

Report pass/fail per surface with any warnings from the run log. Fix-forward anything broken before merging.
