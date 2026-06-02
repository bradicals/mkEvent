# Copy Debug Report — Design

**Date:** 2026-06-01
**Status:** Approved (design)
**Author:** brad@cbo.io (with Claude)

## Problem

When a non-technical user hits a problem creating an event, there's no easy way
for them to send me the diagnostic detail I need. Today:

- The run modal's **"Copy summary"** button is `disabled` unless the run
  *succeeded* — i.e. it's unavailable in exactly the failure case where I need
  logs (`src/renderer/create-runner.jsx:207`).
- It copies only a 9-line summary (env, IDs, URLs, counts). It does **not**
  include the step-by-step transcript (`lines` state) or any backend detail.
- The backend (Python proxy + `node browser-fallback.cjs` subprocess) logs live
  in a terminal window the packaged app won't have, so the user can't reach the
  output that has actually solved the hard bugs (e.g. the donation navigation).

We want a one-click **"Copy debug report"** that bundles everything I need into a
single paste, available on success *and* failure — built now, before the Electron
migration, in a way that survives packaging.

## Key existing facts (verified)

- The proxy **already** writes a unified, redacted, JSON-lines log to
  `logs/mkEvent-proxy.log` via `_log_debug` (`proxy-server.py:70`). It captures
  proxy requests/responses (`proxy_request`/`proxy_response`), browser-fallback
  launches (`browser_fallback_launch`), **and the fallback subprocess
  stdout/stderr** (`browser_fallback_exit`, `proxy-server.py:188`) — that's the
  "terminal output" I've been pasted, already on disk with `Authorization`,
  `orgToken`, `token`, `adminPassword`, `password` stripped at write time
  (`SENSITIVE_KEYS`, `proxy-server.py:42`).
- So "both log streams" reduces to: **the renderer transcript (already in the
  `lines` React state) + the tail of one log file**.
- `browser_fallback_exit` currently trims fallback stdout/stderr to **2000 chars**
  (`_trim_text`, `proxy-server.py:191`) — that truncates the detailed Playwright
  step logs that are most useful for diagnosis.
- The proxy is bound to `127.0.0.1` and already sends permissive CORS headers, so
  a read-only GET endpoint is safe and reachable from the renderer.
- `config.api.proxyUrl` (`http://localhost:9999/proxy`) is available in the run
  modal, and `event-model.js` already exports a `proxyToolUrl(proxyUrl, suffix)`
  helper that strips `/proxy` and builds tool URLs (`event-model.js:1699,1804`).

## Approach

Approach A (chosen): expose the existing log file through a read-only proxy
endpoint and assemble a single report string in the renderer. Reuses everything
that already exists; both the file and the localhost endpoint survive Electron
packaging. (Rejected: a live streaming log panel — more surface area, and we need
*copyable*, not *live*.)

## Components

### 1. Proxy diagnostics endpoint (`proxy-server.py`)

- Add a `do_GET` handler to `ProxyHandler`.
- Route: `GET /debug/logs?lines=N`.
  - `N` defaults to `500`, clamped to a sane max (e.g. `5000`).
  - Reads `DEBUG_LOG_PATH`; returns the last `N` lines.
  - Response JSON: `{ "logPath": <str>, "returned": <int>, "lines": [<raw json-line str>, ...] }`.
    Lines are returned as raw strings (already-redacted JSON) — the renderer
    treats them as opaque text for the report; no re-parsing required.
  - If the file does not exist yet: `{ "logPath", "returned": 0, "lines": [] }`
    (200, not an error).
  - Any unknown GET path → 404 via the existing `_send_error` helper.
- CORS: reuse the existing header-emitting path used by `_send_json`.
- Security: read-only; localhost-bound; only ever reads `DEBUG_LOG_PATH`
  (no path parameter from the client, so no traversal surface).

### 2. Raise fallback log trim limit (`proxy-server.py`)

- Bump the `browser_fallback_exit` stdout/stderr trim from `2000` to `~20000`
  chars so the useful Playwright step detail survives. (Call `_trim_text(...,
  limit=20000)` at the two call sites in `_run_browser_fallback`.) The generic
  2000-char default stays for other call sites.

### 3. Report builder (renderer, pure function)

- A pure function `buildDebugReport({ config, recipe, result, error, lines, proxyLog, generatedAt })`
  returning one formatted string. Placed where it's unit-testable from
  `node --test` (e.g. a small `src/shared/debug-report.js` module imported by the
  run modal — keeps the modal thin and the logic testable).
- Output structure:
  ```
  mkEvent debug report
  Generated: <ISO ts>
  App version: <package.json version>
  Environment: <recipe.environment.id>  (baseUrl)
  Status: success | failed
  Event: <name> / keyword <slug> / id <eventId|—>
  Admin URL / Public URL
  Bidders: N   Items: M
  Error: <message>            (only when failed)
  Verification: OK | FAILED — <reason>

  === UI transcript (K lines) ===
  <ts> [kind/tag] msg
  ...

  === Proxy log (last N of total) ===
  <raw json line>
  ...
  ```
- **No secrets:** the header is built from `recipe`/`result` only — never from
  `config.api` token fields. Proxy lines are already redacted server-side.
- **Graceful degradation:** if `proxyLog` is null/empty (endpoint unreachable),
  emit a `=== Proxy log: UNAVAILABLE (<reason>) ===` section and still include
  the full UI transcript + header. The report is never empty.

### 4. Run modal wiring (`src/renderer/create-runner.jsx`)

- Add a **"Copy debug report"** button to the footer, **always enabled** (the
  whole point: it must work on failure). Keep the existing "Copy summary" button
  for the success path unchanged.
- On click:
  1. `fetch` the tail from `proxyToolUrl(config.api.proxyUrl, '/debug/logs?lines=500')`
     (short timeout; tolerate failure).
  2. Call `buildDebugReport(...)` with the live `lines`, `result`/`error`,
     `recipe`, and the fetched `proxyLog`.
  3. `navigator.clipboard.writeText(report)`; set button state to "Copied".
  4. On clipboard failure, fall back to the existing `window.alert` error path.
- Reuse the existing `copyState` pattern (or a parallel `reportCopyState`) for
  the "Copied"/"Copy debug report" label swap.

## Testing

- **`buildDebugReport` unit tests (`node --test`):**
  - includes every UI transcript line (ts/kind/tag/msg);
  - includes the proxy log lines when provided;
  - emits the UNAVAILABLE section (and still includes transcript) when
    `proxyLog` is null/empty;
  - header never contains token/password values even if accidentally present in
    `config` (function only reads `recipe`/`result`, so assert no `config.api`
    secret leaks into output);
  - failure case includes the `Error:` line.
- **Proxy endpoint:** a focused test that starts the handler (or calls the
  do_GET tail logic) and asserts `/debug/logs` returns the last N lines and a
  missing file yields an empty `lines` array with 200.
- **Manual:** `npm run build` succeeds; one live run — click "Copy debug report"
  on both a successful run and a forced failure; confirm pasted report contains
  transcript + proxy detail and no secrets.

## Out of scope (YAGNI)

- Live/streaming log viewer in the UI.
- App-wide debug capture outside the run modal (settings-load errors etc.).
- Log download-to-file / attachment UX (copy-paste is the request).
- Log rotation/retention changes for `mkEvent-proxy.log`.
