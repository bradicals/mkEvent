# Event Creator Tool Planning Document

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task when the user is ready to build.

**Goal:** Build a GUI tool that lets QA users define an event configuration, then creates a fresh event with bidders, items, pricing, sale modes, and environment-specific settings using APIs where possible and browser automation only where necessary.

**Architecture:** Build this as a packaged desktop application, not a hosted/local web app. The desktop GUI collects a typed event configuration and sends it through a backend orchestration layer. The orchestration layer should prefer direct API calls for speed/reliability, then fall back to Playwright or another browser automation adapter for workflows not exposed by API. Keep environment credentials, org/event API keys, and per-environment base URLs in a desktop settings store separate from saved event templates.

**Tech Stack:** TBD, but desktop-first. Strong initial candidate: TypeScript + Electron or Tauri for GUI, TypeScript service layer, Playwright fallback, JSON/YAML templates, encrypted local settings store / OS keychain. Alternative: Python + PySide/Flet + requests + Playwright only if faster packaging is acceptable.

---

## Initial Reaction

This is a strong QA tooling idea.

The core value is that QA often needs a very specific event shape to reproduce or verify bugs, but manually creating that state is slow and inconsistent. A dedicated event creator would turn repeated setup work into a repeatable recipe:

- fresh event on demand
- known name/slug/dates
- controlled bidder count
- controlled item count
- predictable item prices
- silent/buy-now/live/mixed sale modes
- environment-specific API keys/settings
- reproducible test data for bug verification

The most important design decision is to separate **what the user wants created** from **how the system creates it**. The GUI should produce a plain configuration object. A separate creation engine should execute that configuration using APIs and browser automation adapters.

---

## Product Concept

### Working Name

`mkEvent` or `Event Builder`

### Target Users

Primary:
- QA engineers who need reproducible ClickBid-style events for bug reproduction, exploratory testing, regression testing, and feature verification.

Secondary:
- Developers who need seeded events while building or debugging.
- Support/implementation staff if the tool eventually supports safe non-dev environments.

### Main Use Case

A QA opens the tool, chooses an environment, fills out an event recipe, clicks **Create**, and receives:

- event name
- event slug
- event ID
- admin URL
- public/bidder URL
- generated bidder credentials/details
- generated item summary
- creation log
- warnings for anything that required browser automation fallback

---

## MVP Scope

### MVP Should Include

1. **Environment selection**
   - Stage, triage, dev, dev2, dev3, dev4 only
   - single environment base URL; API URL is derived as `{baseUrl}/api/v4`
   - organization/event API keys
   - production and local are intentionally excluded

2. **Basic event details**
   - event name
   - slug
   - start/end dates
   - timezone if required by the system
   - organization/account selection if API supports it

3. **Bidder generation**
   - number of bidders
   - predictable naming convention
   - generated emails
   - optional phone numbers if required
   - output table with bidder details

4. **Item generation**
   - number of items
   - item name prefix
   - starting bid / fixed price / fair market value
   - sale type: silent, buy now, live, mixed if supported
   - optional category/package grouping later

5. **Creation execution**
   - create event using API when possible
   - create bidders using API when possible
   - create items using API when possible
   - use Playwright only for gaps
   - show progress per step
   - log API responses/errors in a readable way

6. **Settings tab**
   - store per-environment base URL
   - store org API key
   - store event API key if needed
   - test connection button
   - avoid hardcoding credentials in source

7. **Result screen**
   - event ID
   - slug
   - direct links
   - copied summary
   - generated data export as JSON/CSV

### Explicitly Out of MVP

- full production support
- every possible event setting
- multi-org bulk creation
- destructive cleanup/delete flows
- advanced item images/media
- user/team auth unless needed
- cloud-hosted multi-user version

---

## Proposed User Flow

1. User opens app.
2. App shows either:
   - last-used environment and blank event form, or
   - setup/settings screen if no environment credentials exist.
3. User selects environment.
4. User enters event details:
   - name
   - slug
   - date range
   - optional template/preset
4. User configures bidders:
   - bidder count
   - email prefix/domain
   - optional default password if system allows
5. User configures items:
   - item count
   - price model
   - sale mode
