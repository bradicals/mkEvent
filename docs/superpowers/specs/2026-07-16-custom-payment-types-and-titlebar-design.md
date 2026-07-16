# Custom "Other" Payment Types + Custom Window Chrome — Design

Date: 2026-07-16
Branch: `feat/payment-types-and-titlebar`
ClickBid ticket: 7720 (FEAT: /admin/auction_settings: Payments: "Other" payment option as dropdown)

Two features, one branch (approved by Brad):

1. mkEvent setting to seed an event's custom "Other" payment types (add/remove list).
2. Remove the default Electron menu bar / window frame; add custom minimize / maximize / close buttons.

---

## Feature 1 — Custom payment types setting

ClickBid now stores per-event custom "Other" payment types, managed on
`/admin/auction_settings.php` (Payments panel) and saved via a JSON endpoint:

```
POST {base}/app/public/admin/{eventSlug}/custom-payment-types
Content-Type: application/json
{"name": "Venmo"}
```

Session cookies carry auth. mkEvent seeds these at event creation so QA events
exercise the feature with zero manual setup.

### Model (`event-model.js`)

- `DEFAULT_CONFIG.auctionSettings.customPaymentTypes = ['Venmo', 'Zelle', 'Gift Card']`
  (stocked defaults, per Brad).
- New `normalizeCustomPaymentTypes(value)` mirroring `normalizeCustomQuestionAnswers`
  (event-model.js:490): accepts an array or comma-separated string; trims,
  `clampString(80)`, drops empties, dedupes exact matches. **Missing/undefined →
  stocked defaults; explicitly empty array → stays empty** (user removed all chips).
- Called from `normalizeAuctionSettings()` (event-model.js:436). Recipes, presets,
  exports, and imports pick the field up automatically via the existing
  `buildRecipe`/`exportRecipeConfig`/`importRecipeConfig` funnels. No version bump —
  normalization tolerates missing fields.
- `stocked-recipe.json` untouched: its missing field normalizes to the stocked defaults.

### UI (`sections.jsx` — AuctionSettingsBody, Payments group)

New field directly after "Enable Link?" (sections.jsx:591-620):

- Label: **Other payment types** with help text "Custom 'Other' payment options
  seeded on the new event. Volunteers pick these from a dropdown at checkout."
- Chip list: each type renders as a rounded chip (`--chip-bg`/`--chip-fg`,
  9999px radius) with an × remove button using the existing danger-hover recipe
  (`#fef2f2` bg / `#b91c1c` fg).
- Text input + "Add" button (`btn btn-outline btn-sm`); Enter key also adds.
  Blank/duplicate entries are ignored.
- Writes via the existing section patcher: `set({ customPaymentTypes: [...] })`.
- Small CSS additions to `app.css` using existing tokens only (theme-safe in
  light/dark).

### Engine (`browser-fallback.cjs`)

- Auction settings already run exclusively through the Playwright fallback's
  `applyAuctionSettings()` (browser-fallback.cjs:372), which is already
  authenticated and on the auction-settings page. The HTTP-only admin channel is
  intentionally not involved (creation-engine.js:353 forces the browser path).
- New helper `addCustomPaymentTypes(page, baseUrl, eventSlug, names)`: in-page
  `fetch` POST per name (JSON body, `accept: application/json`; include
  `X-XSRF-TOKEN` decoded from the `XSRF-TOKEN` cookie if present). Same
  no-DOM pattern as `stripeOnboardingPost()` (browser-fallback.cjs:222).
- Called at the end of `applyAuctionSettings()` when
  `settings.customPaymentTypes?.length`. Each name records into the existing
  `applied`/`skipped`/`warnings` summary — a failed POST warns, never kills the run.
- `applyAuctionSettings` gains the event slug (available in the fallback payload;
  mkEvent sets the slug at create time).
- **Assumption to verify on triage during implementation**: the `{slug}` path
  segment (`plazacruise` in the captured request) is the *event* slug, not the
  org slug. The ticket's copy-to-new-event behavior implies per-event storage.
  If it turns out to be the org slug, the helper swaps in that value — no other
  design change.

### Error handling

- Model: silent normalization (matches every other field).
- Engine: per-name try/catch → `warnings[]`; non-2xx response → warning with
  status. No retries (idempotent seeding on a fresh event; a failure is visible
  in the run summary).

### Testing

- `event-model.test.js`: normalizer cases — missing → stocked defaults, `[]`
  stays empty, comma-string accepted, trim/clamp/dedupe.
- `browser-fallback.test.js`: helper exported through the existing test-seam
  block (browser-fallback.cjs:3025) and exercised with a stubbed page object.

### Out of scope

- Wiring custom types into post-create ticket-purchase `paymentMix` (API
  purchases keep using the fixed `PAYMENT_METHOD_IDS`).
- Removing/renaming types on an existing event (mkEvent only seeds new events).
- Butler checkout / statements / reports surfaces from the ticket (those are
  ClickBid's, not mkEvent's).

---

## Feature 2 — Custom window chrome

Windows-only app; goal is removing the stock menu bar + frame, replacing the
caption buttons with themed ones. Accepted trade-off: no native Snap Layouts
hover popup on the maximize button.

### Main process (`src/main/index.cjs`)

- `frame: false` on the `BrowserWindow`; `Menu.setApplicationMenu(null)`.
- IPC handlers: `window:minimize`, `window:maximize-toggle` (maximize ⇄
  unmaximize), `window:close`.
- Window `maximize`/`unmaximize` events push state to the renderer
  (`webContents.send('window:maximized', bool)`) so the middle button can swap
  its icon.
- Dev-only (`!app.isPackaged`): re-register DevTools (F12 / Ctrl+Shift+I) and
  reload (Ctrl+R) via `before-input-event`, since removing the menu removes the
  default accelerators.

### Preload (`src/preload/index.cjs`)

- `contextBridge` exposes `windowControls`: `minimize()`, `maximizeToggle()`,
  `close()`, `onMaximizedChange(cb)`.

### Renderer

- New slim `TitleBar` at the top of `App.jsx`: app name left, three buttons
  right. Bar is `-webkit-app-region: drag`; buttons `no-drag`.
  Double-click-to-maximize comes free with the drag region.
- Icons via the **Segoe MDL2 Assets** font (ships with Windows 10/11): minimize
  U+E921, maximize U+E922, restore U+E923, close U+E8BB. Zero new assets.
- Styling with existing theme tokens; close button uses the red danger-hover
  recipe. Follows light/dark automatically.

### Error handling / testing

- IPC handlers are one-liners on `BrowserWindow.fromWebContents()`; null-guard
  and done. Verified by running the app (visual + interaction check) — no unit
  tests for window chrome.
