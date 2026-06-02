# mkEvent

Personal QA tool for creating ClickBid events with repeatable setup.

`mkEvent` is a QA event creator that now has two runnable shells:
- the legacy browser flow
- an Electron desktop proof of concept

It lets QA create:
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

## Current Runtime Modes

- Legacy browser entry: [mkEvent.html](/home/bradley/mkEvent/mkEvent.html)
- Vite/module renderer: [index.html](/home/bradley/mkEvent/index.html)
- Electron desktop shell: [src/main/index.cjs](/home/bradley/mkEvent/src/main/index.cjs)

## How It Works

- The UI is loaded directly from [mkEvent.html](/home/bradley/mkEvent/mkEvent.html).
- The Vite renderer lives in [src/renderer](/home/bradley/mkEvent/src/renderer).
- In the legacy browser flow, API calls go through the local Python proxy in [proxy-server.py](/home/bradley/mkEvent/proxy-server.py).
- The packaged desktop app instead runs an **in-process Node proxy** (`src/main/proxy-server.cjs`) on the same `127.0.0.1:9999` contract — no Python required.
- When normal API creation is unavailable, mkEvent uses the Playwright-based admin/browser fallback in [browser-fallback.cjs](/home/bradley/mkEvent/browser-fallback.cjs). The installer bundles Chromium so this works with no separate Playwright install.
- The Electron app auto-starts the in-process proxy when the desktop shell launches.

## Requirements

For QA users running the installed app:

- Windows 10 or 11
- A valid ClickBid organization API token
- For the browser fallback: admin email + admin password

Nothing else — the installer bundles the runtime and Chromium.

### Developing mkEvent

To work on the source (not needed to run the installed app):

- Node.js
- Python 3 (only for the legacy browser flow; the packaged desktop app no longer uses it)
- Playwright installed via `npm install`

## Setup

Install dependencies:

```bash
npm install
```

Start the local proxy:

```bash
python3 proxy-server.py
```

Open the legacy app:

- Open [mkEvent.html](/home/bradley/mkEvent/mkEvent.html) in a browser.

Run the Vite migration path:

```bash
npm run dev
```

- Then open the local Vite URL, typically `http://127.0.0.1:5173`.
- This is the in-progress module-based renderer that will replace the legacy HTML entry.

Run the Electron desktop POC in dev mode:

```bash
npm run electron:dev
```

Run the Electron desktop POC against a built renderer:

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

- [mkEvent.html](/home/bradley/mkEvent/mkEvent.html): browser entrypoint
- [app.jsx](/home/bradley/mkEvent/app.jsx): top-level app state and orchestration
- [sections.jsx](/home/bradley/mkEvent/sections.jsx): UI sections and form editors
- [create-runner.jsx](/home/bradley/mkEvent/create-runner.jsx): run modal and progress display
- [event-model.js](/home/bradley/mkEvent/event-model.js): config defaults, normalization, recipe build/import/export
- [creation-engine.js](/home/bradley/mkEvent/creation-engine.js): API-first creation pipeline and fallback decision logic
- [browser-fallback.cjs](/home/bradley/mkEvent/browser-fallback.cjs): Playwright admin automation
- [proxy-server.py](/home/bradley/mkEvent/proxy-server.py): local CORS proxy and fallback launcher
- [src/main/index.cjs](/home/bradley/mkEvent/src/main/index.cjs): Electron main process
- [src/main/proxy-manager.cjs](/home/bradley/mkEvent/src/main/proxy-manager.cjs): desktop proxy lifecycle
- [src/preload/index.cjs](/home/bradley/mkEvent/src/preload/index.cjs): Electron preload bridge

## Architecture

High-level flow:

1. The browser loads [mkEvent.html](/home/bradley/mkEvent/mkEvent.html), which pulls in the app scripts directly.
2. [app.jsx](/home/bradley/mkEvent/app.jsx) owns the main config state, environment switching, import/export, slug checks, and create action.
3. [sections.jsx](/home/bradley/mkEvent/sections.jsx) renders the editor UI for API settings, event basics, bidders, items, auction settings, and ticket pages.
4. [event-model.js](/home/bradley/mkEvent/event-model.js) normalizes UI state and builds a stable recipe object for creation.
5. [creation-engine.js](/home/bradley/mkEvent/creation-engine.js) runs the creation pipeline:
   - validate slug
   - create event
   - create bidders
   - create items
   - verify seeded counts
6. Browser-side HTTP calls go through [proxy-server.py](/home/bradley/mkEvent/proxy-server.py) to avoid CORS issues and restrict requests to approved ClickBid hosts.
7. If event creation needs the admin flow, [proxy-server.py](/home/bradley/mkEvent/proxy-server.py) launches [browser-fallback.cjs](/home/bradley/mkEvent/browser-fallback.cjs), which uses Playwright to log into ClickBid admin and drive the same AJAX endpoints used by the real admin UI.

Data model split:

- UI config: mutable editor state used by the form
- normalized config: cleaned config with defaults applied
- recipe: final creation payload used by the engine and fallback

Execution split:

- API-first path: organization/event token based, via `api/v4`
- browser fallback path: admin-session based, via Playwright + admin AJAX

Ticket page path:

- Ticket page config is modeled in [event-model.js](/home/bradley/mkEvent/event-model.js)
- Edited in [sections.jsx](/home/bradley/mkEvent/sections.jsx)
- Passed through [creation-engine.js](/home/bradley/mkEvent/creation-engine.js)
- Applied in [browser-fallback.cjs](/home/bradley/mkEvent/browser-fallback.cjs)

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

- Proxy/fallback logs are written to [logs/mkEvent-proxy.log](/home/bradley/mkEvent/logs/mkEvent-proxy.log).
- Browser fallback failures also try to save a screenshot under `/home/bradley/mkEvent/logs/`.
- If the UI is already open after code changes, reload the page.

Common issues:

- Missing org token: API validation and creation will fail.
- Missing admin credentials: browser fallback cannot launch.
- Proxy not running: browser requests to ClickBid will fail.
- Open app tab is stale: reload after local JS changes.
