# Design: All-in-one bundled Windows installer for mkEvent

- **Date:** 2026-05-29
- **Status:** Approved (design); ready for implementation planning
- **Author:** brad@cbo.io (with Claude)
- **Topic:** Package mkEvent as a single zero-prerequisite Windows installer and prove a fresh install works via Windows Sandbox.

## Context

mkEvent is a QA tool that creates ClickBid events. It will be distributed to **2-3 non-technical Windows users**. The current app runs as a developer setup that assumes Node.js, Python 3, and a manual Playwright browser install are present on the machine. That is too fragile for non-technical users.

The goal of this work is a **single installer that bundles everything**, so a user double-clicks one `.exe`, clicks through, and the app launches and runs — with **nothing else to install, download, or configure**.

We deliberately rejected a "bootstrapper" installer that detects and downloads missing dependencies at run time: it needs internet + admin rights and fails on locked-down / antivirus machines in ways non-technical users cannot fix, and it is more code to maintain. Bundling is both the easier user experience and the smaller long-term maintenance burden.

## Goal & definition of done

**Done = a repeatable Windows Sandbox test goes green on a guaranteed-fresh machine**, where green means:

1. The installer runs on a clean Windows Sandbox with **zero prerequisites** and completes.
2. The app window launches; the UI and Settings render with **no error dialog**.
3. The in-process **Node proxy answers on `127.0.0.1:9999`**.
4. The **bundled Playwright Chromium launches and closes once** (headless, no network, no credentials) — a cheap proof that the hardest-to-bundle dependency is actually present and wired.

Check #4 is included on purpose. The default `stage` environment *requires* the Playwright browser fallback for event creation (`creation-engine.js:574-581`), so an install that launches but cannot resolve Chromium would be a hollow "green." Check #4 verifies Chromium is present without needing ClickBid credentials or network.

## Non-goals (explicitly out of scope)

- End-to-end event creation inside the Sandbox test (no ClickBid network/credential exercise).
- Code signing (see "Signing-ready" — we ship unsigned for now, structured for a later drop-in cert).
- Auto-update (the chosen architecture supports `electron-updater` later as a config addition; not built now).
- Legacy-renderer cleanup beyond what packaging requires.
- Any new product features.
- macOS/Linux installers (users are all on Windows).

## Background: current state (evidence)

- **Electron shell exists and works** but auto-starts the proxy by spawning Python: `src/main/proxy-manager.cjs:61-84` runs `python3 proxy-server.py` (tries `python3`, `python`, `py -3`; errors if none found). `src/main/index.cjs` boots, starts the proxy, and shows a warning dialog on failure.
- **Proxy is Python** (`proxy-server.py`): binds `127.0.0.1:9999` (`DEFAULT_HOST`/`DEFAULT_PORT`), single-threaded `HTTPServer`. Routes: `POST /proxy` (CORS forward) and `POST /fallback/create-event`, `/fallback/post-item-config`, `/fallback/post-create-activity`. Enforces a host allowlist (`cbo.bid`, `cbotriage.bid`, `cbodev.bid`, `cbodev2.com`, `cbodev3.com`, `cbodev4.com`) and redacts sensitive keys (e.g. `adminpassword`) in logs. Launches the browser fallback via `subprocess.run(['node', BROWSER_FALLBACK_SCRIPT], ...)` with a computed timeout (`180 + ticket*35 + bids*6 + ...`, clamped 300-1200s).
- **Renderer contract** the proxy must preserve: `event-model.js:1554-1581` (`apiProxyCall`) POSTs to the proxy URL; the Settings field is read-only and fixed to `http://localhost:9999/proxy` (`sections.jsx:1332`).
- **Playwright is a runtime dependency, not bundled**: `browser-fallback.cjs:42-62` requires the `playwright` module and errors with "install playwright … npx playwright install chromium" if missing. It launches Chromium `headless: true` and writes failure screenshots to `logs/` with ISO timestamps.
- **No packaging config**: `package.json` has no electron-builder/electron-forge config; `main` is `src/main/index.cjs`; deps include `playwright`, `react`, `react-dom`, `@faker-js/faker`; devDeps include `electron`, `vite`.
- **Two renderer copies exist**: root-level `*.jsx` (legacy/browser flow) and `src/renderer/*.jsx` (the Vite/Electron renderer). The canonical one to package is `src/renderer`.

## Target architecture (end state)

A single **NSIS installer** produced by **electron-builder** containing everything the app needs:

- **Electron** — provides the bundled JS runtime and the Chromium that renders the UI. Removes any need for system Node.
- **Renderer** — the Vite build of `src/renderer/`.
- **Proxy, rewritten in Node, running in-process in the Electron main process.** This removes the Python dependency entirely. It listens on `127.0.0.1:9999` and serves the same routes and behavior as `proxy-server.py`, so the renderer's existing calls and the read-only `localhost:9999` Settings field keep working unchanged.
- **Playwright + its Chromium browser binary, bundled** as unpacked resources, with the browser executable path resolved at run time so Playwright never downloads anything.