6. User clicks **Create**.
7. App executes creation steps and shows progress.
8. App displays final event links and generated test data.

Note: there is intentionally no preview step in the core flow. This tool is for configuring creation inputs only; landing page and customer-facing pages should use default ClickBid behavior unless a specific QA setting requires otherwise.

---

## Suggested Architecture

### 1. GUI Layer

Responsible only for:
- rendering forms
- collecting input
- validating obvious UI fields
- showing progress/logs/results
- saving/loading templates

It should not directly know API implementation details.

### 2. Configuration Model

A plain object that fully describes the requested event.

Example shape:

```json
{
  "environment": "dev2",
  "event": {
    "name": "QA Silent Auction Bug Repro",
    "slug": "qa-silent-auction-bug-repro",
    "startDate": "2026-05-10T09:00:00-04:00",
    "endDate": "2026-05-17T21:00:00-04:00"
  },
  "bidders": {
    "count": 10,
    "emailPrefix": "qa-bidder",
    "emailDomain": "example.test"
  },
  "items": {
    "count": 25,
    "namePrefix": "QA Item",
    "saleMode": "silent",
    "startingBid": 25,
    "buyNowPrice": null
  }
}
```

### 3. Creation Engine

Responsible for converting the config into actual system state.

Suggested sequence:

1. validate environment settings
2. validate credentials
3. create event
4. fetch created event ID/details
5. create/update event settings not included in event-create call
6. create bidders
7. create items
8. apply item sale-mode settings
9. run post-create verification
10. return result summary

### 4. Adapter Layer

Use adapters so creation logic can swap between API and browser automation.

Potential adapters:

- `EventApiAdapter`
- `BidderApiAdapter`
- `ItemApiAdapter`
- `AdminUiPlaywrightAdapter`
- `EnvironmentConfigStore`

The creation engine should call high-level methods like:

```ts
createEvent(config.event)
createBidder(eventId, bidderConfig)
createItem(eventId, itemConfig)
setAuctionMode(eventId, itemId, mode)
```

The adapters decide whether API or UI automation is required.

---

## API-First vs Playwright Fallback

### API-First Advantages

- faster
- less flaky
- easier to log/debug
- easier to run headless
- easier to validate responses
- less likely to break from UI selector changes

### Playwright Fallback Advantages

- can automate settings not exposed in API
- mirrors real admin workflow
- useful while API coverage is incomplete

### Recommendation

Use APIs for all data creation if possible. Use Playwright only behind explicit fallback methods and label those steps in the UI/logs.

Example:

```text
✓ Created event through API
✓ Added 10 bidders through API
✓ Added 25 items through API
⚠ Enabled Advanced Butler setting through UI fallback
```

This keeps the tool trustworthy. If a failure happens, QA can quickly see whether it was API or UI automation.

---

## Key Screens

## Design Direction from Existing Claude Design Prototype

The current design files in `/home/bradley/mkEvent/` define a strong visual direction and should be treated as the preferred UI baseline:

- Main prototype: `mkEvent.html`
- Main app logic: `app.jsx`
- Section components/forms: `sections.jsx`
- Styling: `app.css`
- Brand tokens: `assets/colors_and_type.css`
- Brand assets: `assets/clickbid-logo.png`, `assets/clickbid-mark.png`, `assets/favicon.ico`

### What Works Well

- The design uses real ClickBid-flavored brand tokens instead of generic SaaS styling:
  - cyan `#00a3ff`
  - lime `#7bc122`
  - navy `#07529c`
  - Inter as the primary admin/internal font
- The card/accordion pattern is a good fit for event creation because QA can work section-by-section without facing one giant form.
- The sticky footer summary is valuable because it constantly answers, “What am I about to create?”
- The “API keys connected” pill and runtime section fit the product concept well.
- The create-run modal/console direction is good for QA because event creation needs step-by-step visibility and failure diagnostics.
- The local desktop/window framing communicates “internal utility” rather than public-facing SaaS.

### Design Adjustments Needed for the QA Tool MVP

The prototype currently feels like a full event setup wizard for real customer events. For QA event generation, it should be tightened around reproducible test data:

