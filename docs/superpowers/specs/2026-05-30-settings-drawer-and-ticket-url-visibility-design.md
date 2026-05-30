# Settings drawer + ticket-page URL visibility — design spec

**Date:** 2026-05-30
**Status:** Approved (design), pending implementation plan
**Author:** brad / mkEvent

## Summary

Two user-facing changes to the live renderer, plus one shared-model consistency fix:

1. **Settings drawer.** Move the API "Settings" card off the main scrolling page and behind a gear (⚙) button in the top-right header. Clicking the gear opens a right-side slide-in drawer over a dimmed backdrop.
2. **Make form name / display name visibly drive the public URL.** The ticket-page Form name already drives the real created URL and the Display name already sets the public page title — but neither is reflected in the on-screen preview *before* creation, so it looks like the defaults are hardcoded. Add a live URL preview in the Ticket pages section and surface the resulting public URL in the summary.
3. **Consistency fix.** `summarizeRecipe`'s `publicUrl` is computed without the form name, so it disagrees with what the app actually creates. Align it.

All UI work lands in the canonical, packaged renderer tree (`src/renderer/`), which doubles as Electron-readiness prep.

## Background and context

### The repo has two parallel UI copies (critical to know)

- **Live / packaged app:** `src/renderer/` — `App.jsx`, `sections.jsx`, `create-runner.jsx`, `app.css`, entered via `index.html` → `src/renderer/main.jsx`. ES modules. This is what `npm run dev` serves and what Electron packages.
- **Legacy dead duplicates:** root `app.jsx`, `sections.jsx`, `create-runner.jsx`, `app.css`, and `mkEvent.html` (old `window.*`-globals version). **Editing these changes nothing in the running app.**
- **Shared logic:** repo-root `event-model.js` and `creation-engine.js`. The `src/shared/*.js` files are thin shims that re-export them.

**Decision:** All work for this spec goes in `src/renderer/` (UI) and root `event-model.js` (shared). The dead root duplicates are left untouched this pass; deleting them is tracked as an optional follow-up (see Out of scope).

### How name → URL actually works today (verified in code)

The real creation path is `browser-fallback.cjs` (Playwright):

- `buildTicketPagePlans` (`browser-fallback.cjs:439`) reads each `page.formName` and assigns the target form name (default `tix`, deduped to `tix_2`, etc.).
- `renameTicketPage` (`browser-fallback.cjs:542`) actually renames the ClickBid form to the requested form name (`#onblur-form_name`).
- `applyTicketPageSettings` (`browser-fallback.cjs:741`, line 757) sets the public page title (`#onblur-form_title`) to `ticketPage.displayName`.
- `ticketPagePublicUrl` (`browser-fallback.cjs:467`) builds `slug.host/{formName}`; `tix` collapses to `slug.host/`. The returned `publicUrl` uses the **first** page's form name (`browser-fallback.cjs:2551`).

So **form name and display name already function end-to-end.** The gap is purely visibility before creation:

- `summarizeRecipe` (`event-model.js:1614`) computes `publicUrl = buildPublicEventUrl(baseUrl, slug)` — **without** the `formName` argument — so the preview always reads `slug.host/` regardless of the form name.
- The Ticket pages section (`src/renderer/sections.jsx`, Form name input ~line 915) shows no URL preview, and the form name / display name / resulting URL never appear in the footer summary.

There is no `urlSlug`/`url_slug` field anywhere. `formName` (default `tix`, clamped to 20 chars) is the URL identifier; `displayName` (default `Tickets`, clamped to 80) is the guest-facing page title.

### Ticket pages are effectively single-page in the UI

`TicketPagesBody` edits `ticketPages.pages[0]` only (`src/renderer/sections.jsx:685`, `commitPage` at :690). The model supports an array, but the UI manages one page. The preview and the summary therefore use the **primary (first) page**.

## Goals

- A gear button in the top-right header opens a right-side settings drawer; the inline Settings card is removed from the page.
- Typing a Form name shows a live, accurate `slug.host/{formName}` preview (and `slug.host/` for default `tix`).
- The display name and resulting public URL are visible in the summary before Create.
- The previewed public URL matches what the app actually creates.
- All changes live in `src/renderer/` + root `event-model.js`.

## Non-goals / Out of scope

- No new Electron scaffolding or packaging work — the shell exists and the bundled-installer effort is specced separately (`docs/superpowers/specs/2026-05-29-bundled-windows-installer-design.md`).
- No multi-ticket-page UI (the UI stays single-page; model array untouched).
- No change to the actual creation behavior in `browser-fallback.cjs` — it already does the right thing.
- **Optional follow-up (not this pass):** delete the dead root duplicates (`app.jsx`, `sections.jsx`, `create-runner.jsx`, `app.css`, `mkEvent.html`) to leave one source of truth before packaging.

## Design

### Part A — Settings drawer (`src/renderer/App.jsx`, `src/renderer/app.css`)

**State.** Add `const [showSettings, setShowSettings] = useState(false);` in `App`.

**Trigger.** `AppTop` (defined in `App.jsx`) gains an `onOpenSettings` prop and renders a gear button in the existing `.app-top-right` cluster, after the Docs button:

```jsx
<button className="btn btn-ghost btn-sm" onClick={onOpenSettings} title="Settings" aria-label="Settings">
  <i className="fa-solid fa-gear"></i>
</button>
```

**Drawer.** Rendered at the end of `App`'s fragment, only when `showSettings`:

```jsx
{showSettings && (
  <>
    <div className="settings-backdrop" onClick={() => setShowSettings(false)} />
    <aside className="settings-aside" role="dialog" aria-label="Settings">
      <div className="settings-aside-head">
        <h2>Settings</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(false)} aria-label="Close settings">
          <i className="fa-solid fa-xmark"></i>
        </button>
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

`SettingsBody` renders its own fields directly here (not wrapped in a collapsible `Section`).

**Remove** the inline `<Section ... title="Settings">…</Section>` block from the main page. The Environment section stays on the page.

**Close affordances.** ✕ button, backdrop click, and Escape key (a `useEffect` adding a `keydown` listener while `showSettings` is true).

**CSS** (`src/renderer/app.css`): `.settings-backdrop` (fixed, full-viewport, dim + slight blur), `.settings-aside` (fixed right, full height, ~480–520px max-width, white, left shadow, column flex, slide-in animation), `.settings-aside-head` (title + close row), `.settings-aside-body` (scrollable), and a `@keyframes slideInRight`. Mobile/narrow: drawer goes full width. Reuse existing color tokens.

### Part B — Visible name → URL (`src/renderer/sections.jsx`, root `event-model.js`)

**Thread event identity into the section.** `App.jsx` passes the basics and API base URL to `TicketPagesBody`:

```jsx
<TicketPagesBody data={cfg.ticketPages} items={cfg.items} basics={cfg.basics} api={cfg.api} set={set('ticketPages')} />
```

**Live URL preview.** Under the Form name input, render a preview computed the same way creation does, so it is always truthful:

```js
const previewSlug = MODEL.slugifyForClickBid(basics.slug || basics.name);
const previewUrl = MODEL.buildPublicEventUrl(api.baseUrl, previewSlug, page.formName);
```

Display `previewUrl` (e.g. `gala123.cbodev4.com/gala-dinner`); for default `tix` it correctly shows `…/`. If slug or base URL is missing, show a neutral hint instead of a broken URL. The Form name shows raw (no auto-cleaning); `buildPublicEventUrl`/`slugifyForClickBid` already normalize as ClickBid does.

**Summary surfacing.** Show the primary page's public URL (and display name) where QA will see it before Create. Primary location: `AppFoot`'s summary line (in `App.jsx`), using the same `publicUrl` the model now produces (Part C). The Ticket pages section's own preview (above) already covers the in-section view.

### Part C — `summarizeRecipe` consistency fix (root `event-model.js`)

Change `event-model.js:1614` to pass the primary page's form name when ticket pages are enabled:

```js
const primaryFormName = ticketPages.enabled && ticketPages.pages[0] ? ticketPages.pages[0].formName : '';
// …
publicUrl: buildPublicEventUrl(
  recipe.environment.baseUrl || recipe.environment.publicBaseUrl,
  recipe.event.slug,
  primaryFormName,
),
```

This matches `browser-fallback.cjs:2551` (which already returns the first form name's URL) and the `creation-engine.js` fallback at lines 297/733, so preview and actual agree.

## Data flow

```
cfg.basics.slug/name ─┐
                      ├─ slugifyForClickBid ─ slug ─┐
cfg.api.baseUrl ──────┘                             ├─ buildPublicEventUrl(base, slug, formName) ─ preview URL
cfg.ticketPages.pages[0].formName ──────────────────┘
                                   (same fn drives summarizeRecipe.publicUrl and is what browser-fallback creates)

gear click → showSettings=true → <aside> renders <SettingsBody> → close (✕ / backdrop / Esc) → showSettings=false
```

## Testing

- **Unit (`event-model.test.js`):** `summarizeRecipe` returns `publicUrl` ending in the primary page's form name when ticket pages are enabled with a non-default form name; collapses to `slug.host/` (no path) for `tix`; uses event root when ticket pages are off. Confirm `buildPublicEventUrl(base, slug, formName)` path-building for: custom form name, `tix`, empty, and a name needing normalization.
- **Manual (Vite `npm run dev`):** gear opens/closes the drawer (✕, backdrop, Esc); Settings no longer on the page; Environment still on the page; typing a Form name updates the preview live; default `tix` shows `…/`; summary shows the public URL + display name.
- **Optional end-to-end:** one real create run with a changed form name to confirm the created URL matches the preview (depends on credentials/environment availability).

## Risks and mitigations

- **Terminal output flakiness this session** intermittently garbled tool output. Mitigation: verify file state with checksums/`git status` after edits; re-read rather than trust mangled output.
- **Threading new props** into `TicketPagesBody` could touch a large component. Mitigation: additive props only; no change to existing `commitPage` flow.
- **Preview vs reality drift.** Mitigation: preview uses the exact shared functions (`slugifyForClickBid`, `buildPublicEventUrl`) that creation uses; Part C aligns the model so all consumers agree.
- **Two UI trees** invite editing the wrong copy. Mitigation: spec pins all work to `src/renderer/` + root `event-model.js`; dead duplicates explicitly out of scope.

## Files touched

- `src/renderer/App.jsx` — drawer state; gear button in `AppTop` (defined here); remove inline Settings section; render `<aside>` + backdrop; Escape handler; pass `basics`/`api` to `TicketPagesBody`; surface public URL + display name in `AppFoot`.
- `src/renderer/sections.jsx` — `TicketPagesBody` accepts `basics`/`api` and renders the live URL preview under the Form name field.
- `src/renderer/app.css` — drawer + backdrop + gear styles and slide-in animation.
- `event-model.js` (root) — `summarizeRecipe` publicUrl form-name fix.
- `event-model.test.js` (root) — coverage for the URL behavior.
