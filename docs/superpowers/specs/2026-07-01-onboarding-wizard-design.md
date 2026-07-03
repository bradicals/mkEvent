# Onboarding Wizard — design spec

## Goal

Re-skin mkEvent's create-an-event UI from the current "one long page of
expandable setting cards" into the guided, one-step-at-a-time **Onboarding
Wizard** from `design_handoff_onboarding` (README + `theme.css` + screenshots).

This is a **presentation + navigation** change only. It keeps **every setting
the app has today** — nothing is dropped. The data model
(`event-model.js`), engine (`creation-engine.js`), `useConfig()`, live slug
check, and test-connection logic are all reused unchanged. Every section
*body* in `sections.jsx` is reused verbatim; we stop stacking them as
accordions and show one per wizard step.

Adds one genuinely new capability: **Light / Dark theming**.

## Non-goals

- No changes to the creation engine, API/proxy calls, or data model.
- No rebuild of the run modal's internals — it is reskinned only (see below).
- No new dependencies. Icons stay on the already-loaded FontAwesome kit.

## Architecture

One window: **top bar → (step rail | step card) → footer nav**, plus a
**Settings drawer** and the existing **run modal**.

### Shell — `src/renderer/App.jsx`

`App` becomes the shell and owns wizard state. Structure:

```
<div id="app" data-theme={theme}>
  <AppTop … onOpenSettings />           // logo · product · API pill · gear
  <div class="wizard">
    <StepRail step … onJump />          // left rail, 262px
    <StepCard step …>                   // header + card body + footer nav
      { the current step's section body }
    </StepCard>
  </div>
  {runRequest && <RunModal … />}
  {showSettings && <SettingsDrawer … />}
</div>
```

New state added to `App` (everything else — `cfg`, `slugCheck`, `testState`,
`runRequest`, `showSettings`, presets — already exists and is reused):

- `step` — integer `0…7` (8 steps).
- `theme` — `'light' | 'dark'`, initialized from
  `localStorage['mkEvent.onboarding.theme']` (default `'light'`), persisted on
  change via `useEffect`.

Removed from the main flow: the old `page-head`, `ConfigToolbar` (moves into
the drawer), and the stacked `<Section>` accordion list. The `Section`
component and the summary helper functions (`envSummary`, `biddersSummary`,
etc.) stay — the Review step reuses the summary data via the existing
`EVENT_MODEL.summarizeRecipe(recipe)`.

### Step rail — new component in `App.jsx` (or `wizard.jsx`)

- `background: var(--rail-bg)`, `border-right: 1px solid var(--rail-border)`,
  width 262px, scrolls independently.
- Header: "PROGRESS" eyebrow, a progress bar (fill width = `step / 7 * 100%`),
  and "N of 8 steps ready" where N = count of steps whose `ready(cfg)`
  predicate is true.
- 8 rail buttons, each a 26px status circle (active / complete / todo) + label.
  Active item: 3px `var(--accent-cyan)` left border + tinted background.
  Complete: check circle. Clicking a rail item jumps to that step.

### The 8 steps

Reuse the existing bodies from `sections.jsx` unchanged. Each step renders its
header (eyebrow "STEP n OF 8", h1 title, subtitle) + the card + footer nav.

| # | Step | Body reused | Notes |
|---|------|-------------|-------|
| 0 | Connect | `EnvironmentBody` | Quick-start preset chips above the card; connection-status test panel below the fields (reuses `testConnection`). |
| 1 | Event basics | `BasicsBody` | name+dice, live slug check, schedule, contact. |
| 2 | Bidders | `BiddersBody` | full field set (bulk/exact tabs, faker). |
| 3 | Items | `ItemsBody` | full field set. |
| 4 | Auction settings | `AuctionSettingsBody` | |
| 5 | Ticket pages | `TicketPagesBody` | |
| 6 | Activity | `PostCreateActivityBody` | its own step (post-create checkout seeding). |
| 7 | Review & create | summary helpers | hero summary card + recipe rows; **Create event** (lime) opens `RunModal`. |

> All bodies keep their FULL field set (bulk/exact tabs, faker options,
> per-record editors, custom questions, etc.). The wizard only decides *which*
> body shows.

### Footer nav (inside each step card)

- `border-top: 1px solid var(--divider)`.
- **Back** (outline; disabled on step 0) · spacer · **Skip to review** (ghost
  link, steps 0–6) · **Continue** (cyan) on form steps / **Create event**
  (lime) on the Review step.
- Create is disabled until the event is creatable. **Reuse the existing
  `canCreate` rule** from the current `AppFoot` (org id + token + all basics
  incl. contact phone + slug not taken/invalid) — deliberately stricter than
  the handoff's shorter list, so we don't offer a create the API will reject.

### Settings drawer — reuses existing `SettingsBody` + moved toolbar

Right-side 380px panel, slides in, backdrop. Sections:

- **Appearance** — "Theme" 2-option segmented control (Light / Dark) driving
  `theme`.
- **Connection** — existing `SettingsBody` (test connection, API profiles).
- **Presets & recipes** — the current `ConfigToolbar` contents (preset
  picker, save/delete preset, import/export recipe) moved here from the old
  page head. Wiring (`loadPreset`, `savePreset`, `exportRecipe`, `importRecipe`,
  the hidden file input, `PresetNameModal`) is unchanged.

### Quick-start presets (Connect step)

Three chips that apply a patch across bidders/items/auction/tickets via the
existing `set(section)` setters. Starting values (tune to taste):
*Typical gala* (75 bidders, 58 items, gala tickets), *Stress test* (500
bidders, 270 items), *Minimal* (5 bidders, 7 items, no extras).

### Theming — `theme.css` + `app.css`

- Copy `theme.css` into `src/renderer/` and `@import './theme.css';` at the top
  of `app.css`.
- Rewrite `app.css` so every hard-coded surface color becomes a `var(--*)`
  token (both themes come for free). Inputs use `color-scheme: var(--scheme)`
  so native date/time pickers theme correctly.
- State-dependent recipes (rail circles, toggle on/off, slug badge, focus ring)
  computed via modifier classes per the values documented at the bottom of
  `theme.css`.
- Honor `prefers-reduced-motion` for the transitions.

### Run modal — `create-runner.jsx` (reskin only)

Keep the working log-streaming `RunModal` (live log lines, copy summary, copy
debug report — QA relies on these). Only swap its hard-coded colors for theme
tokens so it matches light/dark. No structural/behavioral change.

## Files touched

- `src/renderer/App.jsx` — shell, wizard state, step rail, step card, footer
  nav, settings drawer with moved toolbar. (largest change)
- `src/renderer/theme.css` — new (copied from handoff).
- `src/renderer/app.css` — `@import` theme.css; tokenize all colors; add
  wizard/rail/step-card/drawer styles.
- `src/renderer/create-runner.jsx` — tokenize colors only.
- `src/renderer/sections.jsx` — bodies unchanged; only touched if a shared
  primitive's color needs tokenizing (prefer doing that in `app.css`).

## Verification

- App builds (`npm run build`) and existing tests pass (`npm test`).
- Manual: all 8 steps reachable via Back/Continue and rail jumps; every field
  from the old UI is present on its step; Skip-to-review works; theme toggle
  flips the whole app and persists across reload; slug check, test connection,
  presets, import/export, and Create-event run all still work.
</content>
</invoke>