1. Replace/rename production-oriented fields:
   - “Target bidders” should become “Bidders to create.”
   - “Maximum bidders” is probably not MVP unless it maps directly to an API setting.
   - “Require credit card” should be hidden or heavily warned for QA/dev events.
   - Default environment should not be production.

2. Move environment/runtime earlier:
   - QA should choose environment before event details.
   - The environment badge should stay visible in the header/footer.
   - Dev/staging/prod-like environments should have distinct visual warnings.

3. Keep the workflow settings-only:
   - No preview button is needed.
   - The tool should collect creation/settings inputs and then create the event directly.
   - Landing page and customer-facing pages should use the system defaults.
   - Saved templates/recipes may still be useful later, but they should not introduce a preview step.

4. Adjust item UI for bulk QA generation:
   - Keep the polished item row UI, but add count-based generation controls:
     - silent item count
     - live item count
     - donation item count
     - starting item number
     - price pattern / increment / FMV
   - The current manually-added/random item model is great for demos, but QA needs fast bulk generation.

5. Settings/API section should become a dedicated Settings tab:
   - environment name
   - API base URL
   - org token
   - optional event token
   - optional UI fallback credentials/browser
   - test connection button

6. Avoid hardcoded live-looking secrets/defaults:
   - The prototype currently shows `cb_live_•••••••••••••` and production defaults.
   - For QA, defaults should be `dev`, `dev2`, `sandbox`, or blank.

### Recommended MVP Screen Order

1. Environment & credentials status
2. Event basics
3. Bidders to create
4. Items to create
5. Optional creation settings that are API-supported
6. Create + run console
7. Results / generated data export

### Main Event Form

Sections:

1. Environment
2. Event Details
3. Bidders
4. Items
5. Advanced Settings
6. Preview/Create

### Settings Tab

Fields:

- environment name
- admin base URL
- public/event base URL
- API base URL
- organization API key
- event API key
- optional login username/password for UI fallback
- test connection button
- delete/reset credentials button

Security note: credentials should be stored outside git and ideally encrypted through OS keychain if using Electron/Tauri.

### Templates/Presets Tab

Useful presets:

- Basic silent auction
- Buy-now-only event
- Mixed silent + buy now
- Large item count stress event
- Bidder-heavy event
- Minimal bug repro event

Templates should save config only, never credentials.

### Result Screen

Display:

- event ID
- event name
- slug
- admin URL
- public URL
- bidder list
- item count and sale modes
- copy summary button
- export JSON/CSV button

---

## Data Model Draft

### Environment Settings

```ts
type EnvironmentSettings = {
  id: string;
  label: string;
  adminBaseUrl: string;
  publicBaseUrl: string;
  apiBaseUrl: string;
  orgApiKey?: string;
  eventApiKey?: string;
  uiFallbackLogin?: {
    username: string;
    passwordRef: string;
  };
};
```

### Event Recipe

```ts
type EventRecipe = {
  environmentId: string;
  event: EventDetails;
  bidders: BidderGenerationConfig;
  items: ItemGenerationConfig;
  advanced?: AdvancedEventSettings;
};
```

### Creation Result

```ts
type CreationResult = {
  eventId: string;
  eventName: string;
  slug: string;
  adminUrl: string;
  publicUrl: string;
  bidders: CreatedBidder[];
  items: CreatedItem[];
  warnings: string[];
  logs: CreationLogEntry[];
};
```

---

## Important Design Principles

### 1. Make Recipes Reproducible

Every event should be creatable from a saved recipe. This matters more than a fancy GUI.

### 2. Separate Secrets From Recipes

A saved event template should be safe to commit/share. It should reference an environment by name but never contain API keys.

### 3. Make Generated Data Predictable

Use deterministic names when possible:

- `QA Bidder 001`
- `qa-bidder-001@example.test`
- `QA Item 001`

Predictable generated data makes debugging easier.

### 4. Add a Dry-Run/Preview Step

Before creation, show exactly what will happen. This reduces accidental environment mistakes.

### 5. Validate After Creation

Do not just trust create responses. Fetch the created event/items/bidders afterward if API allows it.

### 6. Treat Playwright as an Adapter, Not the Core

Browser automation should be isolated so selector changes do not infect the rest of the application.

---

## Open Questions

### API Coverage

Need to determine:

