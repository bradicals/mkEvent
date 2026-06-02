# Copy Debug Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a one-click "Copy debug report" in the run modal that bundles the UI transcript + the proxy's redacted log tail into a single paste, available on success *and* failure.

**Architecture:** The Python proxy already writes a unified, redacted JSON-lines log to `logs/mkEvent-proxy.log` (including the browser-fallback subprocess stdout/stderr). We expose its tail through a read-only `GET /debug/logs` endpoint, build the report string in a pure renderer module, and wire an always-enabled button in the run modal.

**Tech Stack:** Python stdlib `http.server` (proxy), React (renderer), UMD-style JS module + `src/shared` ESM shim (matching `event-model.js`), `node --test` for JS tests, stdlib `unittest` for the Python tail helper.

---

## File Structure

- **`proxy-server.py`** (modify) — add a module-level `tail_lines(path, n)` pure helper; add a `do_GET` handler routing `GET /debug/logs?lines=N`; allow `GET` in CORS; raise the browser-fallback stdout/stderr trim limit.
- **`proxy_server_test.py`** (create) — stdlib `unittest` for `tail_lines` (run manually via `python3`; the repo has no Python CI).
- **`debug-report.js`** (create, repo root) — UMD module exporting `buildDebugReport(...)`, mirroring `event-model.js`'s factory pattern so it's `require`-able in tests and global in the browser.
- **`src/shared/debug-report.js`** (create) — ESM shim re-exporting `globalThis.DebugReport`, mirroring `src/shared/event-model.js`.
- **`debug-report.test.js`** (create, repo root) — `node --test` unit tests for `buildDebugReport`.
- **`src/renderer/create-runner.jsx`** (modify) — fetch the proxy tail and add the always-enabled "Copy debug report" button.

---

## Task 1: Proxy `tail_lines` helper (TDD)

**Files:**
- Create: `proxy_server_test.py`
- Modify: `proxy-server.py` (add `tail_lines` near the other module-level helpers, after `_log_debug` ~line 79)

- [ ] **Step 1: Write the failing test**

Create `proxy_server_test.py`:

```python
import os
import tempfile
import unittest

import importlib.util

# Load proxy-server.py (hyphenated filename) as a module.
_spec = importlib.util.spec_from_file_location(
    "proxy_server", os.path.join(os.path.dirname(__file__), "proxy-server.py")
)
proxy_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proxy_server)


class TailLinesTest(unittest.TestCase):
    def _write(self, text):
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        self.addCleanup(os.remove, path)
        return path

    def test_returns_last_n_lines(self):
        path = self._write("a\nb\nc\nd\ne\n")
        self.assertEqual(proxy_server.tail_lines(path, 2), ["d", "e"])

    def test_returns_all_when_n_exceeds_count(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 10), ["a", "b"])

    def test_missing_file_returns_empty(self):
        self.assertEqual(proxy_server.tail_lines("/no/such/file.log", 5), [])

    def test_ignores_trailing_blank_line_only(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 5), ["a", "b"])

    def test_zero_or_negative_returns_empty(self):
        path = self._write("a\nb\n")
        self.assertEqual(proxy_server.tail_lines(path, 0), [])
        self.assertEqual(proxy_server.tail_lines(path, -3), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest proxy_server_test -v`
Expected: FAIL with `AttributeError: module 'proxy_server' has no attribute 'tail_lines'`.

- [ ] **Step 3: Write minimal implementation**

In `proxy-server.py`, immediately after the `_log_debug` function (after line 79), add:

```python
def tail_lines(path, n):
    """Return the last n non-trailing-blank lines of a UTF-8 text file.

    Missing file or n <= 0 yields an empty list. Lines are returned without
    their trailing newline. Reads the whole file (the proxy log stays small);
    callers clamp n upstream.
    """
    if n <= 0:
        return []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return []
    lines = raw.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines[-n:]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest proxy_server_test -v`
Expected: PASS (5 tests OK).

- [ ] **Step 5: Commit**

```bash
git add proxy-server.py proxy_server_test.py
git commit -m "Add tail_lines helper for proxy debug log"
```

---

## Task 2: Proxy `GET /debug/logs` endpoint

**Files:**
- Modify: `proxy-server.py` — add `do_GET` to `ProxyHandler` (after `do_OPTIONS` ~line 209); update `_cors_headers` (~line 387) to allow GET.

- [ ] **Step 1: Add the `do_GET` handler**

In `proxy-server.py`, inside `class ProxyHandler`, immediately after the `do_OPTIONS` method (after line 209), add:

```python
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/debug/logs":
            self._send_json_error(404, "Only GET /debug/logs is supported")
            return

        params = parse_qs(parsed.query)
        try:
            requested = int(params.get("lines", ["500"])[0])
        except (TypeError, ValueError):
            requested = 500
        count = max(0, min(requested, 5000))

        lines = tail_lines(DEBUG_LOG_PATH, count)
        self._send_json(200, {
            "logPath": DEBUG_LOG_PATH,
            "returned": len(lines),
            "lines": lines,
        })
```

- [ ] **Step 2: Ensure `parse_qs` is imported**

Run: `grep -n "from urllib.parse import" proxy-server.py`
Expected: a line importing `urlparse` (and others). Confirm `parse_qs` is present in that import; if not, add it.

Edit the existing `from urllib.parse import ...` line to include `parse_qs` and `urlparse` (keep existing names). Example final form:

```python
from urllib.parse import urljoin, urlparse, parse_qs
```

(Keep whatever names are already imported; only add the missing ones.)

- [ ] **Step 3: Allow GET in CORS**

In `proxy-server.py`, change `_cors_headers` (~line 389):

```python
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
```

- [ ] **Step 4: Syntax check**

Run: `python3 -c "import ast; ast.parse(open('proxy-server.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 5: Manual smoke test**

Run in one terminal: `python3 proxy-server.py`
In another:
```bash
curl -s "http://127.0.0.1:9999/debug/logs?lines=5"
curl -s "http://127.0.0.1:9999/debug/logs" -o /dev/null -w "%{http_code}\n"
curl -s "http://127.0.0.1:9999/debug/bogus" -o /dev/null -w "%{http_code}\n"
```
Expected: first prints JSON `{"logPath":...,"returned":N,"lines":[...]}` (lines may be `[]` on a fresh log); second prints `200`; third prints `404`. Stop the server (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add proxy-server.py
git commit -m "Serve redacted proxy log tail via GET /debug/logs"
```

---

## Task 3: Raise browser-fallback log trim limit

**Files:**
- Modify: `proxy-server.py` — the two `_trim_text(proc...)` calls in `browser_fallback_exit` (lines 191-192).

- [ ] **Step 1: Bump the trim limit**

In `proxy-server.py`, change the two lines inside the `browser_fallback_exit` `_log_debug` call (currently lines 191-192):

```python
        stdout=_trim_text(proc.stdout or "", limit=20000),
        stderr=_trim_text(proc.stderr or "", limit=20000),
```

(Leave the default `limit=2000` on `_trim_text` and all other call sites unchanged — only these two fallback-exit calls get the higher limit.)

- [ ] **Step 2: Syntax check**

Run: `python3 -c "import ast; ast.parse(open('proxy-server.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add proxy-server.py
git commit -m "Keep more browser-fallback output in the debug log (2k -> 20k)"
```

---

## Task 4: `buildDebugReport` pure module (TDD)

**Files:**
- Create: `debug-report.js` (repo root)
- Create: `src/shared/debug-report.js`
- Test: `debug-report.test.js` (repo root)

- [ ] **Step 1: Write the failing test**

Create `debug-report.test.js`:

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDebugReport } = require('./debug-report.js');

function baseArgs(overrides = {}) {
  return {
    appVersion: '1.0.0',
    generatedAt: '2026-06-01T12:00:00.000Z',
    recipe: {
      environment: { id: 'cbo', baseUrl: 'https://cbo.bid' },
      event: { name: 'Twilight Gala', slug: 'twilightgala' },
      bidders: { count: 10 },
      items: { count: 5 },
    },
    result: {
      eventId: '4242',
      adminUrl: 'https://cbo.bid/events/twilightgala',
      publicUrl: 'https://cbo.bid/app/public/bidapp/twilightgala',
      verification: null,
    },
    error: '',
    lines: [
      { ts: '12:00:01', kind: 'info', tag: 'event', msg: 'Creating event' },
      { ts: '12:00:02', kind: 'ok', tag: 'event', msg: 'Event created' },
    ],
    proxyLog: { returned: 2, lines: ['{"event":"proxy_start"}', '{"event":"proxy_response"}'] },
    ...overrides,
  };
}

test('includes header fields and every transcript line', () => {
  const report = buildDebugReport(baseArgs());
  assert.match(report, /App version: 1\.0\.0/);
  assert.match(report, /Environment: cbo/);
  assert.match(report, /Event: Twilight Gala/);
  assert.match(report, /keyword twilightgala/);
  assert.match(report, /Status: success/);
  assert.match(report, /12:00:01 \[info\/event\] Creating event/);
  assert.match(report, /12:00:02 \[ok\/event\] Event created/);
});