Result: no Python, no system Node, no `npx playwright install`, no run-time downloads. The user installs one file.

## Component design

### 1. Proxy: Python -> Node (in-process)

Replace `proxy-server.py` with a Node implementation hosted by the Electron main process (natural home: `src/main/proxy-manager.cjs`, which currently spawns Python). It must preserve, 1:1:

- Bind address/port `127.0.0.1:9999` and the `POST /proxy` forwarding contract used by `apiProxyCall`.
- The `POST /fallback/*` routes.
- The **host allowlist** (same six hosts) — this is a security control and must not regress.
- **Secret redaction** in logs (never log bearer tokens or `adminPassword`).

Concurrency note: the Python server is single-threaded; a single desktop user does not need more, but the Node rewrite should at least not deadlock on overlapping requests. Keep it simple (Node's async HTTP handles this naturally).

### 2. Browser fallback launch under Electron

Today the proxy shells out to `node browser-fallback.cjs` (`proxy-server.py:179-186`). Inside a packaged Electron app there is no `node` on PATH. Replace the subprocess launch with an Electron **`utilityProcess.fork`** (or `child_process.fork` with `ELECTRON_RUN_AS_NODE=1`) pointed at the packaged `browser-fallback.cjs`. The fallback is **not exercised by the smoke test**, but it must be wired correctly for the app to be usable, and the Chromium path (below) must be visible to it.

### 3. Playwright / Chromium bundling (the main risk)

- Bundle the Chromium browser build with electron-builder via `extraResources` (and `asarUnpack` for anything that must live outside the asar archive).
- At run time, set `PLAYWRIGHT_BROWSERS_PATH` (or pass an explicit `executablePath` to `chromium.launch`) to the unpacked resource location, for both the smoke-test self-check and the real fallback.
- Verify the resolved path works from the **packaged** app, not just `npm run electron:dev` — this is exactly what the red->green Sandbox runs will confirm.

### 4. electron-builder config (signing-ready)

- Add electron-builder with a `win` target of `nsis`, producing a single installer.
- Point the build at the `src/renderer` Vite output and `src/main` / `src/preload`.
- Include `win.signtoolOptions` / `certificateFile` fields **present but empty**, with a comment, so enabling signing later is filling in fields + env vars — no restructuring.

## Validation: Windows Sandbox smoke test

- A scripted **`.wsb`** (Windows Sandbox config) that:
  - Maps the folder containing the built installer **read-only** into the Sandbox, plus a **writable results folder**.
  - On logon, runs a script that installs silently (NSIS `/S`), launches the app, runs checks #2-#4 from "Definition of done," and writes a `PASS`/`FAIL` result file to the writable folder.
  - Because Sandbox **resets to a clean state every launch**, every run is a guaranteed-fresh machine.
- A **manual visual pass** in the same fresh Sandbox: apply **Mark-of-the-Web** to the installer and double-click it to see the real **SmartScreen** ("Windows protected your PC") prompt that users will hit, since we ship unsigned. The automated `/S` path bypasses SmartScreen, so this manual pass keeps the test honest about the real first-run experience.
- **Host requirement:** Windows Sandbox needs Win10/11 **Pro/Enterprise** with virtualization enabled (to confirm on the build host).

## Build & dev workflow

- **Build on the Windows host**, from a Windows-native checkout (e.g. `C:\mkEvent`). NSIS packaging and Windows Sandbox both live on Windows; building natively is far more reliable than building through `\\wsl$\` or via wine.
- **Editing can stay in WSL**; only the build + Sandbox test run on the Windows side.

## Sequencing (red -> green)

0. **Scaffold + harness first (establish the red):** add electron-builder NSIS config and the `.wsb` Sandbox harness; produce a first installer of the current app and run the Sandbox test. It will **fail** for the real reasons (no Python in Sandbox; Chromium not found). This baseline is the point of the test-first approach.
1. **Port the proxy to Node** (remove Python); re-run the Sandbox test.
2. **Bundle Chromium + fix the fallback subprocess launch**; re-run until the Sandbox test is **green** (including the Chromium self-check).

Recommendation: land this packaging skeleton and reach smoke-green **before** resuming feature work, so every later change stays continuously verifiable as installable.

## Risks & open questions

- **Playwright-in-packaged-Electron path resolution** is the most likely source of iteration; surfaced early by design (step 0/2).
- **SmartScreen** will warn on the unsigned installer; mitigation for now is coaching the 2-3 users through "More info -> Run anyway." A code-signing cert later removes this; config is structured for that.
- **Installer size** will be substantial (Electron + Chromium for UI + Playwright Chromium). Acceptable for this audience; note it.
- **Single canonical renderer:** ensure the package builds from `src/renderer` and the legacy root `*.jsx` files are not pulled in.

## Success criteria

- One double-clickable Windows installer, no prerequisites.
- The scripted Windows Sandbox smoke test passes checks #1-#4 on a fresh machine.
- No Python anywhere in the shipped app; no run-time downloads.
- electron-builder config is signing-ready (drop-in cert later).