- Is there an API endpoint to create an event?
- Is there an API endpoint to update event dates/slug/settings?
- Is there an API endpoint to create bidders?
- Is there an API endpoint to create items?
- Can sale mode be set through API?
- Can buy-now pricing be set through API?
- Can event-level feature toggles be set through API?
- What API keys are required per environment?
- Are org API keys enough, or is an event API key only available after event creation?

### Auth and Permissions

Need to determine:

- Does this need user login credentials for UI fallback?
- Are API keys enough for all dev/staging environments?
- Should the tool prevent production use by default?
- Should credentials be per-user only?

### GUI Tech Choice

Options:

1. **Electron + TypeScript**
   - Pros: mature, easy UI, Playwright/Node ecosystem fits well
   - Cons: heavier app

2. **Tauri + TypeScript/Rust**
   - Pros: lighter desktop app, secure settings possibilities
   - Cons: Rust backend complexity

3. **Python + PySide/Flet**
   - Pros: fast internal prototype, simple API scripting
   - Cons: desktop packaging can be annoying, less aligned with Playwright/TS test ecosystem

4. **Local web app** — rejected for product direction
   - Pros: easiest to build/debug, accessible in browser
   - Cons: not the intended delivery model; credentials and local server lifecycle need care
   - Use only as a temporary UI prototype technique, not as the app architecture

Initial recommendation: **desktop-first TypeScript app: Electron or Tauri**. The current HTML/React prototype can remain useful as a design baseline, but implementation should move toward a packaged desktop application with a local service/orchestration layer and OS-backed credential storage.

---

## Implementation Phases

## Phase 0: Discovery

### Task 1: Identify Existing API Capabilities

**Objective:** Map which event/bidder/item creation steps can be done by API.

**Files:**
- Create: `docs/event-creator/api-capability-matrix.md`

**Steps:**
1. List required creation operations.
2. Find matching API endpoints.
3. Document request shape, response shape, required auth, and environment base URL.
4. Mark each operation as API-supported, UI-only, unknown, or not needed for MVP.

**Validation:**
- Matrix clearly identifies API vs Playwright fallback needs.

### Task 2: Define First MVP Event Recipe

**Objective:** Create a concrete recipe schema for the first useful QA event.

**Files:**
- Create: `docs/event-creator/mvp-recipe-schema.md`

**Steps:**
1. Define event fields.
2. Define bidder generation fields.
3. Define item generation fields.
4. Define environment reference fields.
5. Add example recipe.

**Validation:**
- A QA can read the schema and understand exactly what event would be created.

---

## Phase 1: Prototype Without Full GUI

### Task 3: Build CLI/Script Proof of Concept

**Objective:** Prove the creation engine works before investing in GUI polish.

**Files:**
- Create: `src/event-creator/createEventFromRecipe.*`
- Create: `src/event-creator/types.*`
- Create: `src/event-creator/adapters/*`
- Create: `examples/basic-silent-auction.recipe.json`

**Steps:**
1. Load recipe JSON.
2. Load environment settings.
3. Validate required credentials.
4. Create event.
5. Create bidders.
6. Create items.
7. Print final summary.

**Validation:**
- One command creates a basic event in a dev environment from a recipe file.

### Task 4: Add Creation Logs

**Objective:** Make every step auditable and debuggable.

**Files:**
- Modify: creation engine files from Task 3

**Steps:**
1. Add structured log entries.
2. Include operation name, method/API/UI, status, response ID, and error message.
3. Print logs to console.
4. Save logs to artifact file.

**Validation:**
- Failed creation clearly says which step failed and why.

---

## Phase 2: Minimal GUI

### Task 5: Create Main Form

**Objective:** Let QA fill out a basic event recipe through a GUI.

**Files:**
- Create: GUI app files depending on chosen tech stack

**Steps:**
1. Add environment dropdown.
2. Add event name/slug/date fields.
3. Add bidder count field.
4. Add item count/price/sale mode fields.
5. Keep the GUI settings-only: no preview panel and no customer-facing page builder.

**Validation:**
- Form produces the same recipe shape as Phase 1.

### Task 6: Add Create Button and Progress UI

**Objective:** Run the creation engine from the GUI.

