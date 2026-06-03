# mkEvent

Personal QA tool for creating ClickBid events with repeatable setup.

`mkEvent` is an Electron desktop app that lets QA create:
- a base event
- seeded bidders
- seeded items
- auction settings
- ticket pages, tickets, sponsors, underwriting, selections, and custom questions

It is aimed at non-production ClickBid environments. The default environment is `stage`.

## Windows install (for QA users)

mkEvent ships as a single Windows installer — **no Node, Python, or other setup required**. The installer bundles the app runtime, an in-process proxy, and the Chromium browser used by the admin fallback.

1. Download `mkEvent Setup <version>.exe`.
2. Double-click it. Because the app is not yet code-signed, Windows may show
   **"Windows protected your PC"** (Microsoft Defender SmartScreen). Click
   **More info → Run anyway**.
3. Follow the installer, then launch **mkEvent** from the Start menu.
4. Open **Settings** (gear icon, top-right) and enter your ClickBid org token
   (and admin email/password if you use the browser fallback). These are stored
   locally on your machine only.

## How It Works

- The Electron main process (`src/main/index.cjs`) auto-starts an **in-process Node proxy** (`src/main/proxy-server.cjs`) on `127.0.0.1:9999`, then opens the window.
- The renderer is a Vite/React app under `src/renderer` (entry `index.html` → `src/renderer/main.jsx`). It talks to ClickBid through the local proxy to avoid CORS and to restrict requests to approved ClickBid hosts.
- Shared logic (`event-model.js`, `creation-engine.js`, `item-library.js`) lives at the repo root as global-script modules and is consumed by the renderer through thin ESM shims in `src/shared`.
- When normal API creation is unavailable, mkEvent uses the Playwright-based admin/browser fallback in `browser-fallback.cjs`, spawned by the proxy manager. The installer bundles Chromium so this works with no separate Playwright install.

## Requirements

For QA users running the installed app:

- Windows 10 or 11
- A valid ClickBid organization API token
- For the browser fallback: admin email + admin password

Nothing else — the installer bundles the runtime and Chromium.

### Developing mkEvent

To work on the source (not needed to run the installed app):

- Node.js
- Playwright's Chromium installed via `npm install` (used by the admin fallback)

## Setup

Install dependencies:

```bash
npm install
```

Run the renderer alone in the browser (UI work, no Electron shell):

```bash
npm run dev
```

- Then open the local Vite URL, typically `http://127.0.0.1:5173`.

Run the Electron desktop app in dev mode (starts the in-process proxy + window):

```bash
npm run electron:dev
```

Run the Electron app against a production-built renderer:

```bash
npm run electron:start
```

## Build the Windows installer

```powershell
npm run dist:win
```

This produces `release\mkEvent Setup <version>.exe` — a single, prerequisite-free NSIS installer that bundles the runtime, the in-process proxy, and Chromium. The app ships **unsigned** (signing-ready: add signing options under `build.win` in `package.json` when a certificate is available).

A clean-room smoke test lives under `sandbox/`: with the Windows Sandbox feature enabled, double-click `sandbox\mkEvent-smoke.wsb` to silently install the app in a fresh VM and run `mkEvent.exe --smoke-check` (proxy health + Chromium launch). The verdict is written to `sandbox\results\result.txt`.

> First build note: electron-builder extracts a `winCodeSign` helper that contains macOS symlinks. On Windows this needs symlink-create privilege — enable **Developer Mode** (Settings → System → For developers) or run the first build from an elevated terminal. Subsequent builds reuse the cache.

## Running Tests

```bash
npm test
```

## Main Files

- `src/main/index.cjs`: Electron main process (boots the proxy, opens the window, `--smoke-check`)
- `src/main/proxy-manager.cjs`: in-process proxy lifecycle + browser-fallback runner
- `src/main/proxy-server.cjs`: the Node CORS proxy (host-allowlisted forward + fallback routes)
- `src/preload/index.cjs`: Electron preload bridge
- `index.html` → `src/renderer/main.jsx`: renderer entry
- `src/renderer/App.jsx`: top-level app state and orchestration
- `src/renderer/sections.jsx`: UI sections and form editors
- `src/renderer/create-runner.jsx`: run modal and progress display
- `src/shared/*.js`: ESM shims that expose the root global-script modules to the renderer
- `event-model.js`: config defaults, normalization, recipe build/import/export
- `creation-engine.js`: API-first creation pipeline and fallback decision logic
- `browser-fallback.cjs`: Playwright admin automation

## Architecture

High-level flow:

1. `src/renderer/App.jsx` owns the main config state, environment switching, import/export, slug checks, and create action.
2. `src/renderer/sections.jsx` renders the editor UI for API settings, event basics, bidders, items, auction settings, and ticket pages.
3. `event-model.js` normalizes UI state and builds a stable recipe object for creation.
4. `creation-engine.js` runs the creation pipeline:
   - validate slug
   - create event
   - create bidders
   - create items
   - verify seeded counts
5. HTTP calls go through the in-process Node proxy (`src/main/proxy-server.cjs`) to avoid CORS issues and restrict requests to approved ClickBid hosts.
6. If event creation needs the admin flow, the proxy manager launches `browser-fallback.cjs`, which uses Playwright to log into ClickBid admin and drive the same AJAX endpoints used by the real admin UI.

Data model split:

- UI config: mutable editor state used by the form
- normalized config: cleaned config with defaults applied
- recipe: final creation payload used by the engine and fallback

Execution split:

- API-first path: organization/event token based, via `api/v4`
- browser fallback path: admin-session based, via Playwright + admin AJAX

Ticket page path:

- Ticket page config is modeled in `event-model.js`
- Edited in `src/renderer/sections.jsx`
- Passed through `creation-engine.js`
- Applied in `browser-fallback.cjs`

## Environment Notes

Trusted environments are hardcoded in the proxy/model:

- `stage` -> `https://cbo.bid`
- `triage` -> `https://cbotriage.bid`
- `dev` -> `https://cbodev.bid`
- `dev2` -> `https://cbodev2.com`
- `dev3` -> `https://cbodev3.com`
- `dev4` -> `https://cbodev4.com`

`stage` uses browser/admin event creation directly. mkEvent skips the org-scoped hosted API create probe there because that route is not available in the deployed environment.

Other environments still use API-first event creation unless mkEvent learns that the hosted create route is unavailable, in which case it caches that and goes straight to browser fallback on later runs.

## Ticket Page Support

mkEvent can currently configure:

- ticket page form name and display name
- payment/settings toggles
- individual tickets
- sponsor levels
- underwriting
- selections, including `Show On` target and optional description
- custom questions for tickets, sponsors, and underwriting
  - type
  - required
  - active
  - guest vs ticket placement where applicable

Page-level custom questions are still not wired.

## Logging and Troubleshooting

- The proxy log is written to `mkEvent-proxy.log` in the app's userData dir
  (`%APPDATA%\mkEvent` on Windows). The run modal's **Copy debug report** button
  bundles the UI transcript + proxy log for troubleshooting.
- Browser fallback failures also try to save a screenshot under the app's
  `logs` folder (`%APPDATA%\mkEvent\logs`), or the OS temp dir as a fallback.

Common issues:

- Missing org token: API validation and creation will fail.
- Missing admin credentials: browser fallback cannot launch.
- Hitting the ClickBid active-event cap (e.g. 40) fails creation server-side —
  archive old events in the ClickBid admin to free slots.