test('includes proxy log lines', () => {
  const report = buildDebugReport(baseArgs());
  assert.match(report, /=== Proxy log/);
  assert.match(report, /"event":"proxy_start"/);
  assert.match(report, /"event":"proxy_response"/);
});

test('failure status includes the error line', () => {
  const report = buildDebugReport(baseArgs({
    error: 'keyword already in use',
    result: null,
  }));
  assert.match(report, /Status: failed/);
  assert.match(report, /Error: keyword already in use/);
});

test('marks proxy log UNAVAILABLE but still includes transcript', () => {
  const report = buildDebugReport(baseArgs({ proxyLog: null }));
  assert.match(report, /=== Proxy log: UNAVAILABLE/);
  assert.match(report, /12:00:01 \[info\/event\] Creating event/);
});

test('never leaks config secrets (function ignores config entirely)', () => {
  const report = buildDebugReport(baseArgs());
  assert.doesNotMatch(report, /orgToken|adminPassword|Authorization/i);
});

test('reports verification failure reason', () => {
  const report = buildDebugReport(baseArgs({
    result: { eventId: '1', adminUrl: 'a', publicUrl: 'b', verification: { error: 'count mismatch' } },
  }));
  assert.match(report, /Verification: FAILED — count mismatch/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test debug-report.test.js`
Expected: FAIL — `Cannot find module './debug-report.js'`.

- [ ] **Step 3: Write the module**

Create `debug-report.js` (UMD pattern matching `event-model.js`):

```javascript
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DebugReport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function buildDebugReport({ appVersion, generatedAt, recipe, result, error, lines, proxyLog }) {
    const failed = Boolean(error);
    const env = recipe?.environment || {};
    const event = recipe?.event || {};
    const verificationError = result?.verification?.error || '';

    const header = [
      'mkEvent debug report',
      `Generated: ${generatedAt || '(unknown)'}`,
      `App version: ${appVersion || '(unknown)'}`,
      `Environment: ${env.id || '(unknown)'} (${env.baseUrl || 'n/a'})`,
      `Status: ${failed ? 'failed' : 'success'}`,
      `Event: ${event.name || 'Untitled event'} / keyword ${event.slug || '(none)'} / id ${result?.eventId || '—'}`,
      `Admin URL: ${result?.adminUrl || '(unavailable)'}`,
      `Public URL: ${result?.publicUrl || '(unavailable)'}`,
      `Bidders: ${recipe?.bidders?.count ?? '?'}   Items: ${recipe?.items?.count ?? '?'}`,
    ];
    if (failed) header.push(`Error: ${error}`);
    header.push(`Verification: ${verificationError ? `FAILED — ${verificationError}` : 'OK'}`);

    const transcriptLines = Array.isArray(lines) ? lines : [];
    const transcript = [
      '',
      `=== UI transcript (${transcriptLines.length} lines) ===`,
      ...transcriptLines.map(l => `${l.ts || '--:--:--'} [${l.kind || 'info'}/${l.tag || ''}] ${l.msg || ''}`),
    ];

    let proxySection;
    if (proxyLog && Array.isArray(proxyLog.lines) && proxyLog.lines.length) {
      proxySection = [
        '',
        `=== Proxy log (last ${proxyLog.lines.length}) ===`,
        ...proxyLog.lines,
      ];
    } else if (proxyLog && Array.isArray(proxyLog.lines)) {
      proxySection = ['', '=== Proxy log: empty (no entries yet) ==='];
    } else {
      const reason = (proxyLog && proxyLog.error) || 'proxy unreachable';
      proxySection = ['', `=== Proxy log: UNAVAILABLE (${reason}) ===`];
    }

    return [...header, ...transcript, ...proxySection].join('\n');
  }

  return { buildDebugReport };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test debug-report.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Create the ESM shim**

Create `src/shared/debug-report.js`:

```javascript
import '../../debug-report.js';

const DebugReport = globalThis.DebugReport;

if (!DebugReport) {
  throw new Error('DebugReport failed to initialize from legacy module.');
}

export default DebugReport;
```

- [ ] **Step 6: Commit**

```bash
git add debug-report.js src/shared/debug-report.js debug-report.test.js
git commit -m "Add buildDebugReport: assemble UI transcript + proxy log into one report"
```

---

## Task 5: Wire "Copy debug report" into the run modal

**Files:**
- Modify: `src/renderer/create-runner.jsx`

- [ ] **Step 1: Import the report builder and model**

At the top of `src/renderer/create-runner.jsx`, after the existing `import CreationEngine ...` line (line 5), add:

```javascript
import EventModel from '../shared/event-model.js';
import DebugReport from '../shared/debug-report.js';
```

- [ ] **Step 2: Add report-copy state**

In `RunModal`, next to the existing `const [copyState, setCopyState] = useState('idle');` (line 13), add:

```javascript
  const [reportState, setReportState] = useState('idle');
```

- [ ] **Step 3: Add the fetch-and-copy handler**

In `RunModal`, after the existing `copySummary` function (after line 120), add:

```javascript
  const copyDebugReport = async () => {
    let proxyLog = null;
    try {
      const url = EventModel.proxyToolUrl(config.api.proxyUrl, '/debug/logs?lines=500');
      const resp = await fetch(url, { method: 'GET' });
      if (resp.ok) {
        proxyLog = await resp.json();
      } else {
        proxyLog = { error: `proxy returned ${resp.status}` };
      }
    } catch (fetchError) {
      proxyLog = { error: fetchError?.message || 'proxy unreachable' };
    }

    const report = DebugReport.buildDebugReport({
      appVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      recipe,
      result,
      error,
      lines,
      proxyLog,
    });

    try {
      if (!navigator?.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(report);
      setReportState('copied');
    } catch (copyError) {
      setReportState('failed');
      window.alert(`Could not copy debug report: ${copyError.message}`);
    }
  };
```

- [ ] **Step 4: Add the always-enabled button to the footer**

In `src/renderer/create-runner.jsx`, in the `run-foot` block (lines 200-212), add a "Copy debug report" button. Replace the footer's button area so it appears in both the running and finished states. Change the footer (lines 202-211) to:

```javascript
          {isRunning ? (
            <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-outline" onClick={copyDebugReport} title="Copy a full debug report (UI log + proxy log) to send for troubleshooting">
                <i className="fa-solid fa-bug"></i> {reportState === 'copied' ? 'Copied' : 'Copy debug report'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-outline" onClick={copyDebugReport} title="Copy a full debug report (UI log + proxy log) to send for troubleshooting">
                <i className="fa-solid fa-bug"></i> {reportState === 'copied' ? 'Copied' : 'Copy debug report'}
              </button>
              <button className="btn btn-primary" onClick={copySummary} disabled={!isSuccess} title={isSuccess ? 'Copy created event summary' : 'Copy is only available after a successful create'}>
                <i className="fa-regular fa-copy"></i> {copyState === 'copied' ? 'Copied' : 'Copy summary'}
              </button>
            </>
          )}
```

- [ ] **Step 5: Reset report state on (re)run**

In the `run` async function's reset block (lines 33-38, where `setCopyState('idle')` is called), add right after `setCopyState('idle');`:

```javascript
      setReportState('idle');
```

- [ ] **Step 6: Build to verify the renderer compiles**

Run: `npm run build`
Expected: Vite build completes with no errors; `dist/` updated.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/create-runner.jsx
git commit -m "Add always-enabled Copy debug report button to run modal"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the JS test suite**

Run: `npm test`
Expected: all tests pass (existing + the new `debug-report.test.js`).

- [ ] **Step 2: Run the Python tail test**

Run: `python3 -m unittest proxy_server_test -v`
Expected: 5 tests OK.

- [ ] **Step 3: Manual end-to-end (requires proxy + dev server)**

Start the proxy (`python3 proxy-server.py`) and the app (`npm run dev`). Create an event. While the run modal is open and after it finishes, click **"Copy debug report"** and paste into a scratch file. Confirm the paste contains:
- the header (env, event, status),
- the `=== UI transcript ===` lines,
- the `=== Proxy log (last N) ===` lines,
- no `orgToken` / `adminPassword` / `Authorization` values.

Then stop the proxy and click "Copy debug report" again; confirm the report still pastes with `=== Proxy log: UNAVAILABLE ===` and the full transcript.

- [ ] **Step 4: Final commit (if any manual-test tweaks were needed)**

```bash
git add -A
git commit -m "Copy debug report: manual verification fixes"
```

(Skip if no changes.)

---

## Notes / Decisions

- **Why a UMD module for `buildDebugReport`:** mirrors `event-model.js` so the same file is `require`-able from `node --test` (CommonJS) and importable in the Vite renderer via the `src/shared` ESM shim. No build-tool gymnastics.
- **App version is hard-coded `'1.0.0'`** to match `package.json`. When Electron packaging lands, this should be replaced by an injected version constant — out of scope here, noted for the migration.
- **Secrets:** `buildDebugReport` deliberately never reads `config`; the proxy redacts at write time. The test asserts no secret strings appear.
- **Tail reads the whole file:** acceptable because the proxy log stays small per session; revisit only if logs grow large (would add log rotation, out of scope).