**Files:**
- Modify: GUI app files
- Modify: creation engine if needed for progress callbacks

**Steps:**
1. Add disabled/enabled create button based on validation.
2. Add progress list.
3. Show each creation step as pending/running/success/error.
4. Display result summary when done.

**Validation:**
- User can create an event from the GUI and see progress.

---

## Phase 3: Settings and Templates

### Task 7: Add Settings Tab

**Objective:** Store per-environment settings and credentials safely.

**Files:**
- Create/modify: settings store files depending on chosen tech stack

**Steps:**
1. Add environment CRUD UI.
2. Add API URL/base URL fields.
3. Add key fields.
4. Add test connection action.
5. Store secrets outside recipe files.

**Validation:**
- Environment settings persist between launches.
- Recipe export does not include secrets.

### Task 8: Add Templates

**Objective:** Let QA export/import reusable event recipes without leaking secrets.

**Files:**
- Modify: `event-model.js`
- Modify: `app.jsx`
- Modify: `event-model.test.js`
- Future desktop implementation: replace browser download/file input with native save/open dialogs.

**Steps:**
1. Add an **Export recipe** action to write the current event/bidder/item settings as JSON.
2. Add an **Import recipe** action to load that JSON back into the form.
3. Include the selected environment ID and generated settings only.
4. Exclude all secrets: org token, event token, bearer tokens, and local credential-store fields.
5. Keep environment URLs derived from the central environment map; imported recipes should not override base URLs from untrusted JSON.
6. Preserve current credentials when importing a recipe.

**Validation:**
- Exported JSON contains environment/event/bidder/item settings and no tokens.
- Imported JSON repopulates the form while preserving local secrets.
- A saved recipe can be loaded and used to create a similar event later.

---

## Phase 4: Hardening

### Task 9: Add Post-Creation Verification

**Objective:** Confirm created event data actually exists in the target environment.

**Files:**
- Modify: creation engine/adapters

**Steps:**
1. Fetch created event by ID/slug.
2. Fetch created bidders if API supports it.
3. Fetch created items if API supports it.
4. Compare expected counts/fields.
5. Show warnings for mismatches.

**Validation:**
- Result screen distinguishes created, verified, and partially verified data.

### Task 10: Add Safety Rails

**Objective:** Prevent accidental creation in the wrong environment.

**Files:**
- Modify: GUI and creation engine

**Steps:**
1. Require explicit confirmation for staging/prod-like environments.
2. Show environment badge everywhere.
3. Block production entirely; production is not listed as an environment.
4. Do not add dry-run/preview to the core flow. Creation inputs remain settings-only.

**Validation:**
- User cannot accidentally click once and create in production-like environments without confirmation.

---

## Risks and Tradeoffs

### API Gaps

Some event settings may not be API-accessible. Mitigation: document gaps and isolate Playwright fallback.

### Flaky UI Automation

If Playwright is needed, selectors can break. Mitigation: keep UI automation small, prefer stable selectors, and log fallback usage.

### Credentials Handling

Local credential storage must be treated carefully. Mitigation: use OS keychain or encrypted store if possible; never store secrets in templates.

### Environment Drift

Different environments may have different data/API behavior. Mitigation: per-environment capability checks and test connection.

### Scope Creep

Event creation has many knobs. Mitigation: build around templates and MVP fields first; add advanced toggles only after the core flow is reliable.

---

## API Documentation Findings from Hindsight

Based on the ingested ClickBid V4 API documentation, this tool looks more feasible than the initial unknowns suggested.

### General API Shape

- ClickBid V4 API base URL: `https://cbodev4.com/api/v4`.
- Auth uses Bearer tokens.
- Tokens can have Event or Organization scope.
- API supports pagination, eager loading through `?with=`, sorting through `?sort=-field`, and filtering with operators like `field[eq]=value`, `field[neq]=value`, `field[lt]=value`, `field[lte]=value`, `field[gt]=value`, `field[gte]=value`, and `field[like]=value`.

### Event Creation / Event Management

- Event endpoints are scoped under organizations: `/organizations/{organization}/events`.
- Event endpoints use an organization token.
- Slug validation:
  - 3–50 characters
  - must contain at least one letter
- This strongly supports the settings-tab idea: each environment needs an API base URL plus an organization token for creating new events.

### Bidder Creation

- Bidder endpoints provide full CRUD.
- Bulk create is supported.
- Required bidder fields include:
  - `accept_texts`
  - `bidder_number`
  - `first_name` max 25 chars
  - `last_name` max 35 chars
- `BidderResource` includes arrays:
  - `emails[]`
  - `phones[]`
  - `bids[]`
  - `checkouts[]`
  - `tags[]`
- External IDs are supported for CRM-style integrations through `externalIds` and `external_id`, with optional strings up to 100 chars.
- Bidder upsert operations are supported.
- Deleting a bidder fails if the bidder has bids or checkout records, which matters for any future cleanup feature.

### Item Creation

- Item endpoints support multipart CRUD.
- Bulk create is supported.
- Required item fields include:
  - `item_name` max 250 chars
  - `item_number` min 1
  - `item_type_id`
  - `status_id`
- `reserve_amount` max is `99999999`.
- Item endpoints support appeal settings and consignment management.
- Item donor endpoints support bulk add, including sort order, donor info, address/contact info, donated items, and FMV.

### Item Types / Sale Modes

Known item type behavior from ingested docs:

- Silent items support mobile bidding with starting bid, increments, Buy Now, and FMV.
- Live items are in-person auctioneer-driven; admin enters winner through Butler.
- Donation items accept positive donation amounts.
- Bid placement rules:
  - Silent items, type `10`, require a bid above current winning bid plus minimum increment.
  - Donation items, type `30`, accept any positive amount.

This means the MVP item generator should expose friendly labels like `Silent`, `Live`, and `Donation`, but internally map them to API `item_type_id` values.

### Bid App / Landing Page Settings

- `GET /events/{event}/bidapp-settings` auto-creates a settings record if missing.
- `PATCH /events/{event}/bidapp-settings` supports partial updates.
- Supported fields include:
  - `title` max 75 chars
  - `brand_color`
  - `font` max 30 chars
  - various toggle flags
- This reduces the need for Playwright for at least some public/bid app configuration.

### Content Blocks / Landing Page

- Content Block endpoints support 12 block types:
  - `appeal-display`
  - `auction-items`
  - `cumulative-total-bar`
  - `donate-item-form`
  - `featured-items`
  - `featured-media`
  - `blank`
  - `image-text`
  - `leaderboard`
  - `donation-items`
  - `sponsors`
  - `donate-p2p-form`
- Content block type is immutable on PATCH.
- PUT requires type and title.
- Limits:
  - title max 50 chars
  - header max 200 chars
  - description max 4000 chars

This suggests a later version could create landing page content blocks from templates.

### Ticketing / Guest Data

- Ticketing supports forms, registrations, and guest management.
- Guests can be linked to `registration_id` and `bidder_id`.
- Guests support `meal_choice_id` and `table_name` assignment.

This is probably outside the first MVP, but valuable for a future “ticketed event recipe” preset.

### Reports / Verification

- Sales report endpoint supports filtering by any response field, sorting, grouping, and bidder tag filters.
- Sales report CSV export includes 40+ columns covering financial data, bidder info, and item details.

This could be useful for post-create validation or future test data assertions, but probably not needed for first MVP.

---

## Updated Recommendation After Reviewing API Docs

The tool should definitely be **API-first**, because the ingested docs show API coverage for the core objects:

- organization-scoped event creation
- bidder CRUD and bulk create
- item CRUD and bulk create
- item donor bulk add
- bid app settings GET/PATCH
- content blocks
- ticketing/guest management

The MVP should not start with Playwright. Playwright should be reserved for admin-only gaps discovered during implementation.

### Better MVP Creation Order

1. Save environment settings with API base URL and org token.
2. Create event through `/organizations/{organization}/events`.
3. Use the created event ID plus event-scoped/org-scoped token flow as required.
4. Create bidders through bulk bidder endpoint.
5. Create items through bulk item endpoint.
6. Patch bid app settings if needed.
7. Fetch created event, bidders, and items using API filters/eager loading for verification.
8. Display final URLs and generated data.

### Stronger MVP Fields Based on API Docs

Event form:
- organization/environment
- event name
- slug with validation rules baked into UI
- dates/timezone if supported by event endpoint

Bidder form:
- count
- starting bidder number
- first/last name pattern constrained to API max lengths
- email pattern
- accept_texts default
- optional tags

Item form:
- count
- starting item number
- item name pattern constrained to 250 chars
- item type: Silent / Live / Donation
- status
- reserve amount
- FMV/donor fields if needed
- silent-specific fields such as increment / buy now only after confirming exact request fields

---

## Prototype Progress Log

Completed in `/home/bradley/mkEvent/`:

- Built the QA settings-only React prototype around environment, event basics, bidders, items, and API settings.
- Removed preview/dry-run and desktop chrome from the prototype flow.
- Added trusted QA environment presets: Stage, triage, dev, dev2, dev3, dev4 only.
- Centralized base URL handling so API URL is derived as `{baseUrl}/api/v4`.
- Added recipe export/import. Exported recipes exclude org/event tokens, and import preserves local credentials while using trusted environment presets.
- Verified recipe export/import through the actual localhost-rendered UI on port 4173.
- Added local settings persistence for environment, organization ID, org token, event token, and fallback browser in `localStorage`, separate from recipe export/import.
- Renamed "URL slug" → "Event keyword" in UI labels/help text (data property stays `slug` for API compatibility).
- Locked Settings base URL to trusted QA environment presets. Removed free-text baseUrl input. `buildRecipe` now always derives URLs from the environment preset — stale or malicious `baseUrl` values in config are ignored.
- Added prototype security warning in Settings about localStorage and CDN dependencies; noted planned desktop OS keychain migration.
- Built CORS proxy (`proxy-server.py`) on localhost:9999 to forward browser API calls to ClickBid, bypassing same-origin restrictions.
- Added `apiProxyCall()` to the model — a generic proxy caller for Test Connection and future API adapters.
- Added `proxyUrl` to DEFAULT_CONFIG and local settings persistence.
- Added Test Connection button to Settings section — calls GET /organizations/{org}/events?per_page=1 through the proxy to verify reachability, token validity, and org ID.
- Hardened proxy with ClickBid host allowlist (cbo.bid, cbotriage.bid, cbodev.bid, cbodev2.com, cbodev3.com, cbodev4.com). Non-ClickBid URLs are rejected with 403.
- CORS headers now sent on ALL responses including error paths — malformed requests return readable JSON errors instead of opaque CORS failures.
- Locked proxyUrl to read-only (localhost:9999/proxy) — prevents token exfiltration via malicious proxy URL.
- Test Connection state auto-resets to idle when environment, org ID, or token changes — prevents stale 'Connected' indicators.
- Scaffolded the creation engine (`creation-engine.js`) with ApiClient, ProgressReporter, EventAdapter, BidderAdapter, ItemAdapter, and `createEvent` orchestrator. 11 unit tests (all pass). Supports request bodies through the proxy for POST-based creation.
- Updated `apiProxyCall` and `proxy-server.py` to forward request bodies for POST/PUT API calls.

Current next implementation step:

1. Wire the real `create-runner.jsx` to use `CreationEngine.createEvent` instead of the current simulation.
2. Then add real ClickBid API event creation through the creation engine.

---

## Recommended Next Step

Before choosing the GUI framework, do a focused API matrix from the ingested docs and, ideally, the actual OpenAPI/source docs if available. The fastest useful path is:

1. Define the first MVP recipe.
2. Convert the known Hindsight findings above into an API capability matrix.
3. Identify exact endpoint paths and request bodies for event, bulk bidder, bulk item, and bid app settings.
4. Build a script/CLI proof of concept from one JSON recipe.
5. Only then build the GUI around the proven creation engine.

This avoids spending time on UI before proving the exact API calls and request payloads.

---

## My Current Recommendation

Yes, this is worth building, and the API documentation makes it look very feasible.

For QA specifically, the winning version is not the fanciest GUI. The winning version is the one that reliably creates a reproducible event in under a minute and tells the user exactly what was created.

I would start with an **API-first recipe engine**, then wrap it in a GUI once the creation path is proven. Playwright should be available, but treated as a last-resort adapter for settings the API cannot reach.
